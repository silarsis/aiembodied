/**
 * Echo's link to the shared model controller (aicontroller, http://127.0.0.1:8200 by default).
 *
 * The controller owns the GPU servers: echo-llm (:1234), coder-llm (:1236), vision (:1237), motion
 * (:8190) and comfyui (:8188). With it in use this app holds an `interactive` lease on echo-llm
 * instead of starting llama-server itself, uses the lease's URL for chat, and gives the lease back
 * on quit, hibernate and suspend. If the controller revokes the lease (a game needs the GPU, or the
 * coder evicts Echo's model), the next turn leases again. A coding task leases coder-llm in place
 * of echo-llm (see coding/model-swap.ts).
 *
 * Motion is leased the same way while the app runs and motion is enabled. ComfyUI and the vision
 * model are leased per use ({@link AicontrollerBridge.acquire}) and given back after a quiet spell
 * (60 s), so jobs that follow each other share a lease. A backend the controller doesn't have is
 * logged once and the app runs its own server for it, as without the controller.
 *
 * AICONTROLLER_ENABLED: `auto` (default) uses the controller if it answers and otherwise leaves
 * everything as it was; `1` requires it (turns fail with a message while it is down); `0` never
 * uses it. This app never starts the controller: on bija it runs from the tray.
 */
import path from 'node:path';
import {
  Controller,
  ControllerError,
  type DownloadOptions,
  type DownloadSource,
  type Lease,
} from './client.js';
import {
  BUILT_IN_SERVER_IDS,
  routeTargets,
  type ModelRouting,
  type RouteOverride,
} from '../shared/config/model-routing.js';

/** A model file on one machine, as GET /v1/models?scope=all lists it. */
export interface ControllerModelEntry {
  kind: string;
  /** ComfyUI kinds (checkpoints, loras…) are listed as kind `comfyui` with a subfolder. */
  subfolder: string | null;
  fileName: string;
  sizeBytes: number | null;
  /** The machine's name. */
  host: string;
  /** installed, loaded, offline, busy or ask-first. */
  state: string;
}

/** A download the controller runs (POST /v1/models/download, GET /v1/downloads/{id}). */
export interface ControllerDownloadJob {
  id: string;
  /** queued, downloading, verifying, done, failed or cancelled. */
  state: string;
  bytesDone: number;
  bytesTotal: number | null;
  error: string | null;
  host: string | null;
  fileName: string | null;
}

function toDownloadJob(job: Record<string, unknown>): ControllerDownloadJob {
  return {
    id: String(job.id ?? ''),
    state: typeof job.state === 'string' ? job.state : 'queued',
    bytesDone: typeof job.bytes_done === 'number' ? job.bytes_done : 0,
    bytesTotal: typeof job.bytes_total === 'number' ? job.bytes_total : null,
    error: typeof job.error === 'string' ? job.error : null,
    host: typeof job.host === 'string' ? job.host : null,
    fileName: typeof job.file_name === 'string' ? job.file_name : null,
  };
}

export type ControllerMode = 'auto' | 'required' | 'off';

/** `1`/`true`/`on`/`yes` require the controller, `0`/`false`/`off`/`no` never use it, anything else (or nothing) is auto. */
export function parseControllerMode(value: string | undefined): ControllerMode {
  const text = (value ?? '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'required'].includes(text)) return 'required';
  if (['0', 'false', 'off', 'no'].includes(text)) return 'off';
  return 'auto';
}

export const DEFAULT_CONTROLLER_URL = 'http://127.0.0.1:8200';
export const ECHO_BACKEND = 'echo-llm';
export const CODER_BACKEND = 'coder-llm';
export const MOTION_BACKEND = 'motion';
export const COMFY_BACKEND = 'comfyui';
export const VISION_BACKEND = 'vision';
/** The backends leased per use and given back after a quiet spell. */
export type SharedBackend = typeof COMFY_BACKEND | typeof VISION_BACKEND;
/** How long a per-use lease is kept after its last use. */
export const SHARED_IDLE_MS = 60_000;
const CLIENT_NAME = 'aiembodied';

export type EchoLeaseState =
  'direct' | 'leasing' | 'leased' | 'paused' | 'coder' | 'released' | 'error';

/** `idle`: leased per use and not held now. `own`: the controller doesn't have it, the app runs its own server. */
export type LeaseSummaryState = 'leased' | 'idle' | 'paused' | 'leasing' | 'own';

export interface LeaseSummary {
  backend: string;
  state: LeaseSummaryState;
}

export interface ControllerStatus {
  mode: ControllerMode;
  /** The controller is what runs the models; the app starts and stops no llama-server. */
  inUse: boolean;
  url: string;
  echo: EchoLeaseState;
  /** Every backend the app leases (echo-llm or coder-llm, motion when enabled, comfyui and vision per use). */
  leases: LeaseSummary[];
  /** One line for the status panel. */
  line: string;
}

/** A per-use lease in use. `done()` says the use is over (safe to call twice); the lease is kept for a while for the next one. */
export interface SharedHandle {
  url: string | null;
  /** The machine that runs it, when the controller routed the lease away from this PC. */
  host?: string | null;
  done(): void;
}

/** What ComfyUI's pool and the vision server need from the controller. */
export interface SharedLeases {
  inUse(): boolean;
  /** True when the controller's status lists this backend; a lease for it then picks the machine. */
  listsBackend?(backend: string): boolean;
  /**
   * Leases a backend for one use. Resolves null when the controller isn't in use or doesn't know the
   * backend (logged once): the caller then runs its own server. Rejects with the reason when the
   * lease can't be had (the GPU is needed by a game, the controller is required but down).
   */
  acquire(backend: SharedBackend, options?: SharedAcquireOptions): Promise<SharedHandle | null>;
}

export interface SharedAcquireOptions {
  /** Model file names the job loads: the controller may route the lease to a machine that has them. */
  needs?: string[];
}

/** The Thinking model picked for Echo: a GGUF file the controller must know. */
export interface EchoModelPick {
  path: string;
  alias: string;
}

/** A lease Echo's model picker wanted could not be made because the controller doesn't have the model. */
export class ControllerModelMissing extends Error {
  constructor(alias: string) {
    super(
      `The model controller doesn't have ${alias}; add its folder to the controller's model_store.`,
    );
    this.name = 'ControllerModelMissing';
  }
}

type Logger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

/** What the coder swap needs from the controller. */
export interface CoderLeases {
  inUse(): boolean;
  /** Gives Echo's lease up (a leased backend is never evicted), then leases coder-llm; resolves with its URL once it is ready. */
  leaseCoder(): Promise<{ url: string | null }>;
  /** True when the controller took the coder lease back (or it expired). */
  coderLost(): boolean;
  /** Gives the coder lease up. Safe to call when none is held. */
  releaseCoder(): Promise<void>;
  /** Gives Echo's lease up so the coder can be leased. */
  releaseEcho(): Promise<void>;
  /** Leases echo-llm again; resolves once it is ready. */
  leaseEcho(): Promise<void>;
}

export interface AicontrollerBridgeOptions {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** Called when the URL Echo chats on may have changed, so the voice engines are rebuilt. */
  onChange?: () => void | Promise<void>;
  /** How long to wait for a lease to become ready (the model may need loading). Default 900 s. */
  leaseWaitS?: number;
  /** How often to look for a revoked lease. Default 5 s; 0 turns the timer off (tests call check()). */
  watchMs?: number;
  /** How long ComfyUI's and the vision model's leases are kept after their last use. Default 60 s. */
  sharedIdleMs?: number;
  /** How long to wait before check() tries again to lease echo-llm that a per-use lease made it give back. Default 10 s. */
  echoRetryMs?: number;
  /**
   * The Thinking model picked in the app, asked for when Echo's lease is made. `undefined`: not
   * known yet (asked again next time); `null`: none picked, so the controller's default model.
   */
  echoModel?: () => Promise<EchoModelPick | null | undefined>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The controller answered 404: it doesn't know the backend (or, for a model, the model). */
function isNotFound(error: unknown): boolean {
  return error instanceof ControllerError && error.status === 404;
}

/** A backend leased per use. */
interface SharedState {
  backend: SharedBackend;
  needs: string[];
  /** Echo's lease was given back for this one (it runs on this PC). */
  yielding: boolean;
  lease: Lease | null;
  pending: Promise<void> | null;
  /** Uses between acquire() and done(). */
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A motion lease not ready after this long is described as waiting for memory. */
const MOTION_WAITING_MS = 10_000;

const normalPath = (value: string) => value.replace(/\\/g, '/').toLowerCase();

export class AicontrollerBridge implements CoderLeases, SharedLeases {
  readonly mode: ControllerMode;
  readonly url: string;
  private readonly controller: Controller;
  private readonly logger: Logger;
  private readonly options: AicontrollerBridgeOptions;
  private readonly onChange?: () => void | Promise<void>;
  private readonly leaseWaitS: number;
  private readonly watchMs: number;
  private readonly sharedIdleMs: number;
  private readonly echoRetryMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private used = false;
  private starting: Promise<void> | null = null;
  /** The app is running and awake, so Echo should hold a lease. */
  private want = false;
  private echoLease: Lease | null = null;
  private echoPending: Promise<void> | null = null;
  private coderLease: Lease | null = null;
  /** A coder lease is being asked for or held: Echo's lease must not be asked for meanwhile. */
  private coderBusy = false;
  private paused: string | null = null;
  private failure: string | null = null;
  /** The model picked for Echo, and its id in the controller's catalog (null: the controller's default). */
  private echoPick: EchoModelPick | null = null;
  private echoModelId: string | null = null;
  private echoPickKnown = false;
  /** Backends leased per use hold Echo's lease back (the controller never evicts a leased backend) while they work. */
  /** Keys of the per-use leases that run on this PC and so hold the GPU Echo's model would use. */
  private readonly echoYield = new Set<string>();
  /** This controller's own machine name (GET /health). */
  private localName: string | null = null;
  /**
   * Echo's lease was given back for a per-use lease and has not been leased again yet. check() keeps
   * asking until it is (or Echo is no longer wanted), so one failed hand-back (the controller busy
   * or briefly unreachable) doesn't leave echo-llm loaded with nobody holding it until the next turn.
   */
  private echoOwed = false;
  private echoRetryAt = 0;
  private readonly shared = new Map<string, SharedState>();
  /** Motion is enabled in Models and servers and is this PC's own. */
  private motionWanted = false;
  private motionLease: Lease | null = null;
  private motionPending: Promise<void> | null = null;
  /** When the motion lease request began (ms), to say it is waiting when it takes long. */
  private motionAskedAt = 0;
  /** Aborts lease requests still waiting at the controller (queued for memory) when the app sleeps or quits. */
  private abort = new AbortController();
  private motionPaused: string | null = null;
  /** Motion's lease failed to come back after a wake: ask again every echoRetryMs until it does. */
  private motionOwed = false;
  private motionFailure: string | null = null;
  /** Backends the controller answered 404 for: the app runs its own server for them. */
  private readonly unknownBackends = new Set<string>();
  /** The controller's backend ids (GET /v1/status), or null when they could not be read. */
  private backendIds: Set<string> | null = null;

  constructor(options: AicontrollerBridgeOptions) {
    const env = options.env ?? process.env;
    this.options = options;
    this.logger = options.logger;
    this.onChange = options.onChange;
    this.leaseWaitS = options.leaseWaitS ?? 900;
    this.sharedIdleMs = options.sharedIdleMs ?? SHARED_IDLE_MS;
    this.echoRetryMs = options.echoRetryMs ?? 10_000;
    this.mode = parseControllerMode(env.AICONTROLLER_ENABLED);
    this.url = (env.AICONTROLLER_URL?.trim() || DEFAULT_CONTROLLER_URL).replace(/\/+$/, '');
    // Never autostart: the controller is the tray's business.
    this.controller = new Controller({
      url: this.url,
      client: CLIENT_NAME,
      autostart: false,
      fetch: options.fetchFn,
      token: env.AICONTROLLER_TOKEN,
    });
    this.watchMs = options.watchMs ?? 5000;
  }

  /** True when the controller runs the models. Only known after start(). */
  inUse(): boolean {
    return this.used;
  }

  /**
   * True when the controller runs this backend: in use, it lists the backend (or its list could not
   * be read) and has not answered 404 for it. The app then starts and stops no server of its own for it.
   */
  listsBackend(backend: string): boolean {
    return (
      this.used && !this.unknownBackends.has(backend) && this.backendIds?.has(backend) === true
    );
  }

  managesBackend(backend: string): boolean {
    return (
      this.used &&
      !this.unknownBackends.has(backend) &&
      (this.backendIds ? this.backendIds.has(backend) : true)
    );
  }

  /** Looks for the controller and, if it is used, asks for Echo's lease in the background (the model may be loading). */
  start(): Promise<void> {
    this.starting ??= this.doStart();
    return this.starting;
  }

  private async detect(): Promise<void> {
    if (this.mode === 'off') {
      this.used = false;
      return;
    }
    try {
      const health = await this.controller.health();
      this.localName = health?.name ?? null;
      this.used = true;
      await this.readBackends();
    } catch (error) {
      // Required: stay "in use" so no llama-server is started behind the controller's back, and turns say why they fail.
      this.used = this.mode === 'required';
      this.failure =
        this.mode === 'required'
          ? `the model controller is required (AICONTROLLER_ENABLED=1) but does not answer at ${this.url}`
          : null;
      this.logger.info(
        this.mode === 'required'
          ? 'Model controller required but not answering.'
          : 'Model controller not answering; using local servers directly.',
        {
          url: this.url,
          message: messageOf(error),
        },
      );
    }
  }

  /** Which backends the controller has; failing that, every lease is tried and a 404 means "not here". */
  private async readBackends(): Promise<void> {
    try {
      const status = await this.controller.request<{ backends?: { id?: unknown }[] }>(
        'GET',
        '/v1/status',
        { timeoutMs: 5000 },
      );
      const ids = (status.backends ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string');
      this.backendIds = ids.length > 0 ? new Set(ids) : null;
      for (const backend of [MOTION_BACKEND, COMFY_BACKEND, VISION_BACKEND]) {
        if (this.backendIds && !this.backendIds.has(backend)) this.noteUnknown(backend);
      }
    } catch (error) {
      this.backendIds = null;
      this.logger.warn('Could not read the model controller’s backends.', {
        message: messageOf(error),
      });
    }
  }

  /** Logs once that the controller lacks a backend, so the app runs its own server for it. */
  private noteUnknown(backend: string): void {
    if (this.unknownBackends.has(backend)) return;
    this.unknownBackends.add(backend);
    this.logger.warn(
      `The model controller has no ${backend} backend; the app runs its own server for it.`,
      { url: this.url },
    );
  }

  private async doStart(): Promise<void> {
    await this.detect();
    this.want = true;
    if (this.watchMs > 0 && this.mode !== 'off' && !this.timer) {
      this.timer = setInterval(() => this.check(), this.watchMs);
      this.timer.unref?.();
    }
    if (this.used) {
      this.logger.info('Using aicontroller.', { url: this.url, mode: this.mode });
      void this.leaseEcho().catch((error) =>
        this.logger.warn('Could not lease echo-llm yet.', { message: messageOf(error) }),
      );
      void this.leaseMotion().catch((error) =>
        this.logger.warn('Could not lease motion yet.', { message: messageOf(error) }),
      );
    }
  }

  /** True while the controller runs Echo's model but Echo has no lease yet (the model is still loading). */
  echoWaiting(): boolean {
    return (
      this.used && this.want && !this.coderBusy && this.echoYield.size === 0 && !this.echoLease
    );
  }

  /** The base URL of Echo's lease, or null without one. */
  echoUrl(): string | null {
    return this.echoLease?.url ?? null;
  }

  /** Spots a lease the controller took back, and says so. */
  check(): void {
    const lease = this.echoLease;
    if (lease && (lease.revoked || lease.lost)) {
      const reason = lease.data.error || lease.revoked?.message || 'the lease ended';
      this.echoLease = null;
      this.paused = `Local LLM paused by the model controller (${reason})`;
      this.logger.warn(this.paused);
      // A lease the controller forgot (it restarted) is asked for again; a revoke (e.g. a game) waits for the next turn.
      if (lease.lost && !lease.revoked) this.echoOwed = true;
      void Promise.resolve(this.onChange?.()).catch(() => undefined);
    }
    const motion = this.motionLease;
    if (motion && (motion.revoked || motion.lost)) {
      const reason = motion.data.error || motion.revoked?.message || 'the lease ended';
      this.motionLease = null;
      this.motionPaused = `Motion paused by the model controller (${reason})`;
      this.logger.warn(this.motionPaused);
      void Promise.resolve(this.onChange?.()).catch(() => undefined);
    }
    // A per-use lease the controller took back while nothing used it is simply let go.
    for (const state of this.shared.values()) {
      const lease = state.lease;
      if (lease && state.users === 0 && (lease.revoked || lease.lost))
        void this.releaseShared(state);
    }
    this.retryEchoOwed();
    this.retryMotionOwed();
  }

  /** After a wake the controller may still say it is going to sleep: keep asking for motion until it comes back. */
  private retryMotionOwed(): void {
    if (!this.motionOwed) return;
    if (this.motionLease || !this.used || !this.want || !this.motionWanted) {
      this.motionOwed = !this.motionLease && this.want && this.motionWanted && this.used;
      return;
    }
    if (this.motionPending || Date.now() < this.motionAskedAt + this.echoRetryMs) return;
    if (this.controller.available === false) this.controller.available = null;
    void this.leaseMotion().catch((error) =>
      this.logger.warn('Could not lease motion again after waking.', { message: messageOf(error) }),
    );
  }

  /** The backends whose leases hold this PC's GPU, for messages. */
  private yieldNames(): string {
    return [...new Set([...this.echoYield].map((key) => key.split('|')[0]))].join(' and ');
  }

  /** Why Echo's lease can't be asked for now, or null when it can. */
  private echoBlocker(): string | null {
    if (!this.used) return 'the controller is not in use';
    if (!this.want) return 'the app is asleep or quitting';
    if (this.coderBusy) return 'a coding task holds the GPU';
    if (this.echoYield.size > 0) return `${this.yieldNames()} holds the GPU`;
    return null;
  }

  /** Echo's lease was given back and nothing has leased it again: ask again, at most every echoRetryMs. */
  private retryEchoOwed(): void {
    if (!this.echoOwed) return;
    if (this.echoLease && !this.echoLease.revoked && !this.echoLease.lost) {
      this.echoOwed = false;
      return;
    }
    if (this.echoPending || this.echoBlocker() !== null) return;
    for (const state of this.shared.values())
      if (state.lease || state.pending || state.users > 0) return;
    if (Date.now() < this.echoRetryAt) return;
    this.echoRetryAt = Date.now() + this.echoRetryMs;
    // A health probe the controller missed makes the client refuse leases for a minute; look again now.
    if (this.controller.available === false) this.controller.available = null;
    this.logger.info(
      'Leasing echo-llm again: it was given back for another backend and not leased since.',
    );
    void this.leaseEcho().catch((error) =>
      this.logger.warn('Could not lease echo-llm again.', { message: messageOf(error) }),
    );
  }

  /** Before a turn: makes sure Echo holds a lease again after a revoke. Throws the reason if it can't. */
  async ensureEcho(): Promise<void> {
    await this.starting;
    if (!this.used || !this.want || this.coderBusy) return;
    this.check();
    if (this.echoLease) return;
    if (this.echoYield.size > 0) {
      // ComfyUI or the vision model has the GPU. Echo's model may still be loaded: ask without waiting for it to load.
      try {
        await this.ensureEchoLease(3);
      } catch {
        throw new Error(
          `Echo's model is unloaded while ${this.yieldNames()} uses the GPU. Try again when it has finished (about a minute after the last job).`,
        );
      }
      return;
    }
    try {
      await this.leaseEcho();
    } catch (error) {
      const why = messageOf(error);
      throw new Error(
        this.paused
          ? `${this.paused}. Leasing it again failed: ${why}`
          : `Local LLM is not available from the model controller: ${why}`,
      );
    }
  }

  async leaseEcho(): Promise<void> {
    if (!this.used || !this.want || this.coderBusy || this.echoYield.size > 0) return;
    this.echoRetryAt = Date.now() + this.echoRetryMs;
    return this.ensureEchoLease(this.leaseWaitS);
  }

  private ensureEchoLease(waitS: number): Promise<void> {
    if (this.echoLease && !this.echoLease.revoked && !this.echoLease.lost) return Promise.resolve();
    this.echoPending ??= this.acquireEcho(waitS).finally(() => {
      this.echoPending = null;
    });
    return this.echoPending;
  }

  private async acquireEcho(waitS: number): Promise<void> {
    try {
      const model = await this.echoModelForLease();
      const lease = await this.controller.lease(ECHO_BACKEND, {
        waitS,
        signal: this.abort.signal,
        ...(model ? { model } : {}),
      });
      if (!this.want || this.coderBusy) {
        await lease.release(); // the app went to sleep, or a coding task took the GPU, while it loaded
        return;
      }
      this.echoLease = lease;
      this.echoOwed = false;
      this.paused = null;
      this.failure = null;
      this.logger.info('Leased echo-llm.', {
        lease: lease.id,
        url: lease.url,
        model: lease.model ?? undefined,
      });
      await this.onChange?.();
    } catch (error) {
      if (this.abort.signal.aborted) return; // the app went to sleep or is quitting; nothing is left to report
      const missing =
        isNotFound(error) && this.echoPick ? new ControllerModelMissing(this.echoPick.alias) : null;
      this.failure = messageOf(missing ?? error);
      throw missing ?? error;
    }
  }

  /** The catalog id of the model picked for Echo, asking the app for the pick the first time. */
  private async echoModelForLease(): Promise<string | null> {
    if (!this.echoPickKnown && this.options.echoModel) {
      const pick = await this.options.echoModel().catch(() => undefined);
      if (pick !== undefined) {
        this.echoPickKnown = true;
        this.echoPick = pick;
        this.echoModelId = null;
        if (pick) {
          this.echoModelId = await this.catalogId(pick).catch((error: unknown) => {
            this.logger.warn(
              'The picked Thinking model is not in the model controller; leasing its default model.',
              { model: pick.alias, message: messageOf(error) },
            );
            return null;
          });
        }
      }
    }
    return this.echoModelId;
  }

  /** The controller's catalog id for a GGUF the app downloaded, found by its path or file name. Throws ControllerModelMissing. */
  private async catalogId(pick: EchoModelPick): Promise<string> {
    const models = await this.controller.models({ kind: 'llm', scope: 'local' });
    const wanted = normalPath(pick.path);
    const file = path.posix.basename(wanted);
    const hit =
      models.find((entry) => typeof entry.path === 'string' && normalPath(entry.path) === wanted) ??
      models.find(
        (entry) => typeof entry.file_name === 'string' && entry.file_name.toLowerCase() === file,
      );
    if (!hit || typeof hit.id !== 'string') throw new ControllerModelMissing(pick.alias);
    return hit.id;
  }

  /**
   * The Thinking model was picked in the app (null: back to the controller's default): gives Echo's
   * lease up and leases echo-llm again with that model, which the controller loads. Resolves with
   * what happened, in words; the model loads in the background. Throws ControllerModelMissing when
   * the controller's catalog lacks the file.
   */
  async useEchoModel(pick: EchoModelPick | null): Promise<string> {
    await this.starting;
    const id = pick ? await this.catalogId(pick) : null;
    this.echoPick = pick;
    this.echoModelId = id;
    this.echoPickKnown = true;
    const name = pick ? pick.alias : 'the controller’s default model';
    if (!this.want || this.coderBusy || this.echoYield.size > 0) {
      return `${name} is set for Echo; the model controller loads it when Echo’s lease is made again.`;
    }
    await this.releaseEcho();
    await this.echoPending?.catch(() => undefined);
    await this.releaseEcho(); // a lease that was loading when we asked
    this.logger.info('Leasing echo-llm with another model.', {
      model: pick?.alias ?? 'default',
      catalogId: id ?? undefined,
    });
    void this.leaseEcho().catch((error) =>
      this.logger.warn('Could not lease echo-llm with the picked model.', {
        message: messageOf(error),
      }),
    );
    return `The model controller is loading ${name} for Echo; loading takes a minute or more.`;
  }

  async releaseEcho(): Promise<void> {
    const lease = this.echoLease;
    this.echoLease = null;
    this.paused = null;
    if (lease) {
      await lease.release();
      this.logger.info('Released echo-llm.');
    }
  }

  async leaseCoder(): Promise<{ url: string | null }> {
    this.coderBusy = true;
    try {
      await this.releaseEcho();
      await this.echoPending?.catch(() => undefined);
      await this.releaseEcho(); // a lease that was loading when we asked
      this.coderLease = await this.controller.lease(CODER_BACKEND, {
        waitS: this.leaseWaitS,
        signal: this.abort.signal,
      });
      this.logger.info('Leased coder-llm.', {
        lease: this.coderLease.id,
        url: this.coderLease.url,
      });
      return { url: this.coderLease.url };
    } catch (error) {
      this.coderBusy = false;
      throw error;
    }
  }

  coderLost(): boolean {
    const lease = this.coderLease;
    return !lease || lease.revoked !== undefined || lease.lost;
  }

  async releaseCoder(): Promise<void> {
    const lease = this.coderLease;
    this.coderLease = null;
    this.coderBusy = false;
    if (lease) {
      await lease.release();
      this.logger.info('Released coder-llm.');
    }
  }

  // Motion: leased like Echo's model, for as long as the app runs and motion is enabled.

  /** Motion is enabled (Moving runs on this PC's own motion service): lease it, or give the lease back. */
  setMotionWanted(wanted: boolean): void {
    if (this.motionWanted === wanted) return;
    this.motionWanted = wanted;
    if (wanted)
      void this.leaseMotion().catch((error) =>
        this.logger.warn('Could not lease motion yet.', { message: messageOf(error) }),
      );
    else void this.releaseMotion().catch(() => undefined);
  }

  /** The motion lease's base URL, or null without one (the configured address is used then). */
  motionUrl(): string | null {
    return this.motionLease?.url ?? null;
  }

  async leaseMotion(): Promise<void> {
    if (!this.used || !this.want || !this.motionWanted || !this.managesBackend(MOTION_BACKEND))
      return;
    if (this.motionLease && !this.motionLease.revoked && !this.motionLease.lost) return;
    this.motionAskedAt = Date.now();
    this.motionPending ??= this.acquireMotion().finally(() => {
      this.motionPending = null;
    });
    return this.motionPending;
  }

  private async acquireMotion(): Promise<void> {
    try {
      const lease = await this.controller.lease(MOTION_BACKEND, {
        waitS: this.leaseWaitS,
        signal: this.abort.signal,
      });
      if (!this.want || !this.motionWanted) {
        await lease.release();
        return;
      }
      this.motionLease = lease;
      this.motionOwed = false;
      this.motionPaused = null;
      this.motionFailure = null;
      this.logger.info('Leased motion.', { lease: lease.id, url: lease.url });
      await this.onChange?.();
    } catch (error) {
      if (this.abort.signal.aborted) return; // aborted while queued at the controller
      if (isNotFound(error)) {
        this.noteUnknown(MOTION_BACKEND);
        return;
      }
      this.motionFailure = messageOf(error);
      throw error;
    }
  }

  /** Before motion is used: leases it again after a revoke. Throws the reason if it can't. */
  async ensureMotion(): Promise<void> {
    await this.starting;
    this.check();
    if (
      this.motionLease ||
      !this.used ||
      !this.want ||
      !this.motionWanted ||
      !this.managesBackend(MOTION_BACKEND)
    )
      return;
    // A request already waiting (queued at the controller) is not waited for again: callers poll, and the status says it waits.
    if (this.motionPending) return;
    try {
      await this.leaseMotion();
    } catch (error) {
      const why = messageOf(error);
      throw new Error(
        this.motionPaused
          ? `${this.motionPaused}. Leasing it again failed: ${why}`
          : `Motion is not available from the model controller: ${why}`,
      );
    }
  }

  async releaseMotion(): Promise<void> {
    const lease = this.motionLease;
    this.motionLease = null;
    this.motionPaused = null;
    if (lease) {
      await lease.release();
      this.logger.info('Released motion.');
    }
  }

  // ComfyUI and the vision model: leased per use, kept for a quiet spell so jobs in a row share one.

  async acquire(
    backend: SharedBackend,
    options: SharedAcquireOptions = {},
  ): Promise<SharedHandle | null> {
    await this.starting;
    if (!this.used || !this.managesBackend(backend)) return null;
    // One lease per set of needs: a job that routes to another machine must not reuse this PC's lease, nor the reverse.
    const needs = [...new Set((options.needs ?? []).filter(Boolean))].sort();
    const key = needs.length ? `${backend}|${needs.join('|')}` : backend;
    let state = this.shared.get(key);
    if (!state) {
      state = {
        backend,
        needs,
        yielding: false,
        lease: null,
        pending: null,
        users: 0,
        timer: null,
      };
      this.shared.set(key, state);
    }
    const held = state;
    this.clearSharedTimer(held);
    held.users += 1; // counted before waiting, so the quiet-spell timer can't release a lease being asked for
    const finish = () => {
      held.users -= 1;
      if (held.users === 0) this.armShared(key, held);
    };
    try {
      if (held.lease && (held.lease.revoked || held.lease.lost)) held.lease = null;
      if (!held.lease) {
        held.pending ??= this.openShared(key, held).finally(() => {
          held.pending = null;
        });
        await held.pending;
      }
      if (!held.lease) {
        finish(); // the controller doesn't have it
        return null;
      }
    } catch (error) {
      finish();
      throw error;
    }
    let over = false;
    return {
      url: held.lease.url,
      host: this.remoteHost(held.lease),
      done: () => {
        if (over) return;
        over = true;
        finish();
      },
    };
  }

  /** Every model on every machine the controller knows (GET /v1/models?scope=all); empty when the controller isn't in use or can't be asked. */
  async listAllModels(): Promise<ControllerModelEntry[]> {
    await this.starting;
    if (!this.used) return [];
    const models = await this.controller.models({ scope: 'all' });
    return models.flatMap((entry): ControllerModelEntry[] => {
      if (typeof entry.file_name !== 'string' || !entry.file_name) return [];
      return [
        {
          kind: typeof entry.kind === 'string' ? entry.kind : '',
          subfolder: typeof entry.subfolder === 'string' ? entry.subfolder : null,
          fileName: entry.file_name,
          sizeBytes: typeof entry.size_bytes === 'number' ? entry.size_bytes : null,
          host:
            typeof entry.host === 'string' && entry.host
              ? entry.host
              : (this.localName ?? 'this PC'),
          state: typeof entry.state === 'string' ? entry.state : 'installed',
        },
      ];
    });
  }

  /** This controller's machine name and its peers (the other machines a download can go to). */
  async hostNames(): Promise<{ local: string | null; hosts: string[] }> {
    await this.starting;
    if (!this.used) return { local: null, hosts: [] };
    const status = (await this.controller.status().catch(() => ({}))) as {
      name?: string;
      peers?: (string | { name?: string })[];
    };
    const local = status.name ?? this.localName;
    const peers = (status.peers ?? []).flatMap((peer) => {
      const name = typeof peer === 'string' ? peer : peer?.name;
      return typeof name === 'string' && name ? [name] : [];
    });
    return { local: local ?? null, hosts: [...new Set(peers)].filter((name) => name !== local) };
  }

  /** Starts a download on a machine (or "auto") through the controller; resolves with its job. */
  async startDownload(
    source: DownloadSource,
    options: DownloadOptions,
  ): Promise<ControllerDownloadJob> {
    await this.starting;
    if (!this.used) throw new Error('The model controller is not in use.');
    return toDownloadJob(await this.controller.download(source, options));
  }

  async cancelDownload(id: string): Promise<void> {
    await this.controller.request('DELETE', `/v1/downloads/${encodeURIComponent(id)}`);
  }

  async downloadJob(id: string): Promise<ControllerDownloadJob> {
    return toDownloadJob(await this.controller.downloadStatus(id));
  }

  /** The machine a lease runs on when that is not this PC, else null. */
  private remoteHost(lease: Lease): string | null {
    const host = lease.data.host;
    if (!host) return null;
    if (lease.id.startsWith(`${host}:`)) return host;
    return this.localName && host !== this.localName ? host : null;
  }

  /** Whether the controller will probably send a job with these needs to another machine (one that is up and has the files). */
  private async routesAway(needs: string[]): Promise<boolean> {
    if (!needs.length) return false;
    try {
      const wanted = needs.map((name) => path.posix.basename(normalPath(name)));
      const byHost = new Map<string, Set<string>>();
      for (const entry of await this.controller.models({ scope: 'all' })) {
        const host = typeof entry.host === 'string' ? entry.host : null;
        const file =
          typeof entry.file_name === 'string'
            ? path.posix.basename(normalPath(entry.file_name))
            : null;
        if (
          !host ||
          !file ||
          host === this.localName ||
          entry.state === 'offline' ||
          entry.state === 'busy'
        )
          continue;
        byHost.set(host, (byHost.get(host) ?? new Set()).add(file));
      }
      return [...byHost.values()].some((files) => wanted.every((name) => files.has(name)));
    } catch {
      return false;
    }
  }

  /** The controller never evicts a leased backend, so Echo's lease goes back while a job on this PC's GPU works. */
  private async yieldEcho(key: string, state: SharedState): Promise<void> {
    state.yielding = true;
    this.echoYield.add(key);
    // Echo had (or was getting) a lease and not a revoke's pause: it is owed back once nothing else holds the GPU.
    if (this.used && this.want && (this.echoLease || this.echoPending || !this.paused))
      this.echoOwed = true;
    await this.releaseEcho();
    await this.echoPending?.catch(() => undefined);
    await this.releaseEcho();
  }

  private async openShared(key: string, state: SharedState): Promise<void> {
    const { backend, needs } = state;
    // A job the controller will send to another machine doesn't need this PC's GPU, so Echo keeps it.
    const away = await this.routesAway(needs);
    try {
      if (!away) await this.yieldEcho(key, state);
      state.lease = await this.controller.lease(backend, {
        waitS: this.leaseWaitS,
        signal: this.abort.signal,
        ...(needs.length ? { needs } : {}),
      });
      const host = this.remoteHost(state.lease);
      this.logger.info(`Leased ${backend}.`, {
        lease: state.lease.id,
        url: state.lease.url,
        ...(host ? { host } : {}),
      });
      if (host && state.yielding) {
        // Routed away after all: Echo's GPU is not needed.
        state.yielding = false;
        this.echoYield.delete(key);
        this.backToEcho();
      } else if (!host && !state.yielding) {
        await this.yieldEcho(key, state); // the prediction was wrong: it runs here
      }
    } catch (error) {
      state.yielding = false;
      this.echoYield.delete(key);
      this.backToEcho();
      if (isNotFound(error)) {
        this.noteUnknown(backend);
        return;
      }
      throw error;
    }
  }

  private clearSharedTimer(state: SharedState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  private armShared(key: string, state: SharedState): void {
    this.clearSharedTimer(state);
    if (!state.lease) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.users === 0) void this.releaseShared(state);
    }, this.sharedIdleMs);
    state.timer.unref?.();
  }

  private async releaseShared(state: SharedState): Promise<void> {
    const lease = state.lease;
    state.lease = null;
    this.clearSharedTimer(state);
    const key = [...this.shared].find(([, entry]) => entry === state)?.[0];
    if (key) {
      this.echoYield.delete(key);
      if (key.includes('|') && state.users === 0 && !state.pending) this.shared.delete(key); // needs-keyed entries don't pile up
    }
    state.yielding = false;
    if (lease) {
      await lease.release().catch(() => undefined);
      this.logger.info(`Released ${state.backend}.`);
    }
    this.backToEcho();
  }

  /** Nothing else needs the GPU: lease Echo's model again, in the background. */
  private backToEcho(): void {
    const blocker = this.echoBlocker();
    if (blocker) {
      this.logger.info('Not leasing echo-llm again yet.', { reason: blocker });
      return;
    }
    this.echoRetryAt = Date.now() + this.echoRetryMs;
    void this.leaseEcho().catch((error) =>
      this.logger.warn('Could not lease echo-llm again.', { message: messageOf(error) }),
    );
  }

  /** Suspend and hibernate: give every lease back so the GPU is free while the PC sleeps. */
  async suspend(): Promise<void> {
    this.want = false;
    this.echoOwed = false;
    this.motionOwed = false;
    // A lease still queued at the controller (e.g. for memory) is not known by id here: aborting the request
    // makes the client give it back. One that arrives after this point is released on arrival.
    this.abort.abort();
    await this.releaseCoder().catch(() => undefined);
    await this.releaseMotion().catch(() => undefined);
    for (const state of this.shared.values())
      await this.releaseShared(state).catch(() => undefined);
    await this.releaseEcho().catch(() => undefined);
    await Promise.resolve(this.onChange?.()).catch(() => undefined);
  }

  /** After resume: look for the controller again and lease Echo's model (and motion) in the background. */
  async resume(): Promise<void> {
    if (this.mode === 'off') return;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    await this.detect();
    this.want = true;
    if (this.used) {
      // The controller gets the same wake signal and may not have handled it yet ("going to sleep", 503),
      // or the network may still be coming up: a failed ask is retried every echoRetryMs, not left for a turn.
      void this.leaseEcho().catch((error) => {
        this.echoOwed = true;
        this.logger.warn('Could not lease echo-llm after resume; asking again shortly.', {
          message: messageOf(error),
        });
      });
      void this.leaseMotion().catch((error) => {
        this.motionOwed = true;
        this.logger.warn('Could not lease motion after resume; asking again shortly.', {
          message: messageOf(error),
        });
      });
    }
  }

  /** The app is quitting. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.starting?.catch(() => undefined);
    await this.suspend();
  }

  /** Every backend the app leases, for the status panel. */
  private leaseSummary(): LeaseSummary[] {
    const out: LeaseSummary[] = [];
    if (this.coderLease || this.coderBusy) out.push({ backend: CODER_BACKEND, state: 'leased' });
    else if (this.echoLease) out.push({ backend: ECHO_BACKEND, state: 'leased' });
    else if (this.paused) out.push({ backend: ECHO_BACKEND, state: 'paused' });
    else if (!this.want || this.echoYield.size > 0)
      out.push({ backend: ECHO_BACKEND, state: 'idle' });
    else out.push({ backend: ECHO_BACKEND, state: 'leasing' });
    if (this.motionWanted) {
      if (this.unknownBackends.has(MOTION_BACKEND))
        out.push({ backend: MOTION_BACKEND, state: 'own' });
      else if (this.motionLease) out.push({ backend: MOTION_BACKEND, state: 'leased' });
      else if (this.motionPaused) out.push({ backend: MOTION_BACKEND, state: 'paused' });
      else out.push({ backend: MOTION_BACKEND, state: this.want ? 'leasing' : 'idle' });
    }
    for (const backend of [COMFY_BACKEND, VISION_BACKEND] as const) {
      if (this.unknownBackends.has(backend)) out.push({ backend, state: 'own' });
      else
        out.push({
          backend,
          state: [...this.shared.values()].some((entry) => entry.backend === backend && entry.lease)
            ? 'leased'
            : 'idle',
        });
    }
    return out;
  }

  status(): ControllerStatus {
    const base = { mode: this.mode, inUse: this.used, url: this.url, leases: [] as LeaseSummary[] };
    if (this.mode === 'off')
      return { ...base, echo: 'direct', line: 'Model controller: off (AICONTROLLER_ENABLED=0).' };
    if (!this.used)
      return {
        ...base,
        echo: 'direct',
        line: `Model controller: not running at ${this.url}; the app runs its own servers.`,
      };
    const leases = this.leaseSummary();
    const names = (state: LeaseSummaryState) =>
      leases.filter((entry) => entry.state === state).map((entry) => entry.backend);
    const leased = names('leased');
    const idle = names('idle');
    const own = names('own');
    const notes: string[] = [];
    let echo: EchoLeaseState;
    if (this.coderLease || this.coderBusy) {
      echo = 'coder';
      notes.push('Echo chats on the coder model.');
    } else if (this.echoLease) {
      echo = 'leased';
    } else if (this.paused) {
      echo = 'paused';
      notes.push(`${this.paused}.`);
    } else if (!this.want) {
      echo = 'released';
      notes.push('Leases released while asleep.');
    } else if (this.failure) {
      echo = 'error';
      notes.push(`echo-llm lease failed: ${this.failure}.`);
    } else {
      echo = 'leasing';
      notes.push(
        this.echoYield.size > 0
          ? `Echo’s model is unloaded while ${this.yieldNames()} uses the GPU.`
          : 'Leasing echo-llm (the model may be loading).',
      );
    }
    if (this.motionPaused) notes.push(`${this.motionPaused}.`);
    else if (
      this.motionWanted &&
      !this.motionLease &&
      this.motionPending &&
      Date.now() - this.motionAskedAt > MOTION_WAITING_MS
    )
      notes.push('motion waiting for memory on the controller.');
    else if (this.motionFailure && !this.motionLease && this.motionWanted)
      notes.push(`motion lease failed: ${this.motionFailure}.`);
    if (own.length > 0)
      notes.push(`${own.join(', ')} not on the controller: the app runs its own.`);
    const summary = `Model controller: in use, ${leased.length > 0 ? `${leased.join(', ')} leased` : 'nothing leased'}${idle.length > 0 ? `; ${idle.join(', ')} idle` : ''}.`;
    return { ...base, leases, echo, line: [summary, ...notes].join(' ') };
  }
}

/**
 * Echo's chat on the lease's URL instead of the configured one. Only when Thinking is the built-in
 * language model on this PC; any other server is left alone.
 */
export function echoRouteOverride(routing: ModelRouting, url: string | null): RouteOverride | null {
  if (!url) return null;
  const target = routeTargets(routing, 'llm')[0];
  if (!target || target.server.id !== BUILT_IN_SERVER_IDS.llm) return null;
  return { server: { ...target.server, url }, model: target.model };
}
