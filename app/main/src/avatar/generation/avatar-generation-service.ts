/**
 * Local character jobs: generate new textured geometry and a rigged cartoon face, or explicitly
 * restyle the bundled VRM. Candidates stay separate from the active model until accepted.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ComfyUIClient } from './comfyui-client.js';
import { buildConceptPrompt, conceptGraph, retextureGraph } from './graphs.js';
import { workerRetextureRunner, type RetextureRunner } from './retexture-tasks.js';
import { characterConceptPrompt, characterMeshGraph } from './character/graphs.js';
import type { CharacterRigRunner } from './character/rig-runner.js';
import { regionPrompt } from './vrm-retexture.js';
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
  ensureComfyReady?: () => Promise<void>;
  models: AvatarGenerationModelStore;
  /** VRoid VRM whose textures get repainted. */
  baseModelPath: string;
  /** Where in-progress and finished jobs keep their files. */
  workDirectory: string;
  runner?: RetextureRunner;
  characterRunner?: CharacterRigRunner;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

interface JobState {
  mode: 'new-character' | 'restyle';
  status: AvatarGenerationStatus;
  prompt: string;
  directory: string;
  vrmPath: string | null;
  abort: AbortController;
}

const MAX_PROMPT_LENGTH = 1000;
/** Seeds tried per atlas region before falling back to its original texture. */
const MAX_REGION_ATTEMPTS = 2;
/**
 * Minimum `layoutSimilarity` for a repaint to be used. Against the bundled model, clean repaints
 * measured 0.73–0.98 (one at 0.52 that added a lot of new trim); ones where Qwen drew a character
 * or garments over the panels measured 0.11–0.57.
 */
const MIN_LAYOUT_SIMILARITY = 0.6;

export class AvatarGenerationService {
  private readonly jobs = new Map<string, JobState>();
  private readonly runner: RetextureRunner;

  constructor(private readonly options: AvatarGenerationServiceOptions) {
    this.runner = options.runner ?? workerRetextureRunner;
  }

  async startJob(request: AvatarGenerationRequest): Promise<AvatarGenerationJob> {
    const mode = request?.mode ?? 'new-character';
    if (mode !== 'new-character' && mode !== 'restyle')
      throw new Error('Unknown avatar generation mode.');
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
    if (mode === 'new-character') {
      if (!this.options.characterRunner)
        throw new Error('New 3D character generation is not configured.');
      await this.options.characterRunner.assertAvailable();
    }
    await this.options.ensureComfyReady?.();
    if (!(await this.options.comfy.isAvailable())) {
      throw new Error(
        `ComfyUI isn't reachable at ${this.options.comfy.baseUrl}. Start ComfyUI (or set COMFYUI_BASE_URL) and try again.`,
      );
    }
    // Another request may have finished the shared server-start wait just ahead of this one.
    if ([...this.jobs.values()].some((job) => isActive(job.status.status))) {
      throw new Error('An avatar is already being generated. Wait for it to finish or discard it.');
    }

    const jobId = randomUUID();
    const job: JobState = {
      mode,
      status: {
        jobId,
        status: 'queued',
        progress: 0,
        message: 'Queued',
        previewDataUrl: null,
        errorMessage: null,
      },
      prompt,
      directory: path.join(this.options.workDirectory, jobId),
      vrmPath: null,
      abort: new AbortController(),
    };
    this.jobs.set(jobId, job);
    this.options.logger?.info?.('Avatar generation started.', {
      jobId,
      promptLength: prompt.length,
    });

    void this.run(job);
    return { jobId };
  }

  getStatus(jobId: string): AvatarGenerationStatus {
    return { ...this.getJob(jobId).status };
  }

  /** Read the completed candidate for review without saving it or changing the active model. */
  async loadPreview(jobId: string): Promise<Buffer> {
    const job = this.getJob(jobId);
    if (job.status.status !== 'completed' || !job.vrmPath) {
      throw new Error('This avatar is not finished yet.');
    }
    return readFile(job.vrmPath);
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
      await writeFile(
        path.join(job.directory, 'request.json'),
        JSON.stringify({ prompt: job.prompt, mode: job.mode, seed }, null, 2),
      );

      this.update(job, { status: 'concept', progress: 0.02, message: 'Drawing a concept image' });
      const concept = await comfy.run(
        conceptGraph(
          job.mode === 'new-character'
            ? characterConceptPrompt(job.prompt)
            : buildConceptPrompt(job.prompt),
          seed,
        ),
        { signal },
      );
      throwIfAborted(signal);
      await writeFile(path.join(job.directory, 'concept.png'), concept);
      this.update(job, {
        progress: 0.15,
        previewDataUrl: `data:image/png;base64,${concept.toString('base64')}`,
      });

      if (job.mode === 'new-character') {
        this.update(job, {
          status: 'meshing',
          progress: 0.2,
          message: 'Generating new textured 3D geometry',
        });
        const reference = await comfy.uploadImage(`${job.status.jobId}-concept.png`, concept);
        const mesh = await comfy.run(characterMeshGraph(reference, seed), {
          signal,
          output: 'mesh',
        });
        throwIfAborted(signal);
        const meshPath = path.join(job.directory, 'source.glb');
        await writeFile(meshPath, mesh);
        throwIfAborted(signal);
        this.update(job, {
          status: 'rigging',
          progress: 0.8,
          message: 'Building the body skeleton, eyes, mouth and expressions',
        });
        const runner = this.options.characterRunner;
        if (!runner) throw new Error('New character rigging is unavailable.');
        job.vrmPath = path.join(job.directory, 'avatar.vrm');
        await runner.build({
          meshPath,
          outputPath: job.vrmPath,
          name: summarise(job.prompt),
          signal,
        });
        throwIfAborted(signal);
        this.update(job, {
          status: 'completed',
          progress: 1,
          message: 'New 3D character ready for review',
        });
        this.options.logger?.info?.('New 3D character generated.', {
          jobId: job.status.jobId,
          seconds: Math.round((Date.now() - started) / 1000),
        });
        return;
      }

      const baseVrm = await readFile(this.options.baseModelPath);
      const regions = await this.runner.prepare(baseVrm);

      const edited = [];
      for (const [index, region] of regions.entries()) {
        const label = `${region.name.replace('_', ' ')} (${index + 1} of ${regions.length})`;
        const cropName = await comfy.uploadImage(
          `${job.status.jobId}-${region.name}.png`,
          region.png,
        );
        let best: { png: Buffer; score: number } | null = null;
        for (let attempt = 0; attempt < MAX_REGION_ATTEMPTS; attempt += 1) {
          throwIfAborted(signal);
          this.update(job, {
            status: 'texturing',
            progress: 0.15 + (0.75 * (index + attempt / MAX_REGION_ATTEMPTS)) / regions.length,
            message:
              attempt === 0 ? `Repainting ${label}` : `Repainting ${label}, retry ${attempt}`,
          });
          const png = await comfy.run(
            retextureGraph({
              crop: cropName,
              cropWidth: region.box.width,
              cropHeight: region.box.height,
              prompt: regionPrompt(region.prompt, job.prompt),
              seed: seed + attempt,
            }),
            { signal },
          );
          const score = await this.runner.score(region.png, png);
          if (!best || score > best.score) {
            best = { png, score };
          }
          if (score >= MIN_LAYOUT_SIMILARITY) {
            break;
          }
          this.options.logger?.warn?.('Repainted region lost the atlas layout.', {
            jobId: job.status.jobId,
            region: region.name,
            attempt,
            score: Number(score.toFixed(3)),
          });
        }
        if (best && best.score >= MIN_LAYOUT_SIMILARITY) {
          edited.push({ box: region.box, png: best.png });
        } else {
          this.options.logger?.warn?.(
            'Keeping the original texture for a region that never repainted cleanly.',
            {
              jobId: job.status.jobId,
              region: region.name,
            },
          );
        }
      }

      if (edited.length === 0) {
        throw new Error(
          "The texture repaint didn't keep the model's layout. Try again, or describe the colours more plainly.",
        );
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
      this.options.logger?.error?.('Avatar generation failed.', {
        jobId: job.status.jobId,
        message,
      });
      this.update(job, { status: 'failed', message: 'Generation failed', errorMessage: message });
    }
  }
}

function isActive(status: AvatarGenerationStatus['status']): boolean {
  return ['queued', 'concept', 'meshing', 'rigging', 'texturing', 'packaging'].includes(status);
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
