/**
 * GPU memory on this PC, split by the app's own servers.
 *
 * Windows counts GPU memory per process for every vendor and API (the same counters Task Manager
 * reads: "GPU Process Memory" and "GPU Adapter Memory"). Each local server is matched to the
 * process listening on its port; whatever else is using the GPU shows as "other". Only Windows is
 * supported; other platforms report `supported: false`.
 */
import { execFile } from 'node:child_process';

export interface GpuMemoryServer {
  id: string;
  name: string;
  port: number;
}

export interface GpuMemoryUse {
  /** Bytes of dedicated (on-card or carved-out) GPU memory. */
  dedicated: number;
  /** Bytes of shared system memory the GPU has mapped. */
  shared: number;
}

export interface GpuMemoryServerUse extends GpuMemoryUse {
  id: string;
  name: string;
  port: number;
  /** Process listening on the port, if any. */
  pid?: number;
  processName?: string;
}

export interface GpuMemoryProcessUse extends GpuMemoryUse {
  pid: number;
  name: string;
}

export interface GpuMemorySnapshot {
  supported: boolean;
  /** Why there are no numbers (unsupported platform, the read failed). */
  reason?: string;
  adapterName?: string;
  /** Total dedicated memory, or null when the driver doesn't say. */
  dedicatedTotal: number | null;
  /** Shared memory limit (Windows allows half of system RAM), or null when unknown. */
  sharedTotal: number | null;
  /** Everything in use on the adapter, from the adapter counters. */
  used: GpuMemoryUse;
  servers: GpuMemoryServerUse[];
  /** Other processes using the GPU, biggest first. */
  others: GpuMemoryProcessUse[];
  /** In use but not attributed to any listed process (the driver, rounding). */
  unattributed: GpuMemoryUse;
  takenAt: number;
}

/** What the PowerShell reader prints (one JSON object). */
export interface RawGpuReading {
  counters?: Array<{ path?: string; instance?: string; value?: number }> | { path?: string; instance?: string; value?: number };
  listen?: Array<{ port?: number; pid?: number }> | { port?: number; pid?: number };
  procs?: Array<{ pid?: number; name?: string }> | { pid?: number; name?: string };
  adapters?: Array<{ name?: string; memory?: number }> | { name?: string; memory?: number };
  ram?: number;
}

/** PowerShell's ConvertTo-Json writes a one-element array as a bare object. */
function list<T>(value: T[] | T | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

const PROCESS_INSTANCE = /^pid_(\d+)_(luid_0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+$/i;
const ADAPTER_INSTANCE = /^(luid_0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+$/i;

function kind(path: string | undefined): keyof GpuMemoryUse | null {
  const lower = (path ?? '').toLowerCase();
  if (lower.endsWith('\\dedicated usage')) return 'dedicated';
  if (lower.endsWith('\\shared usage')) return 'shared';
  return null;
}

const zero = (): GpuMemoryUse => ({ dedicated: 0, shared: 0 });
const total = (use: GpuMemoryUse) => use.dedicated + use.shared;

/** Turn a raw reading into per-server use for the busiest GPU. */
export function summariseGpuReading(raw: RawGpuReading, servers: GpuMemoryServer[], takenAt = Date.now()): GpuMemorySnapshot {
  const adapters = new Map<string, GpuMemoryUse>();
  const processes = new Map<string, Map<number, GpuMemoryUse>>();
  for (const counter of list(raw.counters)) {
    const field = kind(counter.path);
    const value = typeof counter.value === 'number' && Number.isFinite(counter.value) ? counter.value : 0;
    const instance = (counter.instance ?? '').trim();
    if (!field) continue;
    const proc = PROCESS_INSTANCE.exec(instance);
    if (proc) {
      const pid = Number(proc[1]);
      const luid = proc[2].toLowerCase();
      const byPid = processes.get(luid) ?? new Map<number, GpuMemoryUse>();
      const use = byPid.get(pid) ?? zero();
      use[field] += value;
      byPid.set(pid, use);
      processes.set(luid, byPid);
      continue;
    }
    const adapter = ADAPTER_INSTANCE.exec(instance);
    if (adapter) {
      const luid = adapter[1].toLowerCase();
      const use = adapters.get(luid) ?? zero();
      use[field] += value;
      adapters.set(luid, use);
    }
  }

  // The busiest adapter is the one the models run on (the basic display adapter uses next to nothing).
  const processTotal = (id: string) =>
    [...(processes.get(id)?.values() ?? [])].reduce((acc, use) => acc + total(use), 0);
  const sizeOf = (id: string) => {
    const adapter = adapters.get(id);
    return adapter ? total(adapter) : processTotal(id);
  };
  let luid: string | undefined;
  for (const id of new Set([...adapters.keys(), ...processes.keys()])) {
    if (luid === undefined || sizeOf(id) > sizeOf(luid)) luid = id;
  }
  const byPid = (luid && processes.get(luid)) || new Map<number, GpuMemoryUse>();
  const processUse = [...byPid.values()].reduce((acc, use) => ({ dedicated: acc.dedicated + use.dedicated, shared: acc.shared + use.shared }), zero());
  const adapterUse = (luid && adapters.get(luid)) || processUse;
  const used = { dedicated: Math.max(adapterUse.dedicated, processUse.dedicated), shared: Math.max(adapterUse.shared, processUse.shared) };

  const names = new Map<number, string>();
  for (const proc of list(raw.procs)) {
    if (typeof proc.pid === 'number' && typeof proc.name === 'string') names.set(proc.pid, proc.name);
  }
  const portOwner = new Map<number, number>();
  for (const entry of list(raw.listen)) {
    if (typeof entry.port === 'number' && typeof entry.pid === 'number' && entry.pid > 0 && !portOwner.has(entry.port)) {
      portOwner.set(entry.port, entry.pid);
    }
  }

  const claimed = new Set<number>();
  const serverUse: GpuMemoryServerUse[] = servers.map((server) => {
    const pid = portOwner.get(server.port);
    // Two servers on one process (or one port listed twice) count once.
    const use = pid !== undefined && !claimed.has(pid) ? (byPid.get(pid) ?? zero()) : zero();
    if (pid !== undefined) claimed.add(pid);
    return {
      id: server.id,
      name: server.name,
      port: server.port,
      ...(pid !== undefined ? { pid, processName: names.get(pid) } : {}),
      dedicated: use.dedicated,
      shared: use.shared,
    };
  });

  const others: GpuMemoryProcessUse[] = [...byPid.entries()]
    .filter(([pid, use]) => !claimed.has(pid) && total(use) > 0)
    .map(([pid, use]) => ({ pid, name: names.get(pid) ?? `pid ${pid}`, ...use }))
    .sort((a, b) => total(b) - total(a));

  const attributed = [...serverUse, ...others].reduce(
    (acc, use) => ({ dedicated: acc.dedicated + use.dedicated, shared: acc.shared + use.shared }),
    zero(),
  );

  const adapterInfo = list(raw.adapters)
    .filter((entry) => typeof entry.memory === 'number' && entry.memory > 0)
    .sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))[0];
  const ram = typeof raw.ram === 'number' && raw.ram > 0 ? raw.ram : null;

  return {
    supported: true,
    adapterName: adapterInfo?.name,
    dedicatedTotal: adapterInfo?.memory ?? null,
    sharedTotal: ram === null ? null : ram / 2,
    used,
    servers: serverUse,
    others,
    unattributed: {
      dedicated: Math.max(0, used.dedicated - attributed.dedicated),
      shared: Math.max(0, used.shared - attributed.shared),
    },
    takenAt,
  };
}

/** Collects counters, listening ports, process names, adapter sizes and RAM as one JSON object. */
export const GPU_READER_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$paths = '\GPU Process Memory(*)\Dedicated Usage', '\GPU Process Memory(*)\Shared Usage',
  '\GPU Adapter Memory(*)\Dedicated Usage', '\GPU Adapter Memory(*)\Shared Usage'
$counters = @((Get-Counter -Counter $paths).CounterSamples | Where-Object { $_.CookedValue -gt 0 } |
  ForEach-Object { [pscustomobject]@{ path = $_.Path; instance = $_.InstanceName; value = [double]$_.CookedValue } })
$listen = @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })
$pids = @($counters | ForEach-Object { if ($_.instance -match '^pid_(\d+)_') { [int]$Matches[1] } }) + @($listen | ForEach-Object { $_.pid }) | Sort-Object -Unique
$procs = @(Get-Process -Id $pids | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName } })
$adapters = @(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' |
  Where-Object { $_.'HardwareInformation.qwMemorySize' } |
  ForEach-Object { [pscustomobject]@{ name = $_.DriverDesc; memory = [double]$_.'HardwareInformation.qwMemorySize' } })
$ram = [double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
[pscustomobject]@{ counters = $counters; listen = $listen; procs = $procs; adapters = $adapters; ram = $ram } | ConvertTo-Json -Depth 4 -Compress
`;

export type RunReader = () => Promise<string>;

function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

const unsupported = (reason: string): GpuMemorySnapshot => ({
  supported: false,
  reason,
  dedicatedTotal: null,
  sharedTotal: null,
  used: zero(),
  servers: [],
  others: [],
  unattributed: zero(),
  takenAt: Date.now(),
});

/** Reads GPU memory on demand; overlapping calls share one read. */
export class GpuMemoryReader {
  private pending: Promise<GpuMemorySnapshot> | null = null;

  constructor(
    private readonly options: {
      platform?: NodeJS.Platform;
      run?: RunReader;
    } = {},
  ) {}

  read(servers: GpuMemoryServer[]): Promise<GpuMemorySnapshot> {
    if (this.pending) return this.pending;
    this.pending = this.readOnce(servers).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async readOnce(servers: GpuMemoryServer[]): Promise<GpuMemorySnapshot> {
    const platform = this.options.platform ?? process.platform;
    if (platform !== 'win32' && !this.options.run) {
      return unsupported('GPU memory per server is only read on Windows for now.');
    }
    try {
      const output = await (this.options.run ?? (() => runPowerShell(GPU_READER_SCRIPT)))();
      const raw = JSON.parse(output.trim() || '{}') as RawGpuReading;
      return summariseGpuReading(raw, servers);
    } catch (error) {
      return unsupported(`Couldn't read the GPU counters: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The port a local URL listens on, or null for a remote or port-less URL. */
export function localPort(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) return null;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : NaN;
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export interface GpuMemoryBridge {
  read(): Promise<GpuMemorySnapshot>;
}
