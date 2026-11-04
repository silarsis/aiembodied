/**
 * Model downloads into a ComfyUI server's model folders, started from the Models and servers
 * pop-up with a Civitai link.
 *
 * This PC: the app runs the bundled downloader.py with ComfyUI's own Python, so the file lands in
 * the folder ComfyUI reads (including Comfy Desktop's extra model paths). Another machine: the
 * aiembodied ComfyUI add-on (the same folder, copied into that ComfyUI's custom_nodes) runs the
 * download there and the app follows it over HTTP.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type { ModelServer } from '../../config/model-routing.js';
import type { CivitaiDownloadPlan, CivitaiFile, ModelInfo } from './civitai.js';
import type { ComfyInstallation } from './comfyui-runtime.js';

/** What to download: a Civitai plan, or a file the app installs itself (such as a pose ControlNet). */
export type DownloadPlan = Pick<CivitaiDownloadPlan, 'title' | 'folder' | 'note' | 'kind'> & {
  file: Pick<CivitaiFile, 'name' | 'sizeKB' | 'downloadUrl' | 'sha256'>;
  /** Saved beside the file; a Civitai plan always has one. */
  info?: Partial<ModelInfo>;
};

export type DownloadState = 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface ModelDownload {
  id: string;
  serverId: string;
  serverName: string;
  title: string;
  folder: string;
  filename: string;
  state: DownloadState;
  received: number;
  total: number | null;
  error?: string;
  note?: string;
  startedAt: number;
}

interface WorkerStatus {
  id?: string;
  state?: string;
  received?: number;
  total?: number | null;
  error?: string | null;
}

export interface ModelDownloadOptions {
  /** The downloader script (downloader.py in the add-on folder). */
  script: string;
  resolveInstallation: () => Promise<ComfyInstallation>;
  /** Called when a download finishes, so model lists and kinds can be refreshed. */
  onFinished?: (download: ModelDownload, plan: DownloadPlan, server: ModelServer) => void;
  fetchFn?: typeof fetch;
  spawnFn?: typeof spawn;
  pollMs?: number;
  logger?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
}

const STATES: DownloadState[] = ['queued', 'downloading', 'verifying', 'done', 'failed', 'cancelled'];
const ADDON_HINT =
  'That ComfyUI has no aiembodied add-on. Copy the comfyui-aiembodied folder (Models and servers → this server → Download a model shows where) into its custom_nodes and restart it.';

export class ModelDownloadService {
  private readonly downloads = new Map<string, ModelDownload>();
  private readonly cancels = new Map<string, () => void>();

  constructor(private readonly options: ModelDownloadOptions) {}

  list(): ModelDownload[] {
    return [...this.downloads.values()].sort((a, b) => b.startedAt - a.startedAt).map((entry) => ({ ...entry }));
  }

  /** The most recent download of this file to this server, if any. */
  find(serverId: string, filename: string): ModelDownload | undefined {
    return this.list().find((entry) => entry.serverId === serverId && entry.filename === filename);
  }

  cancel(id: string): void {
    this.cancels.get(id)?.();
  }

  /** Whether a ComfyUI on another machine has the add-on, so the page can say so before a download. */
  async hasAddon(server: ModelServer): Promise<boolean> {
    if (server.managed) return true;
    try {
      const response = await (this.options.fetchFn ?? fetch)(`${server.url}/aiembodied/ping`, { signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  start(server: ModelServer, plan: DownloadPlan, civitaiKey: string | undefined): ModelDownload {
    if (server.type !== 'comfy') throw new Error('Models download to ComfyUI servers.');
    const busy = [...this.downloads.values()].find(
      (entry) => entry.serverId === server.id && entry.filename === plan.file.name && (entry.state === 'queued' || entry.state === 'downloading' || entry.state === 'verifying'),
    );
    if (busy) throw new Error(`${plan.file.name} is already downloading to ${server.name}.`);
    const download: ModelDownload = {
      id: randomUUID(),
      serverId: server.id,
      serverName: server.name,
      title: plan.title,
      folder: plan.folder,
      filename: plan.file.name,
      state: 'queued',
      received: 0,
      total: plan.file.sizeKB ? Math.round(plan.file.sizeKB * 1024) : null,
      ...(plan.note ? { note: plan.note } : {}),
      startedAt: Date.now(),
    };
    this.downloads.set(download.id, download);
    const run = server.managed ? this.runHere(download, plan, civitaiKey) : this.runThere(download, server, plan, civitaiKey);
    void run
      .catch((error: unknown) => {
        download.state = 'failed';
        download.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.cancels.delete(download.id);
        this.options.logger?.info('Model download finished.', { server: server.id, file: download.filename, state: download.state, error: download.error });
        this.options.onFinished?.({ ...download }, plan, server);
      });
    return { ...download };
  }

  private apply(download: ModelDownload, status: WorkerStatus): void {
    if (status.state && STATES.includes(status.state as DownloadState)) download.state = status.state as DownloadState;
    if (typeof status.received === 'number') download.received = status.received;
    if (typeof status.total === 'number') download.total = status.total;
    if (status.error) download.error = status.error;
  }

  private async runHere(download: ModelDownload, plan: DownloadPlan, civitaiKey: string | undefined): Promise<void> {
    const install = await this.options.resolveInstallation();
    const args = [
      this.options.script,
      '--comfy-dir',
      install.directory,
      ...(install.modelPaths ? ['--model-paths', install.modelPaths] : []),
      '--folder',
      plan.folder,
      '--filename',
      plan.file.name,
      '--url',
      plan.file.downloadUrl,
      ...(plan.file.sha256 ? ['--sha256', plan.file.sha256] : []),
      ...(plan.info ? ['--info', JSON.stringify(plan.info)] : []),
    ];
    const child = (this.options.spawnFn ?? spawn)(install.python, args, {
      // The key goes through the environment, never the command line.
      env: { ...install.env, PYTHONDONTWRITEBYTECODE: '1', ...(civitaiKey ? { CIVITAI_TOKEN: civitaiKey } : {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.cancels.set(download.id, () => {
      download.state = 'cancelled';
      child.kill();
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    if (!child.stdout) throw new Error('The downloader could not start.');
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        if (download.state !== 'cancelled') this.apply(download, JSON.parse(line) as WorkerStatus);
      } catch {
        // Not a status line.
      }
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (error) => {
        download.error = error.message;
        resolve(-1);
      });
      child.on('close', resolve);
    });
    if (download.state === 'cancelled') return;
    if (code !== 0 && download.state !== 'failed') {
      download.state = 'failed';
      download.error ??= stderr.trim().split('\n').at(-1) || `The downloader stopped (exit ${code}).`;
    }
  }

  private async runThere(download: ModelDownload, server: ModelServer, plan: DownloadPlan, civitaiKey: string | undefined): Promise<void> {
    const fetchFn = this.options.fetchFn ?? fetch;
    let response: Response;
    try {
      response = await fetchFn(`${server.url}/aiembodied/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: plan.file.downloadUrl,
          folder: plan.folder,
          filename: plan.file.name,
          sha256: plan.file.sha256,
          // Saved beside the file (family, trigger words); older add-ons ignore it.
          info: plan.info,
          // Sent to your own server so it can fetch from Civitai; it is not stored there.
          civitai_token: civitaiKey,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`${server.name} isn't answering.`);
    }
    if (response.status === 404) throw new Error(ADDON_HINT);
    const started = (await response.json().catch(() => ({}))) as WorkerStatus;
    if (!response.ok || !started.id) throw new Error(started.error || `${server.name} refused the download (${response.status}).`);
    const remoteId = started.id;
    this.apply(download, started);
    this.cancels.set(download.id, () => {
      void fetchFn(`${server.url}/aiembodied/download/${remoteId}`, { method: 'DELETE' }).catch(() => undefined);
    });
    let misses = 0;
    while (download.state === 'queued' || download.state === 'downloading' || download.state === 'verifying') {
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 2000));
      try {
        const poll = await fetchFn(`${server.url}/aiembodied/download/${remoteId}`, { signal: AbortSignal.timeout(10_000) });
        if (poll.status === 404) throw new Error(`${server.name} lost track of the download (was ComfyUI restarted?).`);
        this.apply(download, (await poll.json()) as WorkerStatus);
        misses = 0;
      } catch (error) {
        if (error instanceof Error && error.message.includes('lost track')) throw error;
        // A few missed polls are fine; ComfyUI can be busy.
        if (++misses >= 15) throw new Error(`${server.name} stopped answering during the download.`);
      }
    }
  }
}
