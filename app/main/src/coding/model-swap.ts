/**
 * Loads the coder model while a coding task needs it, next to Echo's chat model or in its place.
 *
 * Auto (the default): at the start of each load it measures whether the coder fits next to what
 * is running (free GPU memory and Windows commit headroom against the GGUF size plus a margin).
 * If it fits, it loads side by side. If not, it waits until Echo has been quiet for a while, then
 * swaps. After a swap, if Kevin talks to Echo again, it swaps back as soon as it can and goes
 * back to waiting for a quiet moment while a task still needs the model.
 *
 * Side by side: Echo's llama-server keeps running and the coder's is started next to
 * it. When no task has needed the coder model for a while (idleStopMs), the coder's server stops
 * to free memory.
 *
 * Swap (opt-in, for PCs that cannot hold both, such as bija with Echo's 86 GB chat model and the
 * 48 GB Qwen3-Coder-Next): this stops Echo's llama-server, starts the coder's, and lets Echo's
 * chat use the coder model meanwhile. When no task has needed it for a while (swapBackMs), it
 * swaps back.
 *
 * Windows only, and only when the Coding model is the built-in coder server (the app can start
 * and stop that one).
 *
 * Steps run one after another (a promise chain), so a quick change of mind never starts and stops
 * a model at the same time.
 */
import {
  BUILT_IN_SERVER_IDS,
  DEFAULT_CODER_MODEL,
  isLocalUrl,
  routeTargets,
  type ModelRouting,
  type ModelServer,
  type RouteOverride,
} from '../config/model-routing.js';
import type { LocalLlmControl } from '../local-voice/local-llm-control.js';

export type CoderMemoryMode = 'auto' | 'side-by-side' | 'swap';

export type SwapPhase = 'idle' | 'waiting-for-quiet' | 'swapping-in' | 'coder-loaded' | 'swapping-back';

export interface SwapState {
  phase: SwapPhase;
  /** For the status panel, in words. */
  message: string;
}

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

export interface CoderModelSwapOptions {
  /** The current model routing. */
  routing: () => ModelRouting;
  /** config.coding.coderGguf. */
  configuredGguf: () => string | undefined;
  /** CODER_LLM_GGUF, else a search of the usual places (gguf-finder.ts). */
  detectGguf: () => string | null;
  /** Echo's llama-server. */
  echo: Pick<LocalLlmControl, 'stop' | 'start'>;
  /** Builds the control for the coder's llama-server (pid file coder-llm.pid). */
  coder: (model: { path: string; alias: string; contextLength: number }, baseUrl: string) => Pick<LocalLlmControl, 'stop' | 'start'>;
  /** True when something answers GET <url>/models. */
  isUp: (modelsUrl: string) => Promise<boolean>;
  /** Called whenever the chat override changes, so Echo's engines are rebuilt. */
  onOverrideChange: () => void | Promise<void>;
  logger: Logger;
  platform?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How the coder model gets its memory. Read once each time a load starts. */
  mode: () => CoderMemoryMode;
  /** Swap mode: how long no task has needed the model before swapping back. Default 120 s (CODER_SWAP_BACK_S). */
  swapBackMs?: number;
  /** Side-by-side mode: how long no task has needed the model before it is stopped. Default 10 minutes (CODER_IDLE_STOP_S). */
  idleStopMs?: number;
  /** Auto mode: free memory in bytes (GPU and commit headroom, the smaller), null when unknown. */
  measureFree?: () => Promise<number | null>;
  /** Auto mode: size in bytes of the GGUF (all its parts), null when unknown. */
  ggufSize?: (path: string) => Promise<number | null>;
  /** Auto mode: when Kevin last talked to Echo (ms, same clock as now), null if not yet. Default: the time of the last noteActivity(). */
  lastActivityAt?: () => number | null;
  /** Auto mode: how long Echo must have had no conversation turn before a swap. Default 10 minutes (CODER_QUIET_S). */
  quietMs?: number;
  /** Called once each time a task starts waiting for a quiet moment to swap. */
  onWaiting?: (message: string) => void;
  /** How long to wait for the coder model to load. Default 15 minutes. */
  loadTimeoutMs?: number;
  /** How often to look while it loads. Default 3 s. */
  pollMs?: number;
  /** Runs tick() on this interval. Default 5 s; 0 turns the timer off (tests call tick()). */
  tickMs?: number;
}

const CONTEXT_LENGTH = 65536;
const GIB = 1024 ** 3;
const WAITING_MESSAGE = 'Not enough memory to run the coder next to Echo’s model; waiting until things are quiet to swap.';

/** The memory the coder needs next to what is running: the file plus a little, and 4 GiB for context. */
export function coderMemoryNeed(ggufBytes: number): number {
  return ggufBytes * 1.15 + 4 * GIB;
}

export class CoderModelSwap {
  private state: SwapState = { phase: 'idle', message: 'Not needed now.' };
  private needed = false;
  private idleSince: number | null = null;
  private chain: Promise<void> = Promise.resolve();
  private override: RouteOverride | null = null;
  /** We stopped Echo's llama-server, so we start it again. */
  private stoppedEcho = false;
  /** We started the coder's llama-server, so we stop it again. */
  private startedCoder = false;
  /** The mode of the current load, read when it started. */
  private loadMode: CoderMemoryMode = 'side-by-side';
  /** The coder server that is loaded (the override is not set in side-by-side mode). */
  private loadedServer: ModelServer | null = null;
  private coderControl: Pick<LocalLlmControl, 'stop' | 'start'> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** This load is an auto-mode swap: a conversation turn sends it back. */
  private autoSwapped = false;
  /** When the current load started, to tell turns before it from turns after it. */
  private loadStartedAt = 0;
  private lastActivity: number | null = null;
  /** When auto mode last measured memory while waiting for quiet. */
  private waitCheckedAt = 0;
  private downChecks = 0;
  /** After a failed load, no new try before this time, so a broken model doesn't stop Echo's over and over. */
  private retryAfter = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly swapBackMs: number;
  private readonly idleStopMs: number;
  private readonly quietMs: number;
  private readonly loadTimeoutMs: number;
  private readonly pollMs: number;

  constructor(private readonly options: CoderModelSwapOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.swapBackMs = options.swapBackMs ?? 120_000;
    this.idleStopMs = options.idleStopMs ?? 10 * 60_000;
    this.quietMs = options.quietMs ?? 10 * 60_000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 15 * 60_000;
    this.pollMs = options.pollMs ?? 3000;
    const tickMs = options.tickMs ?? 5000;
    if (tickMs > 0) {
      this.timer = setInterval(() => void this.tick(), tickMs);
      this.timer.unref?.();
    }
  }

  getState(): SwapState {
    return { ...this.state };
  }

  /** Thinking tries this server first while the coder model has Echo's model's place; null otherwise. */
  chatOverride(): RouteOverride | null {
    return this.override;
  }

  /** Kevin said something to Echo (a conversation turn, not a system update). In auto mode after a swap, this sends the models back. */
  noteActivity(): Promise<void> {
    this.lastActivity = this.now();
    if (this.autoSwapped && this.state.phase === 'coder-loaded') return this.reconcile();
    return this.chain;
  }

  /** The runner says whether a task needs the local model. */
  setNeeded(needed: boolean): Promise<void> {
    if (needed === this.needed && !(needed && this.state.phase === 'idle')) return this.chain;
    this.needed = needed;
    this.idleSince = needed ? null : this.now();
    this.options.logger.info('Coding model needed changed.', { needed });
    return this.reconcile();
  }

  /** One look at the clock: swaps back after the model has been idle long enough, and checks the coder server is still up. */
  tick(): Promise<void> {
    return this.reconcile();
  }

  /** Settings changed (a new model route or GGUF): look again. */
  refresh(): Promise<void> {
    return this.reconcile();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private reconcile(): Promise<void> {
    this.chain = this.chain.then(() => this.step()).catch((error) => {
      this.options.logger.warn('Coder model swap failed.', { message: error instanceof Error ? error.message : String(error) });
    });
    return this.chain;
  }

  private async step(): Promise<void> {
    const { phase } = this.state;
    if (phase === 'waiting-for-quiet') {
      // While it isn't quiet, only measure memory again once a minute (the reader runs PowerShell).
      if (this.needed && (this.isQuiet() || this.now() - this.waitCheckedAt >= 60_000)) return this.swapIn();
      if (this.needed) return;
      this.state = { phase: 'idle', message: 'Not needed now.' };
      return;
    }
    if (phase === 'coder-loaded' && this.autoSwapped && this.talkedSince(this.loadStartedAt)) {
      // Kevin is talking to Echo: give the memory back now, and wait for a quiet moment if a task still needs the model.
      await this.restoreEcho('Kevin is talking to Echo, so Echo’s model is back.');
      // We already know the coder doesn't fit, and Echo's model is still loading, so measuring now would say it fits.
      if (this.needed) {
        this.waitCheckedAt = this.now();
        this.set('waiting-for-quiet', WAITING_MESSAGE);
        this.options.onWaiting?.(WAITING_MESSAGE);
      }
      return;
    }
    if (this.needed && phase === 'idle' && this.now() >= this.retryAfter) return this.swapIn();
    if (this.needed && phase === 'coder-loaded') return this.watch();
    if (!this.needed && phase === 'coder-loaded' && this.idleSince !== null && this.now() - this.idleSince >= this.idleLimit()) {
      return this.swapBack();
    }
  }

  private talkedSince(time: number): boolean {
    const last = this.options.lastActivityAt ? this.options.lastActivityAt() : this.lastActivity;
    return last !== null && last > time;
  }

  private isQuiet(): boolean {
    const last = this.options.lastActivityAt ? this.options.lastActivityAt() : this.lastActivity;
    return last === null || this.now() - last >= this.quietMs;
  }

  /** Does the coder fit next to what is running? Unknown counts as yes: we can't tell, so try it. */
  private async fitsNextToEcho(gguf: string): Promise<boolean> {
    const free = await (this.options.measureFree?.() ?? Promise.resolve(null)).catch(() => null);
    const size = await (this.options.ggufSize?.(gguf) ?? Promise.resolve(null)).catch(() => null);
    if (free === null || size === null) {
      this.options.logger.info('Coder memory check: unknown, loading next to Echo’s model.');
      return true;
    }
    const need = coderMemoryNeed(size);
    this.options.logger.info('Coder memory check.', { freeGiB: +(free / GIB).toFixed(1), needGiB: +(need / GIB).toFixed(1) });
    return free >= need;
  }

  private idleLimit(): number {
    return this.loadMode === 'swap' ? this.swapBackMs : this.idleStopMs;
  }

  /** The coder server, when the Coding model is the built-in one on this PC and the app can run it. */
  private coderServer(): { server: ModelServer; alias: string } | null {
    if ((this.options.platform ?? process.platform) !== 'win32') return null;
    const routing = this.options.routing();
    const target = routeTargets(routing, 'coding')[0];
    if (!target || target.server.id !== BUILT_IN_SERVER_IDS.coderLlm || !isLocalUrl(target.server.url)) return null;
    return { server: target.server, alias: target.model?.trim() || DEFAULT_CODER_MODEL };
  }

  private set(phase: SwapPhase, message: string): void {
    this.state = { phase, message };
    this.options.logger.info('Coder model swap.', { phase, message });
  }

  private async setOverride(override: RouteOverride | null): Promise<void> {
    this.override = override;
    await this.options.onOverrideChange();
  }

  private async swapIn(): Promise<void> {
    const coder = this.coderServer();
    if (!coder) {
      this.state = { phase: 'idle', message: 'The coding model is not run by this app, so nothing is swapped.' };
      return;
    }
    const gguf = this.options.configuredGguf()?.trim() || this.options.detectGguf();
    if (!gguf) {
      const message = 'No Qwen3-Coder-Next GGUF found. Pick the file on the Coding page. Echo’s model was not stopped.';
      if (this.state.message !== message) this.set('idle', message);
      return;
    }
    const modelsUrl = `${coder.server.url}/models`;
    const routing = this.options.routing();
    const echoTarget = routeTargets(routing, 'llm')[0];
    const mode = this.options.mode();
    let swapMode = mode === 'swap';
    this.autoSwapped = false;
    // Auto only has a choice to make when Echo's model is the one this app runs; otherwise nothing shares memory with it.
    if (mode === 'auto' && echoTarget?.server.id === BUILT_IN_SERVER_IDS.llm && !(await this.fitsNextToEcho(gguf))) {
      if (!this.isQuiet()) {
        this.waitCheckedAt = this.now();
        if (this.state.phase !== 'waiting-for-quiet') {
          this.set('waiting-for-quiet', WAITING_MESSAGE);
          this.options.onWaiting?.(WAITING_MESSAGE);
        }
        return;
      }
      swapMode = true;
      this.autoSwapped = true;
    }
    this.loadStartedAt = this.now();
    this.loadMode = swapMode ? 'swap' : 'side-by-side';
    this.loadedServer = coder.server;
    this.set('swapping-in', swapMode ? 'Stopping Echo’s model to make room for the coder model.' : 'Loading the coder model next to Echo’s.');
    let echoId: string | null = null;
    if (swapMode && echoTarget?.server.id === BUILT_IN_SERVER_IDS.llm) {
      echoId = echoTarget.server.id;
      this.stoppedEcho = (await this.options.echo.stop().catch(() => false)) || this.stoppedEcho;
    }
    if (await this.options.isUp(modelsUrl).catch(() => false)) {
      // Something already serves it (started by hand): use it, and leave it running afterwards.
      this.startedCoder = false;
    } else {
      this.set('swapping-in', swapMode ? 'Loading the coder model. This takes a few minutes.' : 'Loading the coder model next to Echo’s. This takes a few minutes.');
      this.coderControl = this.options.coder({ path: gguf, alias: coder.alias, contextLength: CONTEXT_LENGTH }, coder.server.url);
      await this.coderControl.start();
      this.startedCoder = true;
    }
    const deadline = this.now() + this.loadTimeoutMs;
    while (!(await this.options.isUp(modelsUrl).catch(() => false))) {
      if (!this.needed) {
        // The task ended while loading. Keep the model loaded for the usual idle time.
        this.idleSince ??= this.now();
      }
      if (this.now() >= deadline) {
        this.options.logger.warn('The coder model did not start in time.');
        this.retryAfter = this.now() + 10 * 60_000;
        await this.restoreEcho(
          swapMode
            ? 'The coder model did not start. Echo’s model is back; trying again in 10 minutes.'
            : 'The coder model did not start; trying again in 10 minutes.',
        );
        return;
      }
      await this.sleep(this.pollMs);
    }
    this.downChecks = 0;
    if (swapMode) {
      await this.setOverride({ server: coder.server, model: coder.alias, exclude: echoId && this.stoppedEcho ? [echoId] : [] });
    }
    this.set(
      'coder-loaded',
      swapMode ? 'The coder model is loaded. Echo’s chat uses it until the tasks are done.' : 'The coder model is loaded next to Echo’s.',
    );
  }

  /** While the coder model is loaded and needed: restart it if it stopped (the PC slept, or it crashed). */
  private async watch(): Promise<void> {
    const server = this.loadedServer;
    if (!server) return;
    if (await this.options.isUp(`${server.url}/models`).catch(() => false)) {
      this.downChecks = 0;
      return;
    }
    this.downChecks += 1;
    if (this.downChecks < 2) return;
    this.options.logger.warn('The coder model stopped answering; starting it again.');
    this.downChecks = 0;
    if (this.override) await this.setOverride(null);
    this.state = { phase: 'idle', message: 'The coder model stopped answering.' };
    this.startedCoder = false;
    await this.swapIn();
  }

  private async swapBack(): Promise<void> {
    await this.restoreEcho(
      this.loadMode === 'swap' ? 'Not needed now. Echo’s model is back.' : 'Not needed now; the coder model was stopped to free memory.',
    );
  }

  /** Stop the coder model (if we started it), start Echo's again (if we stopped it), clear the override. Side by side, Echo's model is never touched. */
  private async restoreEcho(message: string): Promise<void> {
    this.set(
      'swapping-back',
      this.loadMode === 'swap' ? 'Stopping the coder model and starting Echo’s model again.' : 'Stopping the coder model to free memory.',
    );
    if (this.override) await this.setOverride(null);
    if (this.startedCoder) await this.coderControl?.stop().catch(() => false);
    this.startedCoder = false;
    if (this.stoppedEcho) await this.options.echo.start().catch((error) => {
      this.options.logger.warn('Echo’s model could not be started again.', { message: error instanceof Error ? error.message : String(error) });
    });
    this.stoppedEcho = false;
    this.loadedServer = null;
    this.set('idle', message);
  }
}
