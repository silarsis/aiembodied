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
import { Controller, ControllerError, type Lease } from './client.js';
import { BUILT_IN_SERVER_IDS, routeTargets, type ModelRouting, type RouteOverride } from '../config/model-routing.js';

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

export type EchoLeaseState = 'direct' | 'leasing' | 'leased' | 'paused' | 'coder' | 'released' | 'error';

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
  done(): void;
}

/** What ComfyUI's pool and the vision server need from the controller. */
export interface SharedLeases {
  inUse(): boolean;
  /**
   * Leases a backend for one use. Resolves null when the controller isn't in use or doesn't know the
   * backend (logged once): the caller then runs its own server. Rejects with the reason when the
   * lease can't be had (the GPU is needed by a game, the controller is required but down).
   */
  acquire(backend: SharedBackend): Promise<SharedHandle | null>;
}

/** The Thinking model picked for Echo: a GGUF file the controller must know. */
export interface EchoModelPick {
  path: string;
  alias: string;
}

/** A lease Echo's model picker wanted could not be made because the controller doesn't have the model. */
export class ControllerModelMissing extends Error {
  constructor(alias: string) {
    super(`The model controller doesn't have ${alias}; add its folder to the controller's model_store.`);
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
  lease: Lease | null;
  pending: Promise<void> | null;
  /** Uses between acquire() and done(). */
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
}

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
  private readonly echoYield = new Set<string>();
  private readonly shared = new Map<SharedBackend, SharedState>();
  /** Motion is enabled in Models and servers and is this PC's own. */
  private motionWanted = false;
  private motionLease: Lease | null = null;
  private motionPending: Promise<void> | null = null;
  private motionPaused: string | null = null;
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
    this.mode = parseControllerMode(env.AICONTROLLER_ENABLED);
    this.url = (env.AICONTROLLER_URL?.trim() || DEFAULT_CONTROLLER_URL).replace(/\/+$/, '');
    // Never autostart: the controller is the tray's business.
    this.controller = new Controller({ url: this.url, client: CLIENT_NAME, autostart: false, fetch: options.fetchFn, token: env.AICONTROLLER_TOKEN });
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
  managesBackend(backend: string): boolean {
    return this.used && !this.unknownBackends.has(backend) && (this.backendIds ? this.backendIds.has(backend) : true);
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
      await this.controller.health();
      this.used = true;
      await this.readBackends();
    } catch (error) {
      // Required: stay "in use" so no llama-server is started behind the controller's back, and turns say why they fail.
      this.used = this.mode === 'required';
      this.failure = this.mode === 'required' ? `the model controller is required (AICONTROLLER_ENABLED=1) but does not answer at ${this.url}` : null;
      this.logger.info(this.mode === 'required' ? 'Model controller required but not answering.' : 'Model controller not answering; using local servers directly.', {
        url: this.url,
        message: messageOf(error),
      });
    }
  }

  /** Which backends the controller has; failing that, every lease is tried and a 404 means "not here". */
  private async readBackends(): Promise<void> {
    try {
      const status = await this.controller.request<{ backends?: { id?: unknown }[] }>('GET', '/v1/status', { timeoutMs: 5000 });
      const ids = (status.backends ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string');
      this.backendIds = ids.length > 0 ? new Set(ids) : null;
      for (const backend of [MOTION_BACKEND, COMFY_BACKEND, VISION_BACKEND]) {
        if (this.backendIds && !this.backendIds.has(backend)) this.noteUnknown(backend);
      }
    } catch (error) {
      this.backendIds = null;
      this.logger.warn('Could not read the model controller’s backends.', { message: messageOf(error) });
    }
  }

  /** Logs once that the controller lacks a backend, so the app runs its own server for it. */
  private noteUnknown(backend: string): void {
    if (this.unknownBackends.has(backend)) return;
    this.unknownBackends.add(backend);
    this.logger.warn(`The model controller has no ${backend} backend; the app runs its own server for it.`, { url: this.url });
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
      void this.leaseEcho().catch((error) => this.logger.warn('Could not lease echo-llm yet.', { message: messageOf(error) }));
      void this.leaseMotion().catch((error) => this.logger.warn('Could not lease motion yet.', { message: messageOf(error) }));
    }
  }

  /** True while the controller runs Echo's model but Echo has no lease yet (the model is still loading). */
  echoWaiting(): boolean {
    return this.used && this.want && !this.coderBusy && this.echoYield.size === 0 && !this.echoLease;
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
    for (const [backend, state] of this.shared) {
      const lease = state.lease;
      if (lease && state.users === 0 && (lease.revoked || lease.lost)) void this.releaseShared(backend, state);
    }
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
        throw new Error(`Echo's model is unloaded while ${[...this.echoYield].join(' and ')} uses the GPU. Try again when it has finished (about a minute after the last job).`);
      }
      return;
    }
    try {
      await this.leaseEcho();
    } catch (error) {
      const why = messageOf(error);
      throw new Error(this.paused ? `${this.paused}. Leasing it again failed: ${why}` : `Local LLM is not available from the model controller: ${why}`);
    }
  }

  async leaseEcho(): Promise<void> {
    if (!this.used || !this.want || this.coderBusy || this.echoYield.size > 0) return;
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
      const lease = await this.controller.lease(ECHO_BACKEND, { waitS, ...(model ? { model } : {}) });
      if (!this.want || this.coderBusy) {
        await lease.release(); // the app went to sleep, or a coding task took the GPU, while it loaded
        return;
      }
      this.echoLease = lease;
      this.paused = null;
      this.failure = null;
      this.logger.info('Leased echo-llm.', { lease: lease.id, url: lease.url, model: lease.model ?? undefined });
      await this.onChange?.();
    } catch (error) {
      const missing = isNotFound(error) && this.echoPick ? new ControllerModelMissing(this.echoPick.alias) : null;
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
            this.logger.warn('The picked Thinking model is not in the model controller; leasing its default model.', { model: pick.alias, message: messageOf(error) });
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
      models.find((entry) => typeof entry.file_name === 'string' && entry.file_name.toLowerCase() === file);
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
    this.logger.info('Leasing echo-llm with another model.', { model: pick?.alias ?? 'default', catalogId: id ?? undefined });
    void this.leaseEcho().catch((error) => this.logger.warn('Could not lease echo-llm with the picked model.', { message: messageOf(error) }));
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
      this.coderLease = await this.controller.lease(CODER_BACKEND, { waitS: this.leaseWaitS });
      this.logger.info('Leased coder-llm.', { lease: this.coderLease.id, url: this.coderLease.url });
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
    if (wanted) void this.leaseMotion().catch((error) => this.logger.warn('Could not lease motion yet.', { message: messageOf(error) }));
    else void this.releaseMotion().catch(() => undefined);
  }

  /** The motion lease's base URL, or null without one (the configured address is used then). */
  motionUrl(): string | null {
    return this.motionLease?.url ?? null;
  }

  async leaseMotion(): Promise<void> {
    if (!this.used || !this.want || !this.motionWanted || !this.managesBackend(MOTION_BACKEND)) return;
    if (this.motionLease && !this.motionLease.revoked && !this.motionLease.lost) return;
    this.motionPending ??= this.acquireMotion().finally(() => {
      this.motionPending = null;
    });
    return this.motionPending;
  }

  private async acquireMotion(): Promise<void> {
    try {
      const lease = await this.controller.lease(MOTION_BACKEND, { waitS: this.leaseWaitS });
      if (!this.want || !this.motionWanted) {
        await lease.release();
        return;
      }
      this.motionLease = lease;
      this.motionPaused = null;
      this.motionFailure = null;
      this.logger.info('Leased motion.', { lease: lease.id, url: lease.url });
      await this.onChange?.();
    } catch (error) {
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
    if (this.motionLease || !this.used || !this.want || !this.motionWanted || !this.managesBackend(MOTION_BACKEND)) return;
    try {
      await this.leaseMotion();
    } catch (error) {
      const why = messageOf(error);
      throw new Error(this.motionPaused ? `${this.motionPaused}. Leasing it again failed: ${why}` : `Motion is not available from the model controller: ${why}`);
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

  async acquire(backend: SharedBackend): Promise<SharedHandle | null> {
    await this.starting;
    if (!this.used || !this.managesBackend(backend)) return null;
    let state = this.shared.get(backend);
    if (!state) {
      state = { lease: null, pending: null, users: 0, timer: null };
      this.shared.set(backend, state);
    }
    const held = state;
    this.clearSharedTimer(held);
    held.users += 1; // counted before waiting, so the quiet-spell timer can't release a lease being asked for
    const finish = () => {
      held.users -= 1;
      if (held.users === 0) this.armShared(backend, held);
    };
    try {
      if (held.lease && (held.lease.revoked || held.lease.lost)) held.lease = null;
      if (!held.lease) {
        held.pending ??= this.openShared(backend, held).finally(() => {
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
      done: () => {
        if (over) return;
        over = true;
        finish();
      },
    };
  }

  private async openShared(backend: SharedBackend, state: SharedState): Promise<void> {
    // The controller never evicts a leased backend, so Echo's lease goes back while this one works.
    this.echoYield.add(backend);
    try {
      await this.releaseEcho();
      await this.echoPending?.catch(() => undefined);
      await this.releaseEcho();
      state.lease = await this.controller.lease(backend, { waitS: this.leaseWaitS });
      this.logger.info(`Leased ${backend}.`, { lease: state.lease.id, url: state.lease.url });
    } catch (error) {
      this.echoYield.delete(backend);
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

  private armShared(backend: SharedBackend, state: SharedState): void {
    this.clearSharedTimer(state);
    if (!state.lease) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.users === 0) void this.releaseShared(backend, state);
    }, this.sharedIdleMs);
    state.timer.unref?.();
  }

  private async releaseShared(backend: SharedBackend, state: SharedState): Promise<void> {
    const lease = state.lease;
    state.lease = null;
    this.clearSharedTimer(state);
    this.echoYield.delete(backend);
    if (lease) {
      await lease.release().catch(() => undefined);
      this.logger.info(`Released ${backend}.`);
    }
    this.backToEcho();
  }

  /** Nothing else needs the GPU: lease Echo's model again, in the background. */
  private backToEcho(): void {
    if (this.echoYield.size > 0 || !this.used || !this.want) return;
    void this.leaseEcho().catch((error) => this.logger.warn('Could not lease echo-llm again.', { message: messageOf(error) }));
  }

  /** Suspend and hibernate: give every lease back so the GPU is free while the PC sleeps. */
  async suspend(): Promise<void> {
    this.want = false;
    await this.releaseCoder().catch(() => undefined);
    await this.releaseMotion().catch(() => undefined);
    for (const [backend, state] of this.shared) await this.releaseShared(backend, state).catch(() => undefined);
    await this.releaseEcho().catch(() => undefined);
    await Promise.resolve(this.onChange?.()).catch(() => undefined);
  }

  /** After resume: look for the controller again and lease Echo's model (and motion) in the background. */
  async resume(): Promise<void> {
    if (this.mode === 'off') return;
    await this.detect();
    this.want = true;
    if (this.used) {
      void this.leaseEcho().catch((error) => this.logger.warn('Could not lease echo-llm after resume.', { message: messageOf(error) }));
      void this.leaseMotion().catch((error) => this.logger.warn('Could not lease motion after resume.', { message: messageOf(error) }));
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
    else if (!this.want || this.echoYield.size > 0) out.push({ backend: ECHO_BACKEND, state: 'idle' });
    else out.push({ backend: ECHO_BACKEND, state: 'leasing' });
    if (this.motionWanted) {
      if (this.unknownBackends.has(MOTION_BACKEND)) out.push({ backend: MOTION_BACKEND, state: 'own' });
      else if (this.motionLease) out.push({ backend: MOTION_BACKEND, state: 'leased' });
      else if (this.motionPaused) out.push({ backend: MOTION_BACKEND, state: 'paused' });
      else out.push({ backend: MOTION_BACKEND, state: this.want ? 'leasing' : 'idle' });
    }
    for (const backend of [COMFY_BACKEND, VISION_BACKEND] as const) {
      if (this.unknownBackends.has(backend)) out.push({ backend, state: 'own' });
      else out.push({ backend, state: this.shared.get(backend)?.lease ? 'leased' : 'idle' });
    }
    return out;
  }

  status(): ControllerStatus {
    const base = { mode: this.mode, inUse: this.used, url: this.url, leases: [] as LeaseSummary[] };
    if (this.mode === 'off') return { ...base, echo: 'direct', line: 'Model controller: off (AICONTROLLER_ENABLED=0).' };
    if (!this.used) return { ...base, echo: 'direct', line: `Model controller: not running at ${this.url}; the app runs its own servers.` };
    const leases = this.leaseSummary();
    const names = (state: LeaseSummaryState) => leases.filter((entry) => entry.state === state).map((entry) => entry.backend);
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
      notes.push(this.echoYield.size > 0 ? `Echo’s model is unloaded while ${[...this.echoYield].join(' and ')} uses the GPU.` : 'Leasing echo-llm (the model may be loading).');
    }
    if (this.motionPaused) notes.push(`${this.motionPaused}.`);
    else if (this.motionFailure && !this.motionLease && this.motionWanted) notes.push(`motion lease failed: ${this.motionFailure}.`);
    if (own.length > 0) notes.push(`${own.join(', ')} not on the controller: the app runs its own.`);
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
