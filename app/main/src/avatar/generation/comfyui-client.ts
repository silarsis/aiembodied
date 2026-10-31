/**
 * Minimal client for a local ComfyUI server's HTTP API.
 *
 * Mirrors slopcore's providers/comfyui.py: upload inputs to /upload/image, queue an API-format
 * graph on /prompt, poll /history/{id} until it finishes, then fetch the saved image from /view.
 * Deliberately never calls POST /free: on Comfy Desktop with int8 Qwen weights it can crash the
 * server (access violation while moving the weights back to the CPU).
 */

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface ComfyUIClientOptions {
  baseUrl: string;
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

export class ComfyUIClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ComfyUIClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** True when the server answers /system_stats. */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Upload a PNG into ComfyUI's input folder; returns the name LoadImage nodes should use. */
  async uploadImage(fileName: string, png: Buffer, subfolder = 'aiembodied'): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), fileName);
    form.append('subfolder', subfolder);
    form.append('type', 'input');
    form.append('overwrite', 'true');

    const response = await this.fetchFn(`${this.baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
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
  async run(graph: ComfyGraph, options: ComfyRunOptions = {}): Promise<Buffer> {
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
        `${this.baseUrl}/api/jobs/${encodeURIComponent(promptId)}/cancel`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
        },
      );
      if (response.ok) return;
      // Older servers can at least remove this queued prompt. Never interrupt unrelated work.
      await this.fetchFn(`${this.baseUrl}/queue`, {
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
      await this.fetchFn(`${this.baseUrl}/interrupt`, { method: 'POST' });
    } catch {
      // Best effort: the server may already be gone.
    }
  }

  private async queue(graph: ComfyGraph): Promise<string> {
    const response = await this.fetchFn(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: 'aiembodied' }),
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
    const response = await this.fetchFn(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`);
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
    const response = await this.fetchFn(`${this.baseUrl}/view?${params.toString()}`);
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
