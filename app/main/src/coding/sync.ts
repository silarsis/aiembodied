/**
 * Tells the coding runner what the app knows: the workspaces, the API keys (OpenAI, Anthropic,
 * GitHub) and the model settings. Structured like the memory engine's home-sync.ts.
 *
 * The runner keeps keys in memory only, so it forgets them when it restarts. The app sends
 * everything again when the event stream reconnects (`reset()`), and every minute asks which keys
 * the runner holds. Keys only travel in the request body and are never logged.
 */
import { BUILT_IN_SERVER_IDS, DEFAULT_CODER_MODEL, routeTargets, type ModelRouting } from '../config/model-routing.js';
import { toRunnerWorkspace, type CodingConfig } from './config.js';
import { RunnerError, type CodingRunnerClient, type RunnerKeys, type RunnerSettings } from './runner-client.js';

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

export interface CodingSyncPayload {
  workspaces: Array<Record<string, unknown>>;
  /** A missing key is null: the runner forgets a key it had. */
  keys: Required<RunnerKeys>;
  /** Absent when the coding route has no usable server. */
  settings?: Partial<RunnerSettings>;
}

/** What to send, from the saved coding settings, the coding route and the key store. */
export function buildCodingSyncPayload(
  routing: ModelRouting,
  coding: CodingConfig,
  keyFor: (serverId: string) => string | undefined,
): CodingSyncPayload {
  const key = (id: string) => keyFor(id)?.trim() || null;
  const target = routeTargets(routing, 'coding')[0];
  let settings: Partial<RunnerSettings> | undefined;
  if (target?.server.type === 'chat') {
    const model = target.model?.trim() || DEFAULT_CODER_MODEL;
    settings = { local_llm_url: target.server.url, local_model: model, default_model: { provider: 'local', id: model } };
  } else if (target && (target.server.type === 'openai' || target.server.type === 'anthropic') && target.model?.trim()) {
    // The local model settings stay those of the built-in coder server; only the default changes.
    const local = routing.servers.find((server) => server.id === BUILT_IN_SERVER_IDS.coderLlm);
    settings = {
      ...(local ? { local_llm_url: local.url, local_model: DEFAULT_CODER_MODEL } : {}),
      default_model: { provider: target.server.type, id: target.model.trim() },
    };
  }
  return {
    workspaces: coding.workspaces.map(toRunnerWorkspace),
    keys: { openai: key(BUILT_IN_SERVER_IDS.openai), anthropic: key(BUILT_IN_SERVER_IDS.anthropic), github: key(BUILT_IN_SERVER_IDS.github) },
    ...(settings ? { settings } : {}),
  };
}

export interface CodingSyncOptions {
  client: Pick<CodingRunnerClient, 'putWorkspaces' | 'putKeys' | 'putSettings' | 'getKeys'>;
  logger: Logger;
  /** How long to wait before trying again while the runner is down. */
  retryMs?: number;
  /** How often to check that the runner still has the keys. */
  checkMs?: number;
}

type Part = 'workspaces' | 'keys' | 'settings';

export class CodingSync {
  /** What the runner has, per part, as last sent. */
  private sent: Partial<Record<Part, string>> = {};
  private wanted: CodingSyncPayload | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> = Promise.resolve();
  private unreachable = false;
  private stopped = false;
  /** Why the runner refused the workspaces last time (such as a folder that is not a git repository). */
  workspaceError: string | null = null;
  private readonly retryMs: number;
  private readonly checkMs: number;

  constructor(private readonly options: CodingSyncOptions) {
    this.retryMs = options.retryMs ?? 15_000;
    this.checkMs = options.checkMs ?? 60_000;
  }

  /** Make the runner have this. Repeating what it already has sends nothing. */
  apply(payload: CodingSyncPayload): Promise<void> {
    this.wanted = payload;
    this.clearRetry();
    this.startChecking();
    this.running = this.running.then(() => this.send());
    return this.running;
  }

  /** The runner (re)started and has forgotten things: send it all again. */
  reset(): Promise<void> {
    this.sent = {};
    if (!this.wanted) return this.running;
    return this.apply(this.wanted);
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
    const wanted = this.wanted;
    if (this.stopped || !wanted) return;
    try {
      const held = await this.options.client.getKeys();
      const lost =
        this.unreachable || (Object.entries(wanted.keys) as Array<[keyof RunnerKeys, string | null]>).some(([name, value]) => Boolean(value) && !held[name]);
      this.unreachable = false;
      if (lost) {
        this.options.logger.info('The coding runner lost its keys; sending them again.');
        this.sent = {};
        await this.send();
      }
    } catch (error) {
      // Down now; when it answers again it will have restarted and forgotten the keys.
      this.unreachable = true;
      this.options.logger.warn('The coding runner did not answer the key check.', { message: errorMessage(error) });
    }
  }

  private async send(): Promise<void> {
    const wanted = this.wanted;
    if (this.stopped || !wanted) return;
    const parts: Array<[Part, unknown, () => Promise<unknown>]> = [
      ...(wanted.settings ? ([['settings', wanted.settings, () => this.options.client.putSettings(wanted.settings as Partial<RunnerSettings>)]] as Array<[Part, unknown, () => Promise<unknown>]>) : []),
      ['workspaces', wanted.workspaces, () => this.options.client.putWorkspaces(wanted.workspaces)],
      ['keys', wanted.keys, () => this.options.client.putKeys(wanted.keys)],
    ];
    let retry = false;
    for (const [part, value, send] of parts) {
      const signature = JSON.stringify(value);
      if (this.sent[part] === signature) continue;
      try {
        await send();
        this.sent[part] = signature;
        this.unreachable = false;
        if (part === 'workspaces') this.workspaceError = null;
        // Counts only: keys and tokens are never logged.
        this.options.logger.info('Coding runner updated.', {
          part,
          ...(part === 'workspaces' ? { workspaces: wanted.workspaces.length } : {}),
          ...(part === 'keys' ? { keys: Object.values(wanted.keys).filter(Boolean).length } : {}),
        });
      } catch (error) {
        const refused = error instanceof RunnerError && error.status !== undefined && error.status < 500;
        if (refused) {
          // The runner understood and said no: sending the same again would not help.
          this.sent[part] = signature;
          if (part === 'workspaces') this.workspaceError = errorMessage(error);
          this.options.logger.warn(`The coding runner refused the ${part}.`, { message: errorMessage(error) });
        } else {
          retry = true;
          this.unreachable = true;
          this.options.logger.warn(`The coding runner is not ready for the ${part}; will retry.`, { message: errorMessage(error) });
        }
      }
    }
    if (retry && !this.stopped) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.apply(this.wanted ?? wanted);
      }, this.retryMs);
      this.retryTimer.unref?.();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
