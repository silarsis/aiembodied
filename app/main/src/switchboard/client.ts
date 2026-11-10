/**
 * Publishes events to the switchboard (services/switchboard). Fetch only.
 *
 * publish() is synchronous and never throws: the event goes into an in-memory queue and a timer
 * sends it in batches, so a voice turn never waits on the switchboard, or notices it is down.
 * While it is unreachable the queue is kept in order (the oldest are dropped past maxQueue) and
 * sending is retried with a growing pause. The id and time are set here, so a later event can
 * name this one as its cause before the server has answered.
 */
import { randomBytes } from 'node:crypto';
import type { SwitchboardEvent, SwitchboardEventInput, SwitchboardHealth } from './types.js';

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BATCH_SIZE = 100;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5000;

/** A 26 character id: 10 characters of millisecond time then 16 random ones, Crockford base32, so ids sort by time. */
export function makeEventId(time: number): string {
  let rest = Math.max(0, Math.floor(time));
  let stamp = '';
  for (let i = 0; i < 10; i += 1) {
    stamp = CROCKFORD[rest % 32] + stamp;
    rest = Math.floor(rest / 32);
  }
  const bytes = randomBytes(16);
  let random = '';
  for (const byte of bytes) random += CROCKFORD[byte % 32];
  return stamp + random;
}

export interface SwitchboardClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** How long to gather events before sending. */
  flushMs?: number;
  maxQueue?: number;
  now?: () => number;
}

export class SwitchboardClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger?: Logger;
  private readonly flushMs: number;
  private readonly maxQueue: number;
  private readonly now: () => number;
  private queue: SwitchboardEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private stopped = false;
  private backoff = 0;
  private down = false;
  private dropped = 0;

  constructor(options: SwitchboardClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger;
    this.flushMs = options.flushMs ?? 200;
    this.maxQueue = options.maxQueue ?? 1000;
    this.now = options.now ?? Date.now;
  }

  /** Queue an event and return it with its id and time. Never throws, never waits on the network. */
  publish(input: SwitchboardEventInput): SwitchboardEvent | null {
    try {
      if (this.stopped) return null;
      const time = this.now();
      const event: SwitchboardEvent = {
        ...input,
        id: input.id ?? makeEventId(time),
        v: 1,
        at: input.at ?? new Date(time).toISOString(),
        to: input.to ?? [],
        payload: input.payload ?? {},
      };
      this.queue.push(event);
      if (this.queue.length > this.maxQueue) {
        const over = this.queue.length - this.maxQueue;
        this.queue.splice(0, over);
        this.dropped += over;
      }
      this.schedule(this.backoff || this.flushMs);
      return event;
    } catch (error) {
      this.logger?.warn('Switchboard: could not queue an event', { message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /** Events waiting to be sent. */
  pending(): number {
    return this.queue.length;
  }

  /** Whether the last attempt to send failed. */
  isDown(): boolean {
    return this.down;
  }

  async health(): Promise<SwitchboardHealth | null> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) return null;
      return (await response.json()) as SwitchboardHealth;
    } catch {
      return null;
    }
  }

  /** Send what is queued, once, best effort, and stop taking events. */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopped = true;
    await this.flush();
  }

  private schedule(delay: number): void {
    if (this.timer || this.sending || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, BATCH_SIZE);
        const response = await this.fetchFn(`${this.baseUrl}/v1/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          // The server read it and refused it (for example a payload that is too big): retrying will not help.
          if (response.status >= 400 && response.status < 500) {
            this.logger?.warn('Switchboard: batch rejected and dropped', { status: response.status, events: batch.length });
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        }
        // Events may have been dropped from the front while sending; remove only the ones that went.
        const sent = new Set(batch.map((event) => event.id));
        this.queue = this.queue.filter((event) => !sent.has(event.id));
        this.recovered();
      }
    } catch (error) {
      this.failed(error);
    } finally {
      this.sending = false;
      if (this.queue.length > 0 && !this.stopped) this.schedule(this.backoff || this.flushMs);
    }
  }

  private failed(error: unknown): void {
    this.backoff = this.backoff ? Math.min(this.backoff * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
    if (!this.down) {
      this.down = true;
      this.logger?.warn('Switchboard unreachable; events are kept and retried', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private recovered(): void {
    this.backoff = 0;
    if (this.down) {
      this.down = false;
      this.logger?.info('Switchboard reachable again', { dropped: this.dropped });
      this.dropped = 0;
    }
  }
}
