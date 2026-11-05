import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface LocalLlmControlOptions {
  /** The local LLM server's address, or null when the conversation uses another server. */
  baseUrl: () => string | null;
  repoRoot: string;
  logDirectory: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** Runs a PowerShell command and returns what it printed. */
  powershell?: (command: string) => Promise<string>;
  /** Starts a PowerShell command that outlives the app. */
  launch?: (command: string) => void;
}

/**
 * Stops this PC's llama-server to free its memory for a big job, and starts it again afterwards.
 * It holds about 130 GB, more than can sit alongside anything else large. Whatever is listening on
 * the port is left alone unless it is llama-server, and without the start script (a packaged app)
 * nothing is stopped, because it couldn't be brought back.
 */
export class LocalLlmControl {
  constructor(private readonly options: LocalLlmControlOptions) {}

  private port(): number | null {
    const url = this.options.baseUrl();
    if (!url || (this.options.platform ?? process.platform) !== 'win32') return null;
    try {
      const parsed = new URL(url);
      if (!LOCAL_HOSTS.has(parsed.hostname)) return null;
      return parsed.port ? Number(parsed.port) : null;
    } catch {
      return null;
    }
  }

  private get script(): string {
    return path.join(this.options.repoRoot, 'scripts', 'start-local-llm.ps1');
  }

  private run(command: string): Promise<string> {
    if (this.options.powershell) return this.options.powershell(command);
    return promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 60_000,
    }).then((result) => result.stdout);
  }

  /** True when the server was running and has stopped. */
  async stop(): Promise<boolean> {
    const port = this.port();
    if (!port || !existsSync(this.script)) return false;
    const output = await this.run(
      [
        `$id = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess;`,
        `if ($id) { $process = Get-Process -Id $id -ErrorAction SilentlyContinue;`,
        `if ($process -and $process.ProcessName -eq 'llama-server') { Stop-Process -Id $id -Force; Wait-Process -Id $id -Timeout 30 -ErrorAction SilentlyContinue; 'stopped' } }`,
      ].join(' '),
    );
    return output.includes('stopped');
  }

  /** Starts the server in its own hidden console, the way pnpm dev:run does. Loading takes minutes. */
  start(): void {
    const port = this.port();
    if (!port) return;
    mkdirSync(this.options.logDirectory, { recursive: true });
    const args = ['-NoProfile', '-NonInteractive', '-File', this.script, '-Port', String(port)]
      // Windows PowerShell 5.1 joins -ArgumentList without quoting.
      .map((arg) => psQuote(`"${arg}"`))
      .join(', ');
    const command = [
      `Start-Process -FilePath 'powershell.exe' -ArgumentList @(${args})`,
      `-WorkingDirectory ${psQuote(this.options.repoRoot)} -WindowStyle Hidden`,
      `-RedirectStandardOutput ${psQuote(path.join(this.options.logDirectory, 'llm.log'))}`,
      `-RedirectStandardError ${psQuote(path.join(this.options.logDirectory, 'llm.err.log'))}`,
    ].join(' ');
    if (this.options.launch) {
      this.options.launch(command);
      return;
    }
    const env = this.options.env ?? process.env;
    // pnpm dev:run moves the profile folders; the script finds llama-server and its model in the real one.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      {
        // No pipes: the server inherits the launcher's handles and would hold them open.
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...env,
          USERPROFILE: env.AIEMBODIED_HOST_USERPROFILE || env.USERPROFILE,
          LOCALAPPDATA: env.AIEMBODIED_HOST_LOCALAPPDATA || env.LOCALAPPDATA,
          APPDATA: env.AIEMBODIED_HOST_APPDATA || env.APPDATA,
        },
      },
    );
    child.on('error', () => undefined);
    child.unref();
  }
}
