/**
 * Windows commit headroom: how much more memory Windows will promise to programs before it
 * refuses (RAM plus the page file, minus what is already committed). A model server that maps a
 * big GGUF needs this much room even when the file is loaded lazily. Only Windows; elsewhere null.
 */
import { execFile } from 'node:child_process';

export const COMMIT_READER_SCRIPT =
  'Get-CimInstance Win32_OperatingSystem | Select-Object FreeVirtualMemory,FreePhysicalMemory | ConvertTo-Json -Compress';

export type RunCommitReader = () => Promise<string>;

function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Bytes of commit headroom from what the script prints (both numbers are KB), or null if it isn't there. */
export function parseCommitHeadroom(output: string): number | null {
  try {
    const raw = JSON.parse(output.trim() || '{}') as { FreeVirtualMemory?: unknown };
    const kb = typeof raw.FreeVirtualMemory === 'number' ? raw.FreeVirtualMemory : Number(raw.FreeVirtualMemory);
    return Number.isFinite(kb) && kb >= 0 && raw.FreeVirtualMemory !== null && raw.FreeVirtualMemory !== undefined ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/** Free commit headroom in bytes, or null off Windows or when it can't be read. */
export async function readCommitHeadroom(options: { platform?: NodeJS.Platform; run?: RunCommitReader } = {}): Promise<number | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && !options.run) return null;
  try {
    return parseCommitHeadroom(await (options.run ?? (() => runPowerShell(COMMIT_READER_SCRIPT)))());
  } catch {
    return null;
  }
}
