import { ACTIVITY_POLL_MS } from '../../../main/src/presence/activity-monitor.js';

export interface PageActivityOptions {
  /** Is the page visible, and the shell (if any) in the foreground? A hidden page is not being used. */
  isForeground: () => boolean;
  /** Sends `presence {activeAt}` to bija. False when the link is down (then the report is tried again soon). */
  send: (at: number) => boolean;
  now?: () => number;
  /** At most one report per this long (the desktop's activity signal polls every 15 seconds). */
  throttleMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * "Someone is using this page", for wandering and urgent news (docs/features/places.md). On the desktop it is the
 * system idle time; a page has no such thing, so opening the app counts: a report goes out while the page is in the
 * foreground (once at start, then every 15 seconds) and on any touch or key, throttled to one per 15 seconds. Nothing
 * is sent while the page is hidden. bija stamps the report with its own clock when it arrives.
 */
export class PageActivity {
  private lastSentAt: number | null = null;
  private handle: unknown = null;

  constructor(private readonly options: PageActivityOptions) {}

  /** A touch, a key, or the page coming to the front. */
  note(): void {
    if (!this.options.isForeground()) return;
    const now = (this.options.now ?? Date.now)();
    if (this.lastSentAt !== null && now - this.lastSentAt < (this.options.throttleMs ?? ACTIVITY_POLL_MS)) return;
    if (this.options.send(now)) this.lastSentAt = now;
  }

  /** Reports now, then every 15 seconds while the page is in the foreground. */
  start(): void {
    if (this.handle !== null) return;
    const set = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = set(() => this.note(), this.options.throttleMs ?? ACTIVITY_POLL_MS);
    this.note();
  }

  stop(): void {
    if (this.handle === null) return;
    (this.options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)))(this.handle);
    this.handle = null;
  }
}
