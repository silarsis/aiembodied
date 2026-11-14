/**
 * Is another app full screen? Kevin's answer: close the room while a full-screen app or game runs.
 *
 * On Windows one long-lived PowerShell process answers a line per poll (a small C# helper is compiled once with
 * Add-Type): it asks for the foreground window and checks whether that window covers its whole monitor. Our own
 * window, the desktop and the shell (Progman, WorkerW, Shell_TrayWnd) never count. On other systems the answer
 * is always "no". If the helper does not answer, the watcher says "yes" (fail closed) and starts it again.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export const FULLSCREEN_POLL_MS = 3000;
const RESTART_MS = 10_000;

/** The PowerShell program. It reads a line, writes `1` (a full-screen app is in front) or `0`. */
export const FULLSCREEN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FullScreenProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static int Check(uint ourPid) {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid == ourPid) return 0;
    StringBuilder cls = new StringBuilder(256);
    GetClassName(h, cls, 256);
    string c = cls.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return 0;
    RECT r; if (!GetWindowRect(h, out r)) return 0;
    IntPtr m = MonitorFromWindow(h, 2);
    if (m == IntPtr.Zero) return 0;
    MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(m, ref mi)) return 0;
    return (r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top && r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom) ? 1 : 0;
  }
}
'@
[Console]::Out.WriteLine('ready')
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try { [Console]::Out.WriteLine([FullScreenProbe]::Check([uint32]$env:AIEMBODIED_PID)) } catch { [Console]::Out.WriteLine('1') }
}
`;

/** PowerShell's `-EncodedCommand` takes the script as base64 of UTF-16, which keeps quotes and line breaks intact. */
export function encodeScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export type SpawnLike = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsHide: boolean }) => ChildProcessWithoutNullStreams;

export interface FullscreenWatcherOptions {
  platform?: NodeJS.Platform;
  spawn?: SpawnLike;
  intervalMs?: number;
  restartMs?: number;
  ownPid?: number;
  /** Called with `true` when no other app is full screen, on start and then on every change. */
  onChange: (noFullscreenApp: boolean) => void;
  logger?: Pick<Console, 'warn' | 'info' | 'debug'>;
}

export class FullscreenWatcher {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private last: boolean | null = null;
  private buffer = '';
  private ready = false;
  private awaiting = false;
  private missed = 0;
  private stopped = true;

  constructor(private readonly options: FullscreenWatcherOptions) {}

  private get windows(): boolean {
    return (this.options.platform ?? process.platform) === 'win32';
  }

  start(): void {
    this.stopped = false;
    if (!this.windows) {
      this.report(true);
      return;
    }
    // Until the helper answers, a full-screen app cannot be ruled out.
    this.report(false);
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.pollTimer = null;
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    try {
      child?.stdin.end();
      child?.kill();
    } catch {
      // Already gone.
    }
  }

  private report(noFullscreenApp: boolean): void {
    if (this.last === noFullscreenApp) return;
    this.last = noFullscreenApp;
    this.options.onChange(noFullscreenApp);
  }

  private launch(): void {
    if (this.stopped) return;
    const spawn: SpawnLike = this.options.spawn ?? ((command, args, options) => nodeSpawn(command, args, options) as ChildProcessWithoutNullStreams);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeScript(FULLSCREEN_SCRIPT)], {
        env: { ...process.env, AIEMBODIED_PID: String(this.options.ownPid ?? process.pid) },
        windowsHide: true,
      });
    } catch (error) {
      this.options.logger?.warn('Could not start the full-screen check', { message: error instanceof Error ? error.message : String(error) });
      this.failed();
      return;
    }
    this.child = child;
    this.ready = false;
    this.awaiting = false;
    this.buffer = '';
    child.stdout.on('data', (chunk: Buffer | string) => this.onData(String(chunk)));
    child.stderr.on('data', (chunk: Buffer | string) => this.options.logger?.debug('Full-screen check said', { text: String(chunk).slice(0, 300) }));
    child.on('error', (error) => {
      this.options.logger?.warn('The full-screen check failed', { message: error.message });
      if (this.child === child) this.failed();
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.options.logger?.warn('The full-screen check stopped', { code });
      this.failed();
    });
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.poll(), this.options.intervalMs ?? FULLSCREEN_POLL_MS);
    this.pollTimer.unref?.();
  }

  /** Writes one line per poll, unless the last one has not been answered: then the helper is stuck and counts as missed. */
  private poll(): void {
    if (!this.child || !this.ready) return;
    if (this.awaiting) {
      this.missed += 1;
      if (this.missed >= 2) this.report(false);
      return;
    }
    this.awaiting = true;
    try {
      this.child.stdin.write('\n');
    } catch {
      this.failed();
    }
  }

  private onData(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line === 'ready') {
        this.ready = true;
        this.poll();
      } else if (line === '0' || line === '1') {
        this.awaiting = false;
        this.missed = 0;
        this.report(line === '0');
      }
    }
  }

  /** The helper is gone or never started: fail closed, and try again in a while. */
  private failed(): void {
    this.report(false);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.child = null;
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, this.options.restartMs ?? RESTART_MS);
    this.restartTimer.unref?.();
  }
}
