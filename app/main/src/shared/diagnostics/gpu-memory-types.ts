// Types only: shared/ holds what the main process and the renderer both need.


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


export interface GpuMemoryBridge {
  read(): Promise<GpuMemorySnapshot>;
}
