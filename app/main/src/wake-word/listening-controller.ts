import type { WakeWordConfig } from '../config/config-manager.js';

interface Detector {
  dispose(): Promise<void>;
}

/** Main owns capture. An off request gates events immediately and awaits microphone release. */
export class WakeWordListeningController {
  private requested = false;
  private disposed = false;
  private config: WakeWordConfig | null = null;
  private active: { key: string; detector: Detector } | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly start: (config: WakeWordConfig) => Detector) {}

  get enabled(): boolean {
    return this.requested && !this.disposed;
  }

  configure(config: WakeWordConfig): Promise<void> {
    this.config = { ...config };
    return this.enqueue(() => this.reconcile());
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed && enabled) return Promise.reject(new Error('Listening has shut down.'));
    this.requested = enabled;
    // Every explicit off must release capture, even if an on arrives before it finishes.
    return this.enqueue(() => (enabled ? this.reconcile() : this.stop()));
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.requested = false;
    return this.enqueue(() => this.stop());
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const operation = this.pending.then(action);
    // Return failures to the caller without poisoning subsequent stop/retry operations.
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    // Retain the detector after a failed shutdown so a subsequent stop retries it.
    await active.detector.dispose();
    if (this.active === active) this.active = null;
  }

  private async reconcile(): Promise<void> {
    if (!this.enabled) return this.stop();
    if (!this.config) throw new Error('Wake-word configuration is not ready.');
    if (this.active?.key === JSON.stringify(this.config)) return;
    await this.stop();
    if (!this.enabled || !this.config) return;
    const config = { ...this.config };
    this.active = { key: JSON.stringify(config), detector: this.start(config) };
  }
}
