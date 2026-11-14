/**
 * The wake word on a satellite PC. The same openWakeWord worker bija runs, started in this PC's main process, but
 * only while the privacy gate says so:
 *
 *   running  =  (an avatar is in the room and the gate is open)          mic 'live'
 *            or (the room's doorbell is on and every other gate fact is true)  mic 'doorbell'
 *
 * That is exactly `gate.micAllowed || gate.doorbell`. It fails closed: while the gate is shut, the model is still
 * being fetched or anything goes wrong, the worker is not running and a wake that slips through is thrown away.
 *
 * In doorbell mode a wake sends `wake.heard` (model name and score, never audio) so bija calls an avatar over. With
 * an avatar in the room the wake goes to this PC's own page, as on bija.
 *
 * The model: a built-in one ships with the app; a trained one is fetched from bija (`wake-word:model`) every time the
 * worker starts, so the model Kevin picked on bija is the one that listens. Everything Electron-specific comes in
 * from outside, so the tests run it with fakes.
 */
import type { WakeWordConfig } from '../config/config-manager.js';
import { BUILTIN_WAKE_WORD_MODELS } from '../wake-word/open-wake-word.js';
import { WakeWordListeningController } from '../wake-word/listening-controller.js';
import type { WakeWordDetectionEvent } from '../wake-word/types.js';

export type WakeMode = 'live' | 'doorbell';

/** What bija's `wake-word:model` answers: the settings, and for a trained model its file. */
export interface SharedWakeWord {
  /** A built-in model name, or (with `bytes`) the trained model's name. */
  model: string;
  keywordLabel: string;
  threshold: number;
  cooldownMs: number;
  /** The trained model's .onnx file. Absent for a built-in model. */
  bytes?: Uint8Array;
}

interface Detector {
  dispose(): Promise<void>;
}

export interface WakeRunnerDeps {
  /** Asks bija which wake word is picked. Null or a throw means "do not listen". */
  fetchModel: () => Promise<SharedWakeWord | null>;
  /** Keeps a trained model's bytes on this PC and gives the path. */
  storeModel: (name: string, bytes: Uint8Array) => Promise<string>;
  /** Starts the worker (capture begins). `onWake` is called for each detection. */
  start: (config: WakeWordConfig, onWake: (event: WakeWordDetectionEvent) => void) => Detector;
  /** A wake that is allowed through, with the mode the gate was in. */
  onWake: (event: WakeWordDetectionEvent, mode: WakeMode) => void;
  /** Timers, so a test does not wait. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  retryMs?: number;
  logger?: Pick<Console, 'info' | 'warn'>;
}

export const WAKE_RETRY_MS = 30_000;

export class SatelliteWakeRunner {
  private readonly controller: WakeWordListeningController;
  private mode: WakeMode | null = null;
  /** Bumped whenever the gate shuts, so a start that was under way notices and stops. */
  private epoch = 0;
  private starting = false;
  private running = false;
  private retry: unknown = null;

  constructor(private readonly deps: WakeRunnerDeps) {
    this.controller = new WakeWordListeningController((config) => deps.start(config, (event) => this.heard(event)));
  }

  /** The worker is capturing right now (or about to). */
  get isRunning(): boolean {
    return this.running;
  }

  /** The gate changed. `micAllowed` is mode 'live', `doorbell` is mode 'doorbell', neither means the worker must not run. */
  setGate(state: { micAllowed: boolean; doorbell: boolean }): void {
    const mode: WakeMode | null = state.micAllowed ? 'live' : state.doorbell ? 'doorbell' : null;
    this.mode = mode;
    if (!mode) {
      this.epoch += 1;
      this.clearRetry();
      if (this.running || this.starting) {
        this.running = false;
        this.starting = false;
        this.deps.logger?.info('Satellite wake word stopped: the gate is shut');
      }
      // The controller gates events at once and releases the microphone; a failed release is retried by the next off.
      void this.controller.setEnabled(false).catch((error: unknown) => this.deps.logger?.warn('Could not stop the wake word', { message: describe(error) }));
      return;
    }
    if (!this.running && !this.starting) void this.begin();
  }

  private allowed(token: number): boolean {
    return token === this.epoch && this.mode !== null;
  }

  private async begin(): Promise<void> {
    const token = this.epoch;
    this.starting = true;
    try {
      const shared = await this.deps.fetchModel();
      if (!this.allowed(token)) return;
      const config = await this.configFor(shared);
      if (!this.allowed(token)) return;
      if (!config) {
        this.deps.logger?.warn('Satellite wake word: bija gave no usable model; not listening');
        return;
      }
      await this.controller.configure(config);
      if (!this.allowed(token)) return;
      this.running = true;
      // A gate that shuts while the worker starts has already queued its own off behind this on.
      await this.controller.setEnabled(true);
      if (this.allowed(token)) this.deps.logger?.info('Satellite wake word listening', { mode: this.mode, keyword: config.keywordLabel });
    } catch (error) {
      this.deps.logger?.warn('Satellite wake word could not start', { message: describe(error) });
      // Only this start's own state is undone; a newer start (the gate shut and opened again) is left alone.
      if (this.allowed(token)) {
        this.running = false;
        void this.controller.setEnabled(false).catch(() => undefined);
        this.scheduleRetry();
      }
    } finally {
      if (token === this.epoch) this.starting = false;
    }
  }

  /** The worker's config from bija's answer, or null when it cannot be trusted (an unknown built-in name, no file). */
  private async configFor(shared: SharedWakeWord | null): Promise<WakeWordConfig | null> {
    if (!shared) return null;
    const { keywordLabel, threshold, cooldownMs } = shared;
    if (typeof keywordLabel !== 'string' || typeof threshold !== 'number' || typeof cooldownMs !== 'number' || !(threshold > 0 && threshold <= 1) || !(cooldownMs >= 0)) return null;
    if (shared.bytes !== undefined) {
      if (!(shared.bytes instanceof Uint8Array) || shared.bytes.byteLength === 0) return null;
      const model = await this.deps.storeModel(shared.model, shared.bytes);
      return { model, keywordLabel, threshold, cooldownMs };
    }
    if (!(BUILTIN_WAKE_WORD_MODELS as readonly string[]).includes(shared.model)) return null;
    return { model: shared.model, keywordLabel, threshold, cooldownMs };
  }

  private heard(event: WakeWordDetectionEvent): void {
    // The gate shut an instant ago: nothing it hears counts. (The controller also gates by its own flag.)
    if (!this.controller.enabled || !this.mode) return;
    this.deps.onWake(event, this.mode);
  }

  private scheduleRetry(): void {
    this.clearRetry();
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.retry = set(() => {
      this.retry = null;
      if (this.mode && !this.running && !this.starting) void this.begin();
    }, this.deps.retryMs ?? WAKE_RETRY_MS);
    (this.retry as { unref?: () => void } | null)?.unref?.();
  }

  private clearRetry(): void {
    if (this.retry === null) return;
    (this.deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.retry);
    this.retry = null;
  }

  async dispose(): Promise<void> {
    this.epoch += 1;
    this.mode = null;
    this.running = false;
    this.clearRetry();
    await this.controller.dispose();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
