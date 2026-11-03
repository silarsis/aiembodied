/**
 * A queue of writes for the memory engine, kept in the app's SQLite database. Turns are
 * written here first and sent in order, so nothing is lost while the engine or its database
 * is down: the queue drains when it comes back.
 */
import type { MemoryOutboxEntry } from '../memory/memory-store.js';
import {
  MemoryEngineError,
  type MemoryEngineClient,
  type MemoryEngineFact,
  type MemoryEngineMessage,
  type MemoryEngineSession,
} from './client.js';

export type OutboxItem =
  | { kind: 'session'; id: string; session: MemoryEngineSession }
  | { kind: 'message'; message: MemoryEngineMessage }
  | { kind: 'fact'; id: string; fact: MemoryEngineFact };

export interface OutboxStore {
  enqueueMemoryOutbox(kind: string, payload: unknown, createdAt?: number): number;
  listMemoryOutbox(limit?: number): MemoryOutboxEntry[];
  countMemoryOutbox(): number;
  deleteMemoryOutbox(ids: readonly number[]): void;
  markMemoryOutboxFailed(ids: readonly number[], error: string): void;
}

type Logger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

export interface MemoryOutboxOptions {
  store: OutboxStore;
  client: Pick<MemoryEngineClient, 'putSession' | 'postMessages' | 'putFact'>;
  logger?: Logger;
  /** How many queued entries one flush sends at most. */
  batchSize?: number;
  /** Wait after a failed flush, doubling up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Wait after a write before flushing, so a turn's messages go together. */
  debounceMs?: number;
}

const MESSAGE_BATCH = 100;

export class MemoryOutbox {
  private readonly store: OutboxStore;

  private readonly client: MemoryOutboxOptions['client'];

  private readonly logger?: Logger;

  private readonly batchSize: number;

  private readonly retryMs: number;

  private readonly maxRetryMs: number;

  private readonly debounceMs: number;

  private timer: NodeJS.Timeout | null = null;

  private flushing: Promise<void> | null = null;

  private failures = 0;

  private stopped = false;

  private lastError: string | null = null;

  constructor(options: MemoryOutboxOptions) {
    this.store = options.store;
    this.client = options.client;
    this.logger = options.logger;
    this.batchSize = options.batchSize ?? 500;
    this.retryMs = options.retryMs ?? 5000;
    this.maxRetryMs = options.maxRetryMs ?? 5 * 60_000;
    this.debounceMs = options.debounceMs ?? 250;
  }

  enqueue(item: OutboxItem): void {
    if (item.kind === 'session') {
      this.store.enqueueMemoryOutbox('session', { id: item.id, session: item.session });
    } else if (item.kind === 'fact') {
      this.store.enqueueMemoryOutbox('fact', { id: item.id, fact: item.fact });
    } else {
      this.store.enqueueMemoryOutbox('message', item.message);
    }
    if (this.failures === 0) {
      this.schedule(this.debounceMs);
    }
  }

  /** Start draining whatever was left from last time. */
  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): { pending: number; failing: boolean; lastError: string | null } {
    return { pending: this.store.countMemoryOutbox(), failing: this.failures > 0, lastError: this.lastError };
  }

  /** Send everything queued. Resolves when the queue is empty or a send fails. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    for (;;) {
      const entries = this.store.listMemoryOutbox(this.batchSize);
      if (entries.length === 0) {
        if (this.failures > 0) {
          this.logger?.info('Memory engine reachable again; queued writes sent');
        }
        this.failures = 0;
        this.lastError = null;
        return;
      }
      try {
        await this.send(entries);
      } catch (error) {
        this.failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (this.failures === 1 || message !== this.lastError) {
          this.logger?.warn('Memory engine write failed; will retry', { message, pending: this.store.countMemoryOutbox() });
        }
        this.lastError = message;
        const delay = Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(this.failures - 1, 10));
        this.schedule(delay);
        return;
      }
    }
  }

  /** Send entries in queue order: sessions one by one, runs of messages in batches. */
  private async send(entries: MemoryOutboxEntry[]): Promise<void> {
    let index = 0;
    while (index < entries.length) {
      const entry = entries[index];
      if (entry.kind === 'message') {
        const run: MemoryOutboxEntry[] = [];
        while (index < entries.length && entries[index].kind === 'message' && run.length < MESSAGE_BATCH) {
          run.push(entries[index]);
          index += 1;
        }
        await this.attempt(run, () => this.client.postMessages(run.map((e) => e.payload as MemoryEngineMessage)));
      } else if (entry.kind === 'session') {
        const { id, session } = entry.payload as { id: string; session: MemoryEngineSession };
        await this.attempt([entry], () => this.client.putSession(id, session));
        index += 1;
      } else if (entry.kind === 'fact') {
        const { id, fact } = entry.payload as { id: string; fact: MemoryEngineFact };
        await this.attempt([entry], () => this.client.putFact(id, fact));
        index += 1;
      } else {
        this.logger?.warn('Dropping unknown memory outbox entry', { kind: entry.kind });
        this.store.deleteMemoryOutbox([entry.id]);
        index += 1;
      }
    }
  }

  private async attempt(entries: MemoryOutboxEntry[], call: () => Promise<unknown>): Promise<void> {
    const ids = entries.map((entry) => entry.id);
    try {
      await call();
    } catch (error) {
      if (error instanceof MemoryEngineError && !error.retryable) {
        // The engine refused these as malformed. Retrying would block the queue forever.
        this.logger?.warn('Memory engine refused queued writes; dropping them', { count: ids.length, message: error.message });
        this.store.deleteMemoryOutbox(ids);
        return;
      }
      this.store.markMemoryOutboxFailed(ids, error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.store.deleteMemoryOutbox(ids);
  }
}
