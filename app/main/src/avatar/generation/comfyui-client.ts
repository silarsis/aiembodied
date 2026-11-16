/**
 * Minimal client for a local ComfyUI server's HTTP API.
 *
 * Mirrors slopcore's providers/comfyui.py: upload inputs to /upload/image, queue an API-format
 * graph on /prompt, poll /history/{id} until it finishes, then fetch the saved image from /view.
 * Deliberately never calls POST /free: on Comfy Desktop with int8 Qwen weights it can crash the
 * server (access violation while moving the weights back to the CPU).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { graphModelFiles } from './comfyui-needs.js';

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** A shared lease on the model controller's comfyui backend (see aicontroller/bridge.ts). */
export interface ComfyLeaseSource {
  /** Holds the lease for one request; `done()` says the request is over. The lease itself is kept for a quiet spell. */
  acquire(needs?: string[]): Promise<{ url: string | null; host?: string | null; done(): void }>;
}

export interface ComfyUIClientOptions {
  baseUrl: string;
  /**
   * With the model controller in use, ComfyUI is leased from it: each request holds the lease (so
   * jobs in a row share one) and talks to the lease's URL, which replaces `baseUrl`.
   */
  lease?: ComfyLeaseSource;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ComfyRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  output?: 'image' | 'mesh';
}

interface HistorySavedFile {
  filename?: string;
  subfolder?: string;
  type?: string;
}

interface HistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: unknown };
  outputs?: Record<
    string,
    {
      images?: HistorySavedFile[];
      '3d'?: HistorySavedFile[];
      mesh?: HistorySavedFile[];
      result?: HistorySavedFile[];
    }
  >;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Any one ComfyUI request (not a whole job): a hung request must not hold the controller's lease forever. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Fetching a finished image or mesh can be large. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export class ComfyUIClient {
  /** The address in use: the lease's URL while ComfyUI is leased from the model controller. */
  baseUrl: string;
  private readonly lease?: ComfyLeaseSource;
  /** The lease a job holds across its uploads and runs; they must reach the machine the lease is on. */
  private readonly scope = new AsyncLocalStorage<{ url: string | null; host: string | null }>();
  private readonly fetchFn: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ComfyUIClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.lease = options.lease;
    this.fetchFn = options.fetchFn ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The address a request goes to: the lease of the job it belongs to, else the client's own. */
  private get base(): string {
    const url = this.scope.getStore()?.url;
    return url ? url.replace(/\/+$/, '') : this.baseUrl;
  }

  /**
   * Runs one request with the controller's lease held, on the lease's URL. Inside {@link job} it
   * uses the job's lease; otherwise it leases for `needs`. Without a lease source it just runs.
   */
  private async leased<T>(request: () => Promise<T>, needs: string[] = []): Promise<T> {
    if (!this.lease || this.scope.getStore()) return request();
    const handle = await this.lease.acquire(needs);
    if (handle.url) this.baseUrl = handle.url.replace(/\/+$/, '');
    try {
      return await this.scope.run({ url: handle.url, host: handle.host ?? null }, request);
    } finally {
      handle.done();
    }
  }

  /**
   * Runs a job's uploads and runs on one lease, so they all reach the same machine. `needs` are the
   * model files its graphs load (see graphModelFiles): the controller may lease a machine that has them.
   */
  job<T>(needs: string[], work: () => Promise<T>): Promise<T> {
    return this.leased(work, needs);
  }

  /** The machine the current job's lease is on when the controller routed it away from this PC. */
  currentHost(): string | null {
    return this.scope.getStore()?.host ?? null;
  }

  /** True when the server answers /system_stats. */
  isAvailable(): Promise<boolean> {
    return this.leased(() => this.probe()).catch(() => false);
  }

  private async probe(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.base}/system_stats`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Upload a PNG into ComfyUI's input folder; returns the name LoadImage nodes should use. */
  uploadImage(fileName: string, png: Buffer, subfolder = 'aiembodied'): Promise<string> {
    return this.leased(() => this.upload(fileName, png, subfolder));
  }

  private async upload(fileName: string, png: Buffer, subfolder: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), fileName);
    form.append('subfolder', subfolder);
    form.append('type', 'input');
    form.append('overwrite', 'true');

    const response = await this.fetchFn(`${this.base}/upload/image`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ComfyUI upload failed: HTTP ${response.status} ${await safeText(response)}`);
    }
    const info = (await response.json()) as { name?: string; subfolder?: string };
    if (!info.name) {
      throw new Error('ComfyUI upload response did not include a file name.');
    }
    return info.subfolder ? `${info.subfolder}/${info.name}` : info.name;
  }

  /** Queue `graph`, wait for it, and return the bytes of the first image it saved. */
  run(graph: ComfyGraph, options: ComfyRunOptions = {}): Promise<Buffer> {
    return this.leased(() => this.runGraph(graph, options), graphModelFiles(graph));
  }

  private async runGraph(graph: ComfyGraph, options: ComfyRunOptions): Promise<Buffer> {
    if (options.signal?.aborted) throw new Error('ComfyUI job cancelled.');
    const promptId = await this.queue(graph);
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        await this.cancelPrompt(promptId);
        throw new Error('ComfyUI job cancelled.');
      }

      const entry = await this.history(promptId);
      if (entry?.status?.status_str === 'error') {
        throw new Error(
          `ComfyUI failed: ${JSON.stringify(entry.status.messages ?? null).slice(0, 500)}`,
        );
      }
      if (entry?.status?.completed) {
        for (const output of Object.values(entry.outputs ?? {})) {
          const files =
            options.output === 'mesh'
              ? (output['3d'] ?? output.mesh ?? output.result ?? [])
              : (output.images ?? []);
          for (const saved of files) {
            if (saved.type === 'output' && saved.filename) {
              return this.view(saved);
            }
          }
        }
        throw new Error(
          `ComfyUI finished without saving an ${options.output === 'mesh' ? 'output mesh' : 'image'}.`,
        );
      }

      await this.sleep(this.pollIntervalMs);
    }

    throw new Error(`ComfyUI prompt ${promptId} did not finish in time.`);
  }

  /** Cancel this request only; background and avatar generation share the server. */
  private async cancelPrompt(promptId: string): Promise<void> {
    try {
      const response = await this.fetchFn(
        `${this.base}/api/jobs/${encodeURIComponent(promptId)}/cancel`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
        },
      );
      if (response.ok) return;
      // Older servers can at least remove this queued prompt. Never interrupt unrelated work.
      await this.fetchFn(`${this.base}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* Best effort if the server went away. */
    }
  }

  /** Stop whatever ComfyUI is running now. */
  async interrupt(): Promise<void> {
    try {
      await this.fetchFn(`${this.base}/interrupt`, { method: 'POST' });
    } catch {
      // Best effort: the server may already be gone.
    }
  }

  private async queue(graph: ComfyGraph): Promise<string> {
    const response = await this.fetchFn(`${this.base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: 'aiembodied' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ComfyUI rejected the workflow: ${await safeText(response)}`);
    }
    const body = (await response.json()) as { prompt_id?: string };
    if (!body.prompt_id) {
      throw new Error('ComfyUI did not return a prompt id.');
    }
    return body.prompt_id;
  }

  private async history(promptId: string): Promise<HistoryEntry | undefined> {
    const response = await this.fetchFn(`${this.base}/history/${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as Record<string, HistoryEntry>;
    return body[promptId];
  }

  private async view(saved: HistorySavedFile): Promise<Buffer> {
    const params = new URLSearchParams({
      filename: saved.filename ?? '',
      subfolder: saved.subfolder ?? '',
      type: saved.type ?? 'output',
    });
    const response = await this.fetchFn(`${this.base}/view?${params.toString()}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ComfyUI /view failed: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/** Runs `work` as one of `comfy`'s jobs (one lease for its uploads and runs) when the client has jobs, else just runs it. */
export function inJob<T>(comfy: { job?: ComfyUIClient['job'] }, needs: string[], work: () => Promise<T>): Promise<T> {
  return typeof comfy.job === 'function' ? comfy.job(needs, work) : work();
}
