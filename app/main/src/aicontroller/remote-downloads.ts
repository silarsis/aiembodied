/**
 * Downloads that run on another machine (or the controller's pick) through aicontroller's
 * POST /v1/models/download. The page polls the same lists as for this PC's own downloads, so each
 * controller job is shown as one of them (ids start with `ctl:`), with progress read from
 * GET /v1/downloads/{id}.
 */
import type { LlmDownload, LlmDownloadState } from '../local-llm/llm-library.js';
import type { HfQuant } from '../local-llm/huggingface.js';
import type { ModelDownload } from '../avatar/generation/model-downloads.js';
import type { CivitaiDownloadPlan } from '../avatar/generation/civitai.js';
import type { ControllerDownloadJob } from './bridge.js';
import type { DownloadOptions, DownloadSource } from './client.js';

/** "auto": the controller picks the machine by GPU fit and disk. */
export const AUTO_HOST = 'auto';
/** The machines a download can go to besides this PC. */
export interface DownloadHosts {
  /** The model controller is running. */
  inUse: boolean;
  /** This controller's machine name. */
  local: string | null;
  /** The other machines. */
  hosts: string[];
}

export const REMOTE_ID_PREFIX = 'ctl:';

export interface DownloadControllerApi {
  startDownload(source: DownloadSource, options: DownloadOptions): Promise<ControllerDownloadJob>;
  downloadJob(id: string): Promise<ControllerDownloadJob>;
  cancelDownload(id: string): Promise<void>;
}

const STATES: LlmDownloadState[] = ['queued', 'downloading', 'verifying', 'done', 'failed', 'cancelled'];

function stateOf(job: ControllerDownloadJob): LlmDownloadState {
  return (STATES as string[]).includes(job.state) ? (job.state as LlmDownloadState) : 'queued';
}

interface Tracked {
  kind: 'llm' | 'model';
  startedAt: number;
  last: ControllerDownloadJob;
  /** Shown for the machine the controller chose (known once it answers). */
  hostLabel: string;
  repo: string;
  quant: string;
  title: string;
  folder: string;
  fileName: string;
}

export class RemoteDownloads {
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly controller: DownloadControllerApi) {}

  static isRemoteId(id: string): boolean {
    return id.startsWith(REMOTE_ID_PREFIX);
  }

  /** A Hugging Face GGUF (all parts of the chosen size) to `host` (a machine name or "auto"). */
  async startHuggingFace(host: string, repo: string, quant: HfQuant): Promise<LlmDownload> {
    const first = quant.files[0];
    if (!first) throw new Error('That size has no files.');
    const job = await this.controller.startDownload({ type: 'huggingface', repo, file: first.path }, { kind: 'llm', host });
    const tracked: Tracked = {
      kind: 'llm',
      startedAt: Date.now(),
      last: job,
      hostLabel: job.host ?? host,
      repo,
      quant: quant.label,
      title: repo,
      folder: 'llm',
      fileName: first.path,
    };
    this.tracked.set(job.id, tracked);
    return this.toLlm(job.id, tracked, quant.sizeBytes);
  }

  /** A Civitai model to `host` (a machine name or "auto"). */
  async startCivitai(host: string, plan: CivitaiDownloadPlan): Promise<ModelDownload> {
    const job = await this.controller.startDownload(
      { type: 'civitai', url: `https://civitai.com/models/${plan.modelId}`, version_id: plan.versionId },
      { host },
    );
    const tracked: Tracked = {
      kind: 'model',
      startedAt: Date.now(),
      last: job,
      hostLabel: job.host ?? host,
      repo: '',
      quant: '',
      title: plan.title,
      folder: plan.folder,
      fileName: plan.file.name,
    };
    this.tracked.set(job.id, tracked);
    return this.toModel(job.id, tracked);
  }

  /** Refreshes the jobs still running from the controller. */
  private async poll(): Promise<void> {
    await Promise.all(
      [...this.tracked].map(async ([id, entry]) => {
        if (['done', 'failed', 'cancelled'].includes(entry.last.state)) return;
        try {
          entry.last = await this.controller.downloadJob(id);
          if (entry.last.host) entry.hostLabel = entry.last.host;
        } catch (error) {
          entry.last = { ...entry.last, state: 'failed', error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
  }

  async listLlm(): Promise<LlmDownload[]> {
    await this.poll();
    return [...this.tracked].filter(([, entry]) => entry.kind === 'llm').map(([id, entry]) => this.toLlm(id, entry));
  }

  async listModels(): Promise<ModelDownload[]> {
    await this.poll();
    return [...this.tracked].filter(([, entry]) => entry.kind === 'model').map(([id, entry]) => this.toModel(id, entry));
  }

  async cancel(id: string): Promise<void> {
    const key = id.slice(REMOTE_ID_PREFIX.length);
    if (this.tracked.has(key)) await this.controller.cancelDownload(key).catch(() => undefined);
  }

  private toLlm(id: string, entry: Tracked, total?: number): LlmDownload {
    const job = entry.last;
    const state = stateOf(job);
    return {
      id: `${REMOTE_ID_PREFIX}${id}`,
      repo: entry.repo,
      quant: entry.quant,
      label: `${entry.quant} on ${entry.hostLabel}`,
      state,
      received: job.bytesDone,
      total: job.bytesTotal ?? total ?? 0,
      use: false,
      ...(job.error ? { error: job.error } : {}),
      ...(state === 'done' ? { result: `Downloaded to ${entry.hostLabel}.` } : {}),
      startedAt: entry.startedAt,
    };
  }

  private toModel(id: string, entry: Tracked): ModelDownload {
    const job = entry.last;
    const state = stateOf(job);
    return {
      id: `${REMOTE_ID_PREFIX}${id}`,
      serverId: entry.hostLabel,
      serverName: entry.hostLabel,
      title: entry.title,
      folder: entry.folder,
      filename: job.fileName ?? entry.fileName,
      state,
      received: job.bytesDone,
      total: job.bytesTotal,
      ...(job.error ? { error: job.error } : {}),
      ...(state === 'done' ? { note: `On ${entry.hostLabel}.` } : {}),
      startedAt: entry.startedAt,
    };
  }
}
