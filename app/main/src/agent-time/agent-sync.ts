/**
 * Tells the workflows service which avatars exist (PUT /v1/agents) so each gets a life workflow. Called at start and
 * whenever the avatar list changes. While the service is not reachable it tries again every 15 s; one warning is logged
 * per run of failures, and one line when it works again.
 */
import type { WorkflowsClient } from './workflows-client.js';

export const AGENT_SYNC_RETRY_MS = 15_000;

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

export interface AgentSyncOptions {
  client: Pick<WorkflowsClient, 'putAgents'>;
  avatars: () => Array<{ id: string; name: string }>;
  retryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  logger?: Logger;
}

export class AgentSync {
  private timer: unknown = null;
  private failing = false;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(private readonly options: AgentSyncOptions) {}

  /** Sync now (and keep retrying until it works). Safe to call often; calls made during a sync are folded into one more. */
  async sync(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.running) {
      this.again = true;
      return false;
    }
    this.running = true;
    try {
      this.clearRetry();
      const agents = this.options.avatars().map(({ id, name }) => ({ id, name }));
      try {
        const result = await this.options.client.putAgents(agents);
        if (this.failing) this.options.logger?.info('Workflows service reached again', { agents: result.agents?.length ?? agents.length });
        else this.options.logger?.info('Agents synced with the workflows service', { agents: agents.map((agent) => agent.id), started: result.started, stopped: result.stopped });
        this.failing = false;
        return true;
      } catch (error) {
        if (!this.failing) {
          this.options.logger?.warn('Workflows service not reachable; will keep trying', { message: error instanceof Error ? error.message : String(error) });
        }
        this.failing = true;
        this.scheduleRetry();
        return false;
      }
    } finally {
      this.running = false;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.sync();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
  }

  private scheduleRetry(): void {
    const set = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      void this.sync();
    }, this.options.retryMs ?? AGENT_SYNC_RETRY_MS);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  private clearRetry(): void {
    if (this.timer === null) return;
    (this.options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
}
