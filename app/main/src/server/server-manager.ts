import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

type Logger = Pick<Console, 'info' | 'warn' | 'debug'>;

/**
 * Containers a started service runs in: stopping the service's console does not stop them.
 * Keyed by the service id its pid file is named after.
 */
const SERVICE_CONTAINERS: Record<string, string> = {
  memory: 'aiembodied-memory-db',
  searxng: 'aiembodied-searxng',
};

export interface ServerManagerOptions {
  logger: Logger;
  /**
   * Folders holding `<id>.pid` files, one per server this app is responsible for: pnpm dev:run
   * writes them for the services it started (.dev-home/logs), and the app for the ones it starts
   * itself (llama-server after a model change, ComfyUI). Servers that were already running when
   * they were needed have no pid file and are left alone.
   */
  pidDirectories: string[];
  platform?: string;
  /** Runs a PowerShell command and returns what it printed. */
  powershell?: (command: string, timeoutMs: number) => Promise<string>;
  /** Longest wait for the stop, in ms. */
  timeoutMs?: number;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The PowerShell that stops every server with a pid file in `directories`: the process tree of
 * each (the start script's console, and the server it runs), then any container it runs in.
 * A pid is only acted on if that process started before its pid file was written, so a pid
 * Windows has since given to another program is never killed. Each pid file is removed.
 */
export function buildStopCommand(directories: string[]): string {
  const containers = Object.entries(SERVICE_CONTAINERS)
    .map(([id, name]) => `${psQuote(id)} = ${psQuote(name)}`)
    .join('; ');
  return [
    "$ErrorActionPreference = 'SilentlyContinue';",
    `$containers = @{ ${containers} };`,
    `foreach ($dir in @(${directories.map(psQuote).join(', ')})) {`,
    '  if (-not (Test-Path -LiteralPath $dir)) { continue }',
    '  foreach ($file in Get-ChildItem -LiteralPath $dir -Filter *.pid -File) {',
    '    $id = 0; [void][int]::TryParse(((Get-Content -LiteralPath $file.FullName -TotalCount 1) -as [string]).Trim(), [ref]$id);',
    '    $process = if ($id -gt 0) { Get-Process -Id $id } else { $null };',
    '    if ($process -and $process.StartTime -le $file.LastWriteTime.AddSeconds(5)) {',
    '      & taskkill.exe /PID $id /T /F *> $null;',
    "      'stopped:' + $file.BaseName",
    '    }',
    '    $name = $containers[$file.BaseName];',
    '    if ($name) {',
    "      if (Get-Command wslc) { & wslc stop $name *> $null; if ($LASTEXITCODE -eq 0) { 'container:' + $name } }",
    "      if (Get-Command docker) { & docker stop $name *> $null; if ($LASTEXITCODE -eq 0) { 'container:' + $name } }",
    '    }',
    '    Remove-Item -LiteralPath $file.FullName -Force',
    '  }',
    '}',
    'exit 0',
  ].join(' ');
}

/**
 * Stops the local model servers this app is responsible for, on hibernation, on system suspend
 * and when the app quits. They start again the next time pnpm dev:run (or the app) needs them.
 */
export class ServerManager {
  private readonly logger: Logger;
  private stopping: Promise<string[]> | null = null;

  constructor(private readonly options: ServerManagerOptions) {
    this.logger = options.logger;
  }

  /** Stop every server this app started; returns what was stopped (`stopped:<id>`, `container:<name>`). */
  stopAll(): Promise<string[]> {
    this.stopping ??= this.runStop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async runStop(): Promise<string[]> {
    if ((this.options.platform ?? process.platform) !== 'win32') {
      this.logger.debug('ServerManager: stopping servers is Windows only');
      return [];
    }
    const directories = this.options.pidDirectories.filter((dir) => existsSync(dir));
    if (directories.length === 0) {
      return [];
    }
    const startedAt = Date.now();
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const run =
      this.options.powershell ??
      ((command: string, timeout: number) =>
        promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          windowsHide: true,
          timeout,
        }).then((result) => result.stdout));
    try {
      const output = await run(buildStopCommand(directories), timeoutMs);
      const stopped = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('stopped:') || line.startsWith('container:'));
      this.logger.info('ServerManager: stopped local servers', { stopped, durationMs: Date.now() - startedAt });
      return stopped;
    } catch (error) {
      this.logger.warn('ServerManager: stopping local servers failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** System suspend: stop the servers (best effort; Windows allows only a moment). */
  async suspend(): Promise<void> {
    this.logger.info('ServerManager: stopping servers before suspend');
    await this.stopAll();
  }

  /** After resume nothing restarts by itself: the servers start again when next needed. */
  async resume(): Promise<void> {
    this.logger.info('ServerManager: resumed; servers start again when next needed');
  }

  /** Hibernate requested in the app: stop the servers first. */
  async hibernate(): Promise<void> {
    this.logger.info('ServerManager: stopping servers before hibernation');
    await this.stopAll();
  }

  /** The app is quitting: stop the servers it is responsible for. */
  async shutdown(): Promise<void> {
    this.logger.info('ServerManager: stopping servers before quitting');
    await this.stopAll();
  }
}
