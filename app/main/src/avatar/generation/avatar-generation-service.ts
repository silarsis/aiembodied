/**
 * Local avatar generation: description → concept image → the bundled VRoid VRM with its
 * outfit and hair textures repainted to match. Everything runs on a local ComfyUI server, so
 * the result keeps the base model's rig, spring bones and expressions (and therefore lip-sync).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ComfyUIClient } from './comfyui-client.js';
import { buildConceptPrompt, conceptGraph, retextureGraph } from './graphs.js';
import { workerRetextureRunner, type RetextureRunner } from './retexture-tasks.js';
import type {
  AvatarGenerationAcceptance,
  AvatarGenerationJob,
  AvatarGenerationRequest,
  AvatarGenerationStatus,
  AvatarModelUploadRequest,
  AvatarModelUploadResult,
} from '../types.js';

export interface AvatarGenerationModelStore {
  uploadModel(request: AvatarModelUploadRequest): Promise<AvatarModelUploadResult>;
  setActiveModel(modelId: string | null): unknown;
}

export interface AvatarGenerationServiceOptions {
  comfy: ComfyUIClient;
  models: AvatarGenerationModelStore;
  /** VRoid VRM whose textures get repainted. */
  baseModelPath: string;
  /** Where in-progress and finished jobs keep their files. */
  workDirectory: string;
  runner?: RetextureRunner;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

interface JobState {
  status: AvatarGenerationStatus;
  prompt: string;
  directory: string;
  vrmPath: string | null;
  abort: AbortController;
}

const MAX_PROMPT_LENGTH = 1000;

export class AvatarGenerationService {
  private readonly jobs = new Map<string, JobState>();
  private readonly runner: RetextureRunner;

  constructor(private readonly options: AvatarGenerationServiceOptions) {
    this.runner = options.runner ?? workerRetextureRunner;
  }

  async startJob(request: AvatarGenerationRequest): Promise<AvatarGenerationJob> {
    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) {
      throw new Error('Describe the avatar you want to generate.');
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`Avatar description must be ${MAX_PROMPT_LENGTH} characters or fewer.`);
    }
    if ([...this.jobs.values()].some((job) => isActive(job.status.status))) {
      throw new Error('An avatar is already being generated. Wait for it to finish or discard it.');
    }
    if (!(await this.options.comfy.isAvailable())) {
      throw new Error(
        `ComfyUI isn't reachable at ${this.options.comfy.baseUrl}. Start ComfyUI (or set COMFYUI_BASE_URL) and try again.`,
      );
    }

    const jobId = randomUUID();
    const job: JobState = {
      status: { jobId, status: 'queued', progress: 0, message: 'Queued', previewDataUrl: null, errorMessage: null },
      prompt,
      directory: path.join(this.options.workDirectory, jobId),
      vrmPath: null,
      abort: new AbortController(),
    };
    this.jobs.set(jobId, job);
    this.options.logger?.info?.('Avatar generation started.', { jobId, promptLength: prompt.length });

    void this.run(job);
    return { jobId };
  }

  getStatus(jobId: string): AvatarGenerationStatus {
    return { ...this.getJob(jobId).status };
  }

  async accept(jobId: string): Promise<AvatarGenerationAcceptance> {
    const job = this.getJob(jobId);
    if (job.status.status !== 'completed' || !job.vrmPath) {
      throw new Error('This avatar is not finished yet.');
    }

    const data = await readFile(job.vrmPath);
    const { model } = await this.options.models.uploadModel({
      name: summarise(job.prompt),
      fileName: `generated-${jobId.slice(0, 8)}.vrm`,
      data: data.toString('base64'),
    });
    await this.options.models.setActiveModel(model.id);
    await this.discard(job);
    this.options.logger?.info?.('Generated avatar accepted.', { jobId, modelId: model.id });
    return { vrmId: model.id };
  }

  async reject(jobId: string): Promise<void> {
    const job = this.getJob(jobId);
    if (isActive(job.status.status)) {
      job.abort.abort();
      await this.options.comfy.interrupt();
    }
    await this.discard(job);
    this.options.logger?.info?.('Generated avatar discarded.', { jobId });
  }

  private getJob(jobId: string): JobState {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error('Unknown avatar generation job.');
    }
    return job;
  }

  private async discard(job: JobState): Promise<void> {
    this.jobs.delete(job.status.jobId);
    await rm(job.directory, { recursive: true, force: true });
  }

  private update(job: JobState, patch: Partial<AvatarGenerationStatus>): void {
    job.status = { ...job.status, ...patch };
  }

  private async run(job: JobState): Promise<void> {
    const { comfy } = this.options;
    const signal = job.abort.signal;
    const seed = randomInt(0, 2 ** 47);
    const started = Date.now();

    try {
      await mkdir(job.directory, { recursive: true });

      this.update(job, { status: 'concept', progress: 0.02, message: 'Drawing a concept image' });
      const concept = await comfy.run(conceptGraph(buildConceptPrompt(job.prompt), seed), { signal });
      await writeFile(path.join(job.directory, 'concept.png'), concept);
      this.update(job, {
        progress: 0.15,
        previewDataUrl: `data:image/png;base64,${concept.toString('base64')}`,
      });

      const baseVrm = await readFile(this.options.baseModelPath);
      const regions = await this.runner.prepare(baseVrm);
      const conceptName = await comfy.uploadImage(`${job.status.jobId}-concept.png`, concept);

      const edited = [];
      for (const [index, region] of regions.entries()) {
        throwIfAborted(signal);
        this.update(job, {
          status: 'texturing',
          progress: 0.15 + (0.75 * index) / regions.length,
          message: `Repainting ${region.name.replace('_', ' ')} (${index + 1} of ${regions.length})`,
        });
        const cropName = await comfy.uploadImage(`${job.status.jobId}-${region.name}.png`, region.png);
        const png = await comfy.run(
          retextureGraph({
            crop: cropName,
            cropWidth: region.box.width,
            cropHeight: region.box.height,
            concept: conceptName,
            prompt: region.prompt,
            seed,
          }),
          { signal },
        );
        edited.push({ box: region.box, png });
      }

      throwIfAborted(signal);
      this.update(job, { status: 'packaging', progress: 0.92, message: 'Building the VRM' });
      const vrm = await this.runner.assemble(baseVrm, edited, summarise(job.prompt));
      job.vrmPath = path.join(job.directory, 'avatar.vrm');
      await writeFile(job.vrmPath, vrm);

      this.update(job, { status: 'completed', progress: 1, message: 'Ready to review' });
      this.options.logger?.info?.('Avatar generation finished.', {
        jobId: job.status.jobId,
        seconds: Math.round((Date.now() - started) / 1000),
      });
    } catch (error) {
      if (signal.aborted) {
        this.update(job, { status: 'cancelled', message: 'Cancelled' });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.error?.('Avatar generation failed.', { jobId: job.status.jobId, message });
      this.update(job, { status: 'failed', message: 'Generation failed', errorMessage: message });
    }
  }
}

function isActive(status: AvatarGenerationStatus['status']): boolean {
  return status === 'queued' || status === 'concept' || status === 'texturing' || status === 'packaging';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Cancelled.');
  }
}

function summarise(prompt: string): string {
  const firstLine = prompt.split('\n')[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}
