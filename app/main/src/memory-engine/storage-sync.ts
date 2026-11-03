/**
 * Tells the memory engine which database to keep memory in and which (if any) to mirror it to,
 * from the Models and servers pop-up's "Memory" and "Memory mirror" choices.
 *
 * The app owns this choice; the engine saves it so it starts on the same database next time.
 * Passwords live in the app's key store and only travel to the engine, inside the address.
 */
import {
  BUILT_IN_SERVER_IDS,
  databaseUrlWithPassword,
  type ModelRouting,
} from '../config/model-routing.js';
import { MemoryEngineError, type MemoryEngineClient } from './client.js';

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

export interface MemoryStorageTargets {
  /** Null: the engine's own database on this PC. */
  database: string | null;
  /** Null: no mirror. */
  mirror: string | null;
}

export function memoryStorageTargets(routing: ModelRouting, keyFor: (serverId: string) => string | undefined): MemoryStorageTargets {
  const address = (serverId: string | undefined): string | null => {
    if (!serverId || serverId === BUILT_IN_SERVER_IDS.memory) return null;
    const server = routing.servers.find((entry) => entry.id === serverId && entry.type === 'memory');
    return server ? databaseUrlWithPassword(server.url, keyFor(server.id)) : null;
  };
  // This PC's database can't be the mirror: the engine is the only one that knows its address.
  return { database: address(routing.routes.memory?.server), mirror: address(routing.routes.memorymirror?.server) };
}

export interface MemoryStorageSyncOptions {
  client: Pick<MemoryEngineClient, 'setStorage'>;
  logger: Logger;
  /** How long to wait before trying again while the engine is down or starting. */
  retryMs?: number;
}

/** Sends the targets to the engine, and keeps trying until it has taken them. */
export class MemoryStorageSync {
  private sent: string | null = null;
  private wanted: MemoryStorageTargets | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly retryMs: number;

  constructor(private readonly options: MemoryStorageSyncOptions) {
    this.retryMs = options.retryMs ?? 15_000;
  }

  /** Make the engine use these. Repeating what it already has sends nothing. */
  apply(targets: MemoryStorageTargets): Promise<void> {
    this.wanted = targets;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = (this.running ?? Promise.resolve()).then(() => this.send());
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async send(): Promise<void> {
    const targets = this.wanted;
    if (!targets || this.stopped) return;
    const signature = JSON.stringify(targets);
    if (signature === this.sent) return;
    try {
      const view = await this.options.client.setStorage(targets);
      this.sent = signature;
      this.options.logger.info('Memory storage set.', {
        database: view.database.where,
        mirror: view.mirror?.where ?? null,
        moving: view.moving,
      });
    } catch (error) {
      const retryable = !(error instanceof MemoryEngineError) || error.retryable;
      this.options.logger.warn(retryable ? 'Memory engine not ready for the storage setting; will retry.' : 'Memory engine refused the storage setting.', {
        message: error instanceof Error ? error.message : String(error),
      });
      if (retryable && !this.stopped) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.apply(this.wanted ?? targets);
        }, this.retryMs);
        this.timer.unref?.();
      }
    }
  }
}
