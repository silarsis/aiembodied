/**
 * Tells the memory engine which Home Assistant servers to watch, from the "Home Assistant"
 * servers added in the Models and servers pop-up.
 *
 * The app owns the list and the tokens (in the key store). The engine keeps tokens in memory
 * only, so it forgets them when it restarts: every minute the app asks which homes the engine
 * has and sends the list again when one is missing. Tokens only travel in the request body and
 * are never logged.
 */
import type { ModelRouting } from '../config/model-routing.js';
import { MemoryEngineError, type MemoryEngineClient, type MemoryEngineHomeServer } from './client.js';

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

/** The Home Assistant servers that have a token. One without a token has nothing to connect with. */
export function homeServersFor(routing: ModelRouting, keyFor: (serverId: string) => string | undefined): MemoryEngineHomeServer[] {
  const servers: MemoryEngineHomeServer[] = [];
  for (const server of routing.servers) {
    if (server.type !== 'homeassistant') continue;
    const token = keyFor(server.id)?.trim();
    if (!token) continue;
    servers.push({ id: server.id, name: server.name, url: server.url, token });
  }
  return servers;
}

export interface HomeServerSyncOptions {
  client: Pick<MemoryEngineClient, 'setHomeServers' | 'homeStatus'>;
  logger: Logger;
  /** How long to wait before trying again while the engine is down or starting. */
  retryMs?: number;
  /** How often to check that the engine still has the servers. */
  checkMs?: number;
}

export class HomeServerSync {
  /** What the engine has, as last sent. Starts as the empty list: a fresh engine has no app homes. */
  private sent = '[]';
  private wanted: MemoryEngineHomeServer[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> = Promise.resolve();
  private engineUnreachable = false;
  private stopped = false;
  private readonly retryMs: number;
  private readonly checkMs: number;

  constructor(private readonly options: HomeServerSyncOptions) {
    this.retryMs = options.retryMs ?? 15_000;
    this.checkMs = options.checkMs ?? 60_000;
  }

  /** Make the engine watch these. Repeating what it already has sends nothing. */
  apply(servers: MemoryEngineHomeServer[]): Promise<void> {
    this.wanted = servers;
    this.clearRetry();
    this.startChecking();
    this.running = this.running.then(() => this.send());
    return this.running;
  }

  /** One round of the periodic check; public so tests need no timers. */
  check(): Promise<void> {
    this.running = this.running.then(() => this.verify());
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  private startChecking(): void {
    if (this.checkTimer || this.stopped) return;
    this.checkTimer = setInterval(() => void this.check(), this.checkMs);
    this.checkTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async verify(): Promise<void> {
    if (this.stopped || this.wanted.length === 0 || this.sent !== JSON.stringify(this.wanted)) return;
    try {
      const homes = await this.options.client.homeStatus();
      const known = new Set(homes.map((home) => home.id));
      const lost = this.engineUnreachable || this.wanted.some((server) => !known.has(server.id));
      this.engineUnreachable = false;
      if (lost) {
        this.options.logger.info('Memory engine lost the Home Assistant servers; sending them again.');
        this.sent = '[]';
        await this.send();
      }
    } catch (error) {
      // Down now; when it answers again it will have restarted and forgotten the tokens.
      this.engineUnreachable = true;
      this.options.logger.warn('Memory engine did not answer the Home Assistant check.', { message: errorMessage(error) });
    }
  }

  private async send(): Promise<void> {
    if (this.stopped) return;
    const servers = this.wanted;
    const signature = JSON.stringify(servers);
    if (signature === this.sent) return;
    try {
      const homes = await this.options.client.setHomeServers(servers);
      this.sent = signature;
      this.engineUnreachable = false;
      this.options.logger.info('Home Assistant servers set.', { servers: servers.length, homes: homes.length });
    } catch (error) {
      const retryable = !(error instanceof MemoryEngineError) || error.retryable;
      this.options.logger.warn(
        retryable ? 'Memory engine not ready for the Home Assistant servers; will retry.' : 'Memory engine refused the Home Assistant servers.',
        { message: errorMessage(error) },
      );
      if (retryable && !this.stopped) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.apply(this.wanted);
        }, this.retryMs);
        this.retryTimer.unref?.();
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
