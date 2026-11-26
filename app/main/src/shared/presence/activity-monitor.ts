/**
 * "Someone used this PC": polls the system idle time (Electron's `powerMonitor.getSystemIdleTime()`, seconds since
 * the last key or mouse input) and reports each poll that finds the PC in use. Wandering between places uses this
 * to know which PC Kevin sits at. No microphone and no camera are involved, so it is fine for an empty place too.
 *
 * Time and timers come in from outside so the tests can run it without waiting.
 */
export const ACTIVITY_POLL_MS = 15_000;
/** Idle for less than this many seconds counts as "in use right now". */
export const ACTIVE_BELOW_IDLE_SECONDS = 60;

export interface ActivityMonitorOptions {
  /** Seconds since the last input on this PC. A throw or a non-number counts as "not active". */
  idleSeconds: () => number;
  /** Called after each poll that found the PC in use, with the time. */
  onActive: (at: number) => void;
  now?: () => number;
  pollMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  logger?: Pick<Console, 'debug'>;
}

export class ActivityMonitor {
  private handle: unknown = null;
  private lastActiveAt: number | null = null;

  constructor(private readonly options: ActivityMonitorOptions) {}

  /** Polls once now, then every 15 seconds. */
  start(): void {
    if (this.handle !== null) return;
    const set = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = set(() => this.poll(), this.options.pollMs ?? ACTIVITY_POLL_MS);
    (this.handle as { unref?: () => void } | null)?.unref?.();
    this.poll();
  }

  stop(): void {
    if (this.handle === null) return;
    (this.options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)))(this.handle);
    this.handle = null;
  }

  /** When the PC was last seen in use (this PC's clock); null when never. */
  get activeAt(): number | null {
    return this.lastActiveAt;
  }

  poll(): void {
    let idle: number;
    try {
      idle = this.options.idleSeconds();
    } catch (error) {
      this.options.logger?.debug('Could not read the idle time', { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (typeof idle !== 'number' || !Number.isFinite(idle) || idle >= ACTIVE_BELOW_IDLE_SECONDS) return;
    const at = (this.options.now ?? Date.now)();
    this.lastActiveAt = at;
    this.options.onActive(at);
  }
}
