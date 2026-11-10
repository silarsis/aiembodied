/**
 * Runs this PC's vision llama-server (Qwen3-VL, port 1237) only while a job needs it. The main
 * language model already holds most of the unified memory, so the small vision model is started on
 * demand and stopped again after a quiet spell.
 *
 *   await server.ensureRunning();  // starts it if needed and waits until it answers
 *   ...call the model...
 *   server.release();              // the idle timer (10 min) stops it when no job is left
 *
 * Callers that start at the same time share one start. A server that already answers is used as is
 * and left running; only one this class started is stopped. The pid file `vision.pid` in the logs
 * folder lets ServerManager stop the process when the app quits.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isLocalUrl, routeTargets, type ModelRouting, type ModelServer, type UseId } from '../config/model-routing.js';
import type { VisionPick } from './vision-model.js';

export const MISSING_VISION_MODEL = 'Download the vision model in Models and servers → Describe the avatar first.';
const IDLE_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 180_000;
const POLL_MS = 1500;

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface VisionServerOptions {
  /** The vision server's address, or null when nothing local should be started. */
  baseUrl: () => string | null;
  pick: () => Promise<VisionPick | null>;
  repoRoot: string;
  logDirectory: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  fetchFn?: typeof fetch;
  /** Starts a PowerShell command that outlives the app (default: spawn powershell.exe). */
  launch?: (command: string) => void;
  /** Stops the llama-server on the port (default: none; main.ts passes LocalLlmControl.stop). */
  stop: () => Promise<unknown>;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  idleMs?: number;
  readyTimeoutMs?: number;
  pollMs?: number;
  logger?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
}

export class VisionServer {
  private starting: Promise<void> | null = null;
  private jobs = 0;
  private idleTimer: unknown = null;
  /** True when this class launched the running server, so it is the one to stop. */
  private owned = false;

  constructor(private readonly options: VisionServerOptions) {}

  private get fetchFn(): typeof fetch {
    return this.options.fetchFn ?? fetch;
  }

  private get platform(): string {
    return this.options.platform ?? process.platform;
  }

  /** Jobs between ensureRunning and release. */
  get activeJobs(): number {
    return this.jobs;
  }

  private async answers(base: string, route: 'health' | 'models'): Promise<boolean> {
    const url = route === 'health' ? `${new URL(base).origin}/health` : `${base.replace(/\/+$/, '')}/models`;
    try {
      const response = await this.fetchFn(url, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async ready(base: string): Promise<boolean> {
    return (await this.answers(base, 'health')) || (await this.answers(base, 'models'));
  }

  /** Make sure the server answers, starting it if it doesn't. Pair every success with release(). */
  async ensureRunning(): Promise<void> {
    this.clearIdle();
    this.jobs += 1;
    try {
      await (this.starting ??= this.startOnce().finally(() => {
        this.starting = null;
      }));
    } catch (error) {
      this.jobs -= 1;
      if (this.jobs === 0) this.armIdle();
      throw error;
    }
  }

  /** A job is done; with none left, the server stops after ten quiet minutes. */
  release(): void {
    if (this.jobs > 0) this.jobs -= 1;
    if (this.jobs === 0) this.armIdle();
  }

  /** Stop the server now (the app is closing, or the idle time is up). */
  async shutdown(): Promise<void> {
    this.clearIdle();
    if (!this.owned) return;
    this.owned = false;
    await this.options.stop().catch((error: unknown) => this.options.logger?.warn('Could not stop the vision model.', { message: String(error) }));
    this.options.logger?.info('Vision model stopped.');
  }

  private armIdle(): void {
    this.clearIdle();
    const set = this.options.setTimer ?? ((callback, ms) => {
      const handle = setTimeout(callback, ms);
      handle.unref?.();
      return handle;
    });
    this.idleTimer = set(() => {
      this.idleTimer = null;
      if (this.jobs === 0 && !this.starting) void this.shutdown();
    }, this.options.idleMs ?? IDLE_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer === null) return;
    (this.options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(this.idleTimer);
    this.idleTimer = null;
  }

  private async startOnce(): Promise<void> {
    const base = this.options.baseUrl();
    if (!base) throw new Error('The vision model is not on this PC, so the app does not start it.');
    if (await this.ready(base)) return;
    if (this.platform !== 'win32') throw new Error(`The vision model is not answering at ${base}. Starting it from the app is Windows only; start llama-server there yourself.`);
    const pick = await this.options.pick();
    if (!pick || !existsSync(pick.model) || !existsSync(pick.mmproj)) throw new Error(MISSING_VISION_MODEL);
    const script = path.join(this.options.repoRoot, 'scripts', 'start-local-vision.ps1');
    if (!existsSync(script)) throw new Error(`${script} is missing, so the vision model can't be started.`);
    const port = new URL(base).port;
    this.launch(script, pick, port);
    this.owned = true;
    this.options.logger?.info('Starting the vision model.', { model: pick.model, port });
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = this.options.now ?? Date.now;
    const deadline = now() + (this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    // llama-server answers 503 while the model loads; wait for 200.
    while (now() < deadline) {
      if (await this.ready(base)) {
        this.options.logger?.info('Vision model ready.');
        return;
      }
      await sleep(this.options.pollMs ?? POLL_MS);
    }
    await this.shutdown();
    throw new Error(`The vision model did not finish loading within ${Math.round((this.options.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)} seconds. See vision.err.log in ${this.options.logDirectory}.`);
  }

  private launch(script: string, pick: VisionPick, port: string): void {
    mkdirSync(this.options.logDirectory, { recursive: true });
    const args = ['-NoProfile', '-NonInteractive', '-File', script, '-Model', pick.model, '-Mmproj', pick.mmproj, '-Alias', pick.alias, ...(port ? ['-Port', port] : [])]
      // Windows PowerShell 5.1 joins -ArgumentList without quoting.
      .map((arg) => psQuote(`"${arg}"`))
      .join(', ');
    const command = [
      `Start-Process -FilePath 'powershell.exe' -ArgumentList @(${args})`,
      `-WorkingDirectory ${psQuote(this.options.repoRoot)} -WindowStyle Hidden`,
      `-RedirectStandardOutput ${psQuote(path.join(this.options.logDirectory, 'vision.log'))}`,
      `-RedirectStandardError ${psQuote(path.join(this.options.logDirectory, 'vision.err.log'))} -PassThru |`,
      // The app stops it again when it quits or hibernates (server/server-manager.ts).
      `ForEach-Object { Set-Content -LiteralPath ${psQuote(path.join(this.options.logDirectory, 'vision.pid'))} -Value $_.Id }`,
    ].join(' ');
    if (this.options.launch) {
      this.options.launch(command);
      return;
    }
    const env = this.options.env ?? process.env;
    // pnpm dev:run moves the profile folders; the script finds llama-server in the real one.
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...env,
        USERPROFILE: env.AIEMBODIED_HOST_USERPROFILE || env.USERPROFILE,
        LOCALAPPDATA: env.AIEMBODIED_HOST_LOCALAPPDATA || env.LOCALAPPDATA,
        APPDATA: env.AIEMBODIED_HOST_APPDATA || env.APPDATA,
      },
    });
    child.on('error', () => undefined);
    child.unref();
  }
}

/** The vision server a use is routed to, when it is this PC's (the one the app starts); else null. */
export function visionServerFor(routing: ModelRouting, use: UseId, visionServerId = 'local-vision'): ModelServer | null {
  const target = routeTargets(routing, use)[0];
  if (!target || target.server.id !== visionServerId || !isLocalUrl(target.server.url)) return null;
  return target.server;
}

/**
 * Run `job` with the vision server up when `use` is routed to it; run it as is when the use goes to
 * any other server (OpenAI, another PC, ...).
 */
export async function withVisionServer<T>(
  routing: ModelRouting,
  use: UseId,
  server: Pick<VisionServer, 'ensureRunning' | 'release'>,
  job: () => Promise<T>,
): Promise<T> {
  if (!visionServerFor(routing, use)) return job();
  await server.ensureRunning();
  try {
    return await job();
  } finally {
    server.release();
  }
}
