/**
 * Starts a local ComfyUI server when avatar generation needs one and stops it again afterwards,
 * the way slopcore's service manager does (core/services.py): check the health URL, start the
 * server with its command if it's down, wait for it to answer, and switch it off when done.
 *
 * Unlike slopcore it never switches ComfyUI off with POST /free, which crashes Comfy Desktop
 * with the int8 Qwen weights. Instead it kills the process it started. A ComfyUI that was
 * already running (Comfy Desktop, or one slopcore started) is used as it is and left running.
 *
 * The start command is COMFYUI_START_COMMAND when set (a whole command line, run by the shell),
 * otherwise Comfy Desktop's own install started headless, found under %LOCALAPPDATA%.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ComfyStartCommand {
  /** Executable, or the whole command line when `shell` is set. */
  file: string;
  args: string[];
  cwd?: string;
  shell?: boolean;
}

export interface ComfyUILauncherOptions {
  baseUrl: string;
  isAvailable: () => Promise<boolean>;
  /** How to start ComfyUI; null when it can't be started from here. */
  command: ComfyStartCommand | null;
  /** Where the started server's output goes. */
  logPath?: string;
  /** Loading the models happens per job, so the server itself comes up in well under this. */
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  spawnFn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  killTree?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

const DEFAULT_START_TIMEOUT_MS = 5 * 60 * 1000;

export class ComfyUILauncher {
  private child: ChildProcess | null = null;
  private exited = false;

  constructor(private readonly options: ComfyUILauncherOptions) {}

  get canStart(): boolean {
    return this.options.command !== null;
  }

  /** True while a server this launcher started is running. */
  get started(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Make sure ComfyUI answers, starting it if it's down. */
  async ensureRunning(signal?: AbortSignal): Promise<void> {
    if (await this.options.isAvailable()) {
      return;
    }
    const { command } = this.options;
    if (!command) {
      throw new Error(
        `ComfyUI isn't reachable at ${this.options.baseUrl} and there's no way to start it here. ` +
          'Install Comfy Desktop, set COMFYUI_START_COMMAND, or start ComfyUI yourself and try again.',
      );
    }
    if (!this.started) {
      this.spawn(command);
    }

    const pollIntervalMs = this.options.pollIntervalMs ?? 2000;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    while (!(await this.options.isAvailable())) {
      if (signal?.aborted) {
        this.stop();
        throw new Error('Cancelled.');
      }
      if (this.exited) {
        this.child = null;
        throw new Error(`ComfyUI exited while starting.${this.logHint()}`);
      }
      if (Date.now() > deadline) {
        this.stop();
        throw new Error(`ComfyUI didn't answer at ${this.options.baseUrl} after starting.${this.logHint()}`);
      }
      await sleep(pollIntervalMs);
    }
    this.options.logger?.info?.('ComfyUI is up.', { baseUrl: this.options.baseUrl });
  }

  /** Stop the server if this launcher started it; one that was already running is left alone. */
  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child || this.exited || child.pid === undefined) {
      return;
    }
    this.options.logger?.info?.('Stopping the ComfyUI server started for avatar generation.', { pid: child.pid });
    (this.options.killTree ?? killProcessTree)(child.pid);
  }

  private spawn(command: ComfyStartCommand): void {
    const { logPath } = this.options;
    let logFd: number | undefined;
    if (logPath) {
      mkdirSync(path.dirname(logPath), { recursive: true });
      logFd = openSync(logPath, 'a');
    }
    this.options.logger?.info?.('Starting ComfyUI for avatar generation.', {
      command: command.shell ? command.file : [command.file, ...command.args].join(' '),
      logPath,
    });
    // Not detached on Windows: Node's detached means DETACHED_PROCESS, which leaves a venv's
    // python.exe launcher with no console, and it never gets going. windowsHide gives it a
    // hidden console of its own instead, as slopcore does with CREATE_NO_WINDOW. Elsewhere it
    // gets its own process group so stop() can take down anything it started.
    const child = (this.options.spawnFn ?? spawn)(command.file, command.args, {
      cwd: command.cwd,
      shell: command.shell ?? false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    });
    if (logFd !== undefined) {
      closeSync(logFd);
    }
    this.exited = false;
    child.once('exit', (code) => {
      if (this.child === child) {
        this.exited = true;
        this.options.logger?.warn?.('ComfyUI exited.', { code });
      }
    });
    child.once('error', (error) => {
      if (this.child === child) {
        this.exited = true;
        this.options.logger?.warn?.('ComfyUI could not be started.', { message: error.message });
      }
    });
    this.child = child;
  }

  private logHint(): string {
    return this.options.logPath ? ` See ${this.options.logPath}.` : '';
  }
}

export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

function isOff(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes((value ?? '').trim().toLowerCase());
}

function isLocalUrl(baseUrl: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function portOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.port || (url.protocol === 'https:' ? '443' : '80');
  } catch {
    return '8188';
  }
}

function newestFile(directory: string, extension: string): string | null {
  try {
    const files = readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith(extension))
      .map((name) => path.join(directory, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Comfy Desktop's own ComfyUI install, started headless like slopcore.yaml's `comfyui` service:
 * %LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs\<name>\ with its .venv and ComfyUI\main.py, the
 * model paths the Desktop app wrote, and the Desktop app's shared input and output folders.
 */
export function findComfyDesktopCommand(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  exists: (file: string) => boolean = existsSync,
  list: (directory: string) => string[] = (directory) => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  },
  findModelPaths: (directory: string) => string | null = (directory) => newestFile(directory, '.yaml'),
): ComfyStartCommand | null {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }
  const desktopRoot = path.win32.join(localAppData, 'Comfy-Desktop');
  const installsRoot = path.win32.join(desktopRoot, 'ComfyUI-Installs');
  const names = list(installsRoot).sort((a, b) => (a === 'ComfyUI' ? -1 : b === 'ComfyUI' ? 1 : a.localeCompare(b)));
  for (const name of names) {
    const cwd = path.win32.join(installsRoot, name);
    const python = path.win32.join(cwd, 'ComfyUI', '.venv', 'Scripts', 'python.exe');
    const main = path.win32.join(cwd, 'ComfyUI', 'main.py');
    if (!exists(python) || !exists(main)) {
      continue;
    }
    const args = ['-s', path.win32.join('ComfyUI', 'main.py'), '--listen', '127.0.0.1', '--port', portOf(baseUrl)];
    // Same flags slopcore uses for this install; without them Desktop-installed nodes and the
    // dynamic VRAM path misbehave on bija's AMD GPU.
    args.push('--enable-assets', '--enable-manager', '--disable-dynamic-vram');
    const modelPaths = env.APPDATA
      ? findModelPaths(path.win32.join(env.APPDATA, 'Comfy Desktop', 'instance-model-paths'))
      : null;
    if (modelPaths) {
      args.push('--extra-model-paths-config', modelPaths);
    }
    for (const folder of ['input', 'output'] as const) {
      const shared = path.win32.join(desktopRoot, 'ComfyUI-Shared', folder);
      if (exists(shared)) {
        args.push(`--${folder}-directory`, shared);
      }
    }
    return { file: python, args, cwd };
  }
  return null;
}

/**
 * How to start ComfyUI from this machine's settings: COMFYUI_AUTOSTART=0 turns it off, a
 * ComfyUI on another machine is never started from here, COMFYUI_START_COMMAND wins over
 * finding Comfy Desktop.
 */
export function resolveComfyStartCommand(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  platform: NodeJS.Platform = process.platform,
): ComfyStartCommand | null {
  if (isOff(env.COMFYUI_AUTOSTART) || !isLocalUrl(baseUrl)) {
    return null;
  }
  const custom = env.COMFYUI_START_COMMAND?.trim();
  if (custom) {
    return { file: custom, args: [], cwd: env.COMFYUI_START_CWD?.trim() || undefined, shell: true };
  }
  return platform === 'win32' ? findComfyDesktopCommand(env, baseUrl) : null;
}
