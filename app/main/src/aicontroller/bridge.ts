/**
 * Echo's link to the shared model controller (aicontroller, http://127.0.0.1:8200 by default).
 *
 * The controller owns the GPU servers: echo-llm (:1234) and coder-llm (:1236). With it in use this
 * app holds an `interactive` lease on echo-llm instead of starting llama-server itself, uses the
 * lease's URL for chat, and gives the lease back on quit, hibernate and suspend. If the controller
 * revokes the lease (a game needs the GPU, or the coder evicts Echo's model), the next turn leases
 * again. A coding task leases coder-llm in place of echo-llm (see coding/model-swap.ts).
 *
 * AICONTROLLER_ENABLED: `auto` (default) uses the controller if it answers and otherwise leaves
 * everything as it was; `1` requires it (turns fail with a message while it is down); `0` never
 * uses it. This app never starts the controller: on bija it runs from the tray.
 */
import { Controller, type Lease } from './client.js';
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
const CLIENT_NAME = 'aiembodied';

export type EchoLeaseState = 'direct' | 'leasing' | 'leased' | 'paused' | 'coder' | 'released' | 'error';

export interface ControllerStatus {
  mode: ControllerMode;
  /** The controller is what runs the models; the app starts and stops no llama-server. */
  inUse: boolean;
  url: string;
  echo: EchoLeaseState;
  /** One line for the status panel. */
  line: string;
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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AicontrollerBridge implements CoderLeases {
  readonly mode: ControllerMode;
  readonly url: string;
  private readonly controller: Controller;
  private readonly logger: Logger;
  private readonly onChange?: () => void | Promise<void>;
  private readonly leaseWaitS: number;
  private readonly watchMs: number;
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

  constructor(options: AicontrollerBridgeOptions) {
    const env = options.env ?? process.env;
    this.logger = options.logger;
    this.onChange = options.onChange;
    this.leaseWaitS = options.leaseWaitS ?? 900;
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
    }
  }

  /** True while the controller runs Echo's model but Echo has no lease yet (the model is still loading). */
  echoWaiting(): boolean {
    return this.used && this.want && !this.coderBusy && !this.echoLease;
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
  }

  /** Before a turn: makes sure Echo holds a lease again after a revoke. Throws the reason if it can't. */
  async ensureEcho(): Promise<void> {
    await this.starting;
    if (!this.used || !this.want || this.coderBusy) return;
    this.check();
    if (this.echoLease) return;
    try {
      await this.leaseEcho();
    } catch (error) {
      const why = messageOf(error);
      throw new Error(this.paused ? `${this.paused}. Leasing it again failed: ${why}` : `Local LLM is not available from the model controller: ${why}`);
    }
  }

  async leaseEcho(): Promise<void> {
    if (!this.used || !this.want || this.coderBusy) return;
    if (this.echoLease && !this.echoLease.revoked && !this.echoLease.lost) return;
    this.echoPending ??= this.acquireEcho().finally(() => {
      this.echoPending = null;
    });
    return this.echoPending;
  }

  private async acquireEcho(): Promise<void> {
    try {
      const lease = await this.controller.lease(ECHO_BACKEND, { waitS: this.leaseWaitS });
      if (!this.want || this.coderBusy) {
        await lease.release(); // the app went to sleep, or a coding task took the GPU, while it loaded
        return;
      }
      this.echoLease = lease;
      this.paused = null;
      this.failure = null;
      this.logger.info('Leased echo-llm.', { lease: lease.id, url: lease.url });
      await this.onChange?.();
    } catch (error) {
      this.failure = messageOf(error);
      throw error;
    }
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

  /** Suspend and hibernate: give every lease back so the GPU is free while the PC sleeps. */
  async suspend(): Promise<void> {
    this.want = false;
    await this.releaseCoder().catch(() => undefined);
    await this.releaseEcho().catch(() => undefined);
    await Promise.resolve(this.onChange?.()).catch(() => undefined);
  }

  /** After resume: look for the controller again and lease Echo's model in the background. */
  async resume(): Promise<void> {
    if (this.mode === 'off') return;
    await this.detect();
    this.want = true;
    if (this.used) void this.leaseEcho().catch((error) => this.logger.warn('Could not lease echo-llm after resume.', { message: messageOf(error) }));
  }

  /** The app is quitting. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.starting?.catch(() => undefined);
    await this.suspend();
  }

  status(): ControllerStatus {
    const base = { mode: this.mode, inUse: this.used, url: this.url };
    if (this.mode === 'off') return { ...base, echo: 'direct', line: 'Model controller: off (AICONTROLLER_ENABLED=0).' };
    if (!this.used) return { ...base, echo: 'direct', line: `Model controller: not running at ${this.url}; the app runs its own servers.` };
    if (this.coderLease || this.coderBusy) {
      return { ...base, echo: 'coder', line: 'Model controller: in use, coder-llm leased; Echo chats on the coder model.' };
    }
    if (this.echoLease) return { ...base, echo: 'leased', line: `Model controller: in use, echo-llm leased (${this.echoLease.url ?? 'no URL'}).` };
    if (this.paused) return { ...base, echo: 'paused', line: `${this.paused}.` };
    if (!this.want) return { ...base, echo: 'released', line: 'Model controller: in use, echo-llm lease released while asleep.' };
    if (this.failure) return { ...base, echo: 'error', line: `Model controller: in use, echo-llm lease failed: ${this.failure}.` };
    return { ...base, echo: 'leasing', line: 'Model controller: in use, leasing echo-llm (the model may be loading).' };
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
