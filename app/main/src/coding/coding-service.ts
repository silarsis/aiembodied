/**
 * Everything the app does for the coding runner, in one place: follow its event stream, keep it
 * supplied with workspaces, keys and settings (sync.ts), and swap the local models when a task
 * needs the coder model (model-swap.ts).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelRouting, ModelServer, RouteOverride } from '../config/model-routing.js';
import { BUILT_IN_SERVER_IDS } from '../config/model-routing.js';
import { readCommitHeadroom } from '../diagnostics/commit-memory.js';
import type { GpuMemoryReader } from '../diagnostics/gpu-memory.js';
import type { LocalLlmControl } from '../local-voice/local-llm-control.js';
import type { CodingConfig } from './config.js';
import { findCoderGguf } from './gguf-finder.js';
import { CoderModelSwap, type SwapState } from './model-swap.js';
import { CodingRunnerClient, type RunnerCapabilities, type RunnerEvent } from './runner-client.js';
import { buildCodingSyncPayload, CodingSync } from './sync.js';

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

export interface CodingStatus {
  runnerUp: boolean;
  runnerUrl: string | null;
  localModelNeeded: boolean;
  swap: SwapState;
  /** The GGUF found on this PC when none is picked. */
  detectedGguf: string | null;
  /** Why the runner refused the workspaces, if it did. */
  workspaceError: string | null;
}

/** What the Coding page shows. */
export interface CodingView {
  coding: CodingConfig;
  /** The runner server in use (the saved one, or the built-in one if that is gone). */
  runnerId: string | null;
  status: CodingStatus;
}

export interface CodingServiceOptions {
  settings: () => { models: ModelRouting; coding: CodingConfig };
  keyFor: (serverId: string) => string | undefined;
  echoControl: Pick<LocalLlmControl, 'stop' | 'start'>;
  coderControl: (model: { path: string; alias: string; contextLength: number }, baseUrl: string) => Pick<LocalLlmControl, 'stop' | 'start'>;
  /** Rebuild Echo's engines: the chat override changed. */
  onOverrideChange: () => void | Promise<void>;
  logger: Logger;
  /** Reads GPU memory, for auto mode. Without it only the Windows commit headroom is measured. */
  gpuMemory?: Pick<GpuMemoryReader, 'read'>;
  /** Tell Echo something (the nudge path): used when a task has to wait for a quiet moment. */
  notify?: (text: string, options: { urgent: boolean }) => void;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  platform?: string;
}

export class CodingService {
  readonly swap: CoderModelSwap;
  private client: CodingRunnerClient | null = null;
  private sync: CodingSync | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly eventListeners = new Set<(event: RunnerEvent) => void>();
  private runnerUp = false;
  private needed = false;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: CodingServiceOptions) {
    this.env = options.env ?? process.env;
    const backSeconds = Number.parseFloat(this.env.CODER_SWAP_BACK_S ?? '');
    const quietSeconds = Number.parseFloat(this.env.CODER_QUIET_S ?? '');
    const idleStopSeconds = Number.parseFloat(this.env.CODER_IDLE_STOP_S ?? '');
    this.swap = new CoderModelSwap({
      routing: () => options.settings().models,
      configuredGguf: () => options.settings().coding.coderGguf,
      detectGguf: () => this.detectGguf(),
      echo: options.echoControl,
      coder: options.coderControl,
      isUp: (url) => this.answers(url),
      onOverrideChange: options.onOverrideChange,
      logger: options.logger,
      platform: options.platform,
      mode: () => options.settings().coding.coderMemory ?? 'auto',
      measureFree: () => this.measureFree(),
      ggufSize,
      onWaiting: () =>
        options.notify?.(
          'The coding task is waiting: not enough memory to run the coder model next to yours. It will start when things are quiet.',
          { urgent: false },
        ),
      ...(Number.isFinite(quietSeconds) && quietSeconds >= 0 ? { quietMs: quietSeconds * 1000 } : {}),
      ...(Number.isFinite(idleStopSeconds) && idleStopSeconds >= 0 ? { idleStopMs: idleStopSeconds * 1000 } : {}),
      ...(Number.isFinite(backSeconds) && backSeconds >= 0 ? { swapBackMs: backSeconds * 1000 } : {}),
    });
  }

  /** CODER_LLM_GGUF, else the first Qwen3-Coder-Next Q4_K_M file in the usual places. */
  detectGguf(): string | null {
    return this.env.CODER_LLM_GGUF?.trim() || findCoderGguf({ env: this.env });
  }

  /** The client for the runner in use, or null before the first apply(). */
  runnerClient(): CodingRunnerClient | null {
    return this.client;
  }

  /** Every message of the runner's event stream (task changes), as it arrives. Returns a function that stops listening. */
  onRunnerEvent(listener: (event: RunnerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Kevin spoke to Echo (not a system update). */
  noteActivity(): void {
    void this.swap.noteActivity();
  }

  chatOverride(): RouteOverride | null {
    return this.swap.chatOverride();
  }

  /** The runner server the coding settings point at: the built-in one if the saved choice is gone. */
  runnerServer(): ModelServer | undefined {
    const { models, coding } = this.options.settings();
    return (
      models.servers.find((server) => server.id === coding.runner && server.type === 'coder') ??
      models.servers.find((server) => server.id === BUILT_IN_SERVER_IDS.coderRunner)
    );
  }

  /** Follow the settings: connect to the runner, send it what it needs, look at the swap again. */
  async apply(): Promise<void> {
    const server = this.runnerServer();
    if (!server) return;
    if (!this.client || this.client.baseUrl !== server.url) this.connect(server.url);
    const { models, coding } = this.options.settings();
    await this.sync?.apply(buildCodingSyncPayload(models, coding, this.options.keyFor));
    void this.swap.refresh();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sync?.stop();
    this.swap.stop();
  }

  status(): CodingStatus {
    return {
      runnerUp: this.runnerUp,
      runnerUrl: this.client?.baseUrl ?? null,
      localModelNeeded: this.needed,
      swap: this.swap.getState(),
      detectedGguf: this.detectGguf(),
      workspaceError: this.sync?.workspaceError ?? null,
    };
  }

  /** The runner's detected checks for a workspace (it has to have been sent to the runner first). */
  async suggestChecks(workspaceId: string): Promise<string | null> {
    if (!this.client) return null;
    const capabilities: RunnerCapabilities = await this.client.capabilities(true);
    return capabilities.workspaces?.find((entry) => entry.id === workspaceId)?.detected?.checks_suggestion ?? null;
  }

  private connect(url: string): void {
    this.unsubscribe?.();
    this.sync?.stop();
    const client = new CodingRunnerClient({ baseUrl: url, fetchFn: this.options.fetchFn });
    this.client = client;
    this.sync = new CodingSync({ client, logger: this.options.logger });
    this.runnerUp = false;
    const down = () => {
      if (this.client !== client) return;
      this.runnerUp = false;
      this.setNeeded(false);
    };
    this.unsubscribe = client.subscribe({
      onOpen: () => {
        if (this.client !== client) return;
        this.runnerUp = true;
        this.options.logger.info('Connected to the coding runner.', { url });
        // A runner that just started has forgotten the keys.
        void this.sync?.reset();
        void client.status().then((status) => this.setNeeded(status.local_model_needed), () => undefined);
      },
      onEvent: (event) => {
        if (this.client !== client) return;
        if (typeof event.local_model_needed === 'boolean') this.setNeeded(event.local_model_needed);
        for (const listener of this.eventListeners) {
          try {
            listener(event);
          } catch (error) {
            this.options.logger.warn('A coding event listener failed.', { message: error instanceof Error ? error.message : String(error) });
          }
        }
      },
      onClose: down,
      onError: down,
    });
  }

  private setNeeded(needed: boolean): void {
    this.needed = needed;
    void this.swap.setNeeded(needed);
  }

  /** Free memory for the coder: the smaller of free GPU memory and Windows commit headroom; null when neither is known. */
  private async measureFree(): Promise<number | null> {
    const platform = (this.options.platform ?? process.platform) as NodeJS.Platform;
    const snapshot = await this.options.gpuMemory?.read([]).catch(() => null);
    let gpu: number | null = null;
    if (snapshot?.supported && (snapshot.dedicatedTotal !== null || snapshot.sharedTotal !== null)) {
      gpu = (snapshot.dedicatedTotal ?? 0) + (snapshot.sharedTotal ?? 0) - snapshot.used.dedicated - snapshot.used.shared;
    }
    const commit = await readCommitHeadroom({ platform });
    const known = [gpu, commit].filter((value): value is number => value !== null);
    return known.length ? Math.min(...known) : null;
  }

  private async answers(url: string): Promise<boolean> {
    try {
      const response = await (this.options.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/** Size of the GGUF on disk. A split file (name-00001-of-00003.gguf) counts all its parts. */
async function ggufSize(file: string): Promise<number | null> {
  try {
    const split = /^(.*-)(\d+)-of-(\d+)(\.gguf)$/i.exec(path.basename(file));
    if (!split) return (await fs.stat(file)).size;
    const count = Number(split[3]);
    let total = 0;
    for (let part = 1; part <= count; part += 1) {
      const name = `${split[1]}${String(part).padStart(split[2].length, '0')}-of-${split[3]}${split[4]}`;
      total += (await fs.stat(path.join(path.dirname(file), name))).size;
    }
    return total;
  } catch {
    return null;
  }
}
