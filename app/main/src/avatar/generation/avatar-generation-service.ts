/**
 * Local character jobs: generate new textured geometry and a rigged cartoon face, or explicitly
 * restyle the bundled VRM. Candidates stay separate from the active model until accepted.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ComfyUIClient } from './comfyui-client.js';
import {
  buildConceptPrompt,
  characterViewGraph,
  conceptGraph,
  retextureGraph,
  type QwenImageModels,
} from './graphs.js';
import { workerRetextureRunner, type RetextureRunner } from './retexture-tasks.js';
import {
  CHARACTER_VIEW_PROMPTS,
  characterConceptPrompt,
  characterMeshGraph,
  type CharacterViewImages,
} from './character/graphs.js';
import type { CharacterRigRunner } from './character/rig-runner.js';
import type { AvatarImageModelService } from './image-model-service.js';
import {
  usesViews,
  type AvatarCharacterModelService,
  type GeometryModel,
  type RigModel,
} from './character-model-service.js';
import {
  applyLoras,
  buildAvatarImageWorkflow,
  type ImageWorkflowLora,
  type ImageWorkflowModel,
} from './image-workflows.js';
import { drawPoseSkeleton, poseImageSize } from './pose-control.js';
import { templatePolicy } from './template-compatibility.js';
import { decodeReferenceImage } from './reference-image.js';
import { regionPrompt } from './vrm-retexture.js';
import type {
  AvatarGenerationAcceptance,
  AvatarGenerationJob,
  AvatarGenerationRequest,
  AvatarGenerationStatus,
  AvatarGenerationConfirmation,
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
  /**
   * Picks the ComfyUI server for a job's image or 3D stage (Models and servers), starting this
   * PC's one if needed. Without it every stage uses `comfy`.
   */
  pickComfy?: (stage: 'image' | 'mesh') => Promise<ComfyUIClient>;
  models: AvatarGenerationModelStore;
  /** VRoid VRM whose textures get repainted. */
  baseModelPath: string;
  /** Where in-progress and finished jobs keep their files. */
  workDirectory: string;
  runner?: RetextureRunner;
  characterRunner?: CharacterRigRunner;
  imageModels?: Pick<AvatarImageModelService, 'resolve'> &
    Partial<Pick<AvatarImageModelService, 'resolveViewModel' | 'list'>>;
  /** Chooses the 3D geometry and rig models; the workflow defaults run without it. */
  characterModels?: Pick<AvatarCharacterModelService, 'resolveGeometry' | 'resolveRig'>;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

interface JobState {
  /** The ComfyUI server that drew the concept, and the one the build stage runs on. */
  imageComfy?: ComfyUIClient;
  buildComfy?: ComfyUIClient;
  imageModel?: ImageWorkflowModel;
  geometry?: GeometryModel;
  rig?: RigModel;
  landmarksPath?: string;
  referenceImage: Buffer | null;
  seed: number;
  mode: 'new-character' | 'restyle';
  status: AvatarGenerationStatus;
  prompt: string;
  directory: string;
  vrmPath: string | null;
  abort: AbortController;
}

const MAX_PROMPT_LENGTH = 1000;
const VIEWS_AFTER_APPROVAL =
  'Side and back views are drawn with Qwen-Image after you approve this image, or draw them now to check them first.';
/** Seeds tried per atlas region before falling back to its original texture. */
const MAX_REGION_ATTEMPTS = 2;
/** Fronts drawn per take when one shows several characters or no usable face. */
const MAX_FRONT_ATTEMPTS = 3;
/**
 * Minimum `layoutSimilarity` for a repaint to be used. Against the bundled model, clean repaints
 * measured 0.73–0.98 (one at 0.52 that added a lot of new trim); ones where Qwen drew a character
 * or garments over the panels measured 0.11–0.57.
 */
const MIN_LAYOUT_SIMILARITY = 0.6;

export class AvatarGenerationService {
  private readonly jobs = new Map<string, JobState>();
  /** Take numbers stay fixed when other takes are kept or discarded. */
  private nextTakeNumber = 1;
  private readonly runner: RetextureRunner;

  constructor(private readonly options: AvatarGenerationServiceOptions) {
    this.runner = options.runner ?? workerRetextureRunner;
  }

  async startJob(request: AvatarGenerationRequest): Promise<AvatarGenerationJob> {
    const mode = request?.mode ?? 'new-character';
    if (mode !== 'new-character' && mode !== 'restyle')
      throw new Error('Unknown avatar generation mode.');
    const referenceImage = decodeReferenceImage(request?.referenceImage);
    if (referenceImage && mode !== 'new-character')
      throw new Error('Image upload is available for new 3D characters.');
    const prompt =
      (typeof request?.prompt === 'string' ? request.prompt.trim() : '') ||
      (referenceImage ? 'Uploaded character reference' : '');
    if (!prompt) {
      throw new Error('Describe the avatar you want to generate.');
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`Avatar description must be ${MAX_PROMPT_LENGTH} characters or fewer.`);
    }
    this.assertIdle();
    if (mode === 'new-character') {
      if (!this.options.characterRunner)
        throw new Error('New 3D character generation is not configured.');
    }
    const imageComfy = referenceImage ? undefined : await this.comfyFor('image');
    // Another request may have finished the shared server-start wait just ahead of this one.
    this.assertIdle();

    const imageModel = !referenceImage
      ? await this.options.imageModels?.resolve(request.imageModelId)
      : undefined;
    this.assertIdle();
    const jobId = randomUUID();
    const job: JobState = {
      imageComfy,
      imageModel,
      referenceImage,
      seed: randomInt(0, 2 ** 47),
      mode,
      status: {
        jobId,
        status: 'queued',
        progress: 0,
        message: 'Queued',
        previewDataUrl: null,
        errorMessage: null,
        prompt,
        mode,
        source: referenceImage ? 'upload' : 'text',
        createdAt: Date.now(),
        takeNumber: this.nextTakeNumber++,
        imageModelName: imageModel?.name ?? null,
        geometryModelName: null,
        rigModelName: null,
        buildSeconds: null,
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

  /**
   * On request, cut the character out of this take's image onto plain white, for face fitting
   * and the 3D step. The original is kept beside it and can be restored.
   */
  async removeConceptBackground(jobId: string): Promise<void> {
    const job = this.getJob(jobId);
    if (isRunning(job.status.status)) throw new Error('Wait for this take to finish first.');
    if (!job.status.previewDataUrl) throw new Error('This take has no image yet.');
    const runner = this.options.characterRunner;
    if (!runner?.removeBackground) throw new Error('Background removal is unavailable.');
    const concept = path.join(job.directory, 'concept.png');
    const original = path.join(job.directory, 'concept-original.png');
    const cutout = path.join(job.directory, 'concept-cutout.png');
    if (!(await access(original).then(() => true, () => false))) await copyFile(concept, original);
    const message = job.status.message;
    this.update(job, { message: 'Removing the background', errorMessage: null });
    try {
      await runner.removeBackground({ imagePath: original, outputPath: cutout, signal: AbortSignal.timeout(5 * 60_000) });
    } catch (error) {
      this.update(job, { message });
      throw error;
    }
    const image = await readFile(cutout);
    await writeFile(concept, image);
    this.useConceptImage(job, image, true, 'Background removed. Check the image, then build.');
  }

  /** Put back the image as it was generated or uploaded. */
  async restoreConceptBackground(jobId: string): Promise<void> {
    const job = this.getJob(jobId);
    if (isRunning(job.status.status)) throw new Error('Wait for this take to finish first.');
    const original = path.join(job.directory, 'concept-original.png');
    const image = await readFile(original).catch(() => {
      throw new Error('There is no original image to restore.');
    });
    await writeFile(path.join(job.directory, 'concept.png'), image);
    this.useConceptImage(job, image, false, 'Original image restored');
  }

  /** Draw this take's side and back views again from its current front image. */
  async redrawViews(jobId: string): Promise<void> {
    const job = this.getJob(jobId);
    if (job.mode !== 'new-character') throw new Error('Only new 3D characters use side and back views.');
    if (!job.status.previewDataUrl) throw new Error('This take has no image yet.');
    if (isRunning(job.status.status)) throw new Error('Wait for this take to finish first.');
    this.assertIdle();
    job.abort = new AbortController();
    const previous = job.status.status;
    const message = job.status.message;
    this.update(job, { status: 'concept', message: 'Drawing the side and back views', errorMessage: null });
    void this.drawViews(job, () => this.comfyFor('image'), job.abort.signal, randomInt(0, 2 ** 47))
      .catch(() => undefined)
      .finally(() => {
        if (job.status.status === 'concept')
          this.update(job, { status: previous, message: job.abort.signal.aborted ? 'Cancelled' : message });
      });
  }

  /**
   * Draw the character's left side and back from the approved front image, for 3D models that take
   * several views. A view that can't be drawn is left out (the build then uses what there is) and
   * the reason is shown with the take.
   */
  private async drawViews(
    job: JobState,
    getComfy: () => Promise<ComfyUIClient>,
    signal: AbortSignal,
    seed: number,
  ): Promise<void> {
    // Only an installed Qwen-Image model can draw them; without the model list there is none to use.
    const model = await this.options.imageModels?.resolveViewModel
      ?.call(this.options.imageModels, job.imageModel)
      .catch(() => undefined);
    const models: QwenImageModels | undefined =
      model?.clip && model.vae ? { unet: model.model, clip: model.clip, vae: model.vae } : undefined;
    const loras: ImageWorkflowLora[] = model?.loras ?? [];
    if (!models) {
      this.update(job, {
        views: {},
        viewsMessage:
          'Side and back views need Qwen-Image 2.1 in ComfyUI. Builds will use the front image only.',
      });
      return;
    }
    const views: { left?: string | null; back?: string | null } = {};
    this.update(job, { views, viewsMessage: null });
    try {
      const comfy = await getComfy();
      const front = await readFile(path.join(job.directory, 'concept.png'));
      const frontName = await comfy.uploadImage(`${job.status.jobId}-front.png`, front);
      for (const [index, view] of (['left', 'back'] as const).entries()) {
        throwIfAborted(signal);
        this.update(job, {
          message: view === 'left' ? 'Drawing the side view' : 'Drawing the back view',
        });
        const { prompt, negative } = CHARACTER_VIEW_PROMPTS[view];
        const triggers = [...new Set(loras.flatMap((lora) => lora.triggerWords ?? []))].join(', ');
        const graph = characterViewGraph({
          front: frontName,
          prompt: triggers ? `${triggers}, ${prompt}` : prompt,
          negative,
          seed: seed + index,
          models,
        });
        const png = await comfy.run(loras.length ? applyLoras(graph, loras) : graph, { signal });
        throwIfAborted(signal);
        await writeFile(path.join(job.directory, `view-${view}.png`), png);
        views[view] = `data:image/png;base64,${png.toString('base64')}`;
        this.update(job, { views: { ...views } });
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn?.('Could not draw the character views.', { jobId: job.status.jobId, reason });
      this.update(job, {
        viewsMessage: `The side and back views could not be drawn: ${reason}`,
      });
    }
  }

  /** Whether both views are on disk for this take's current front image. */
  private async hasViews(job: JobState): Promise<boolean> {
    for (const view of ['left', 'back'] as const) {
      if (!job.status.views?.[view]) return false;
      const found = await access(path.join(job.directory, `view-${view}.png`)).then(
        () => true,
        () => false,
      );
      if (!found) return false;
    }
    return true;
  }

  /** The uploaded names of the views a geometry model is given: TRELLIS.2 only ever gets the front. */
  private async uploadViews(
    job: JobState,
    comfy: ComfyUIClient,
    concept: Buffer,
  ): Promise<CharacterViewImages> {
    const images: CharacterViewImages = {
      front: await comfy.uploadImage(`${job.status.jobId}-concept.png`, concept),
    };
    if (!usesViews(job.geometry)) return images;
    for (const view of ['left', 'back'] as const) {
      const png = await readFile(path.join(job.directory, `view-${view}.png`)).catch(() => null);
      if (png) images[view] = await comfy.uploadImage(`${job.status.jobId}-${view}.png`, png);
    }
    return images;
  }

  /**
   * Check a new front before anything slow runs on it. A background that isn't light and neutral
   * is cut away (the original is kept, as with Remove background). A front that shows more than
   * one character, or no face the fitter can use, is drawn again with another seed, up to
   * MAX_FRONT_ATTEMPTS times; an upload is checked but never redrawn. What is still wrong after
   * the last attempt is shown at review. The face found here is reused by the build. A rig that
   * finds a stylised face on the built head skips the face check, which only knows human faces.
   */
  private async checkFront(
    job: JobState,
    first: Buffer,
    redraw: ((attempt: number) => Promise<Buffer>) | null,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const runner = this.options.characterRunner;
    if (!runner?.checkFront || !runner.prepareReference) return first;
    const conceptPath = path.join(job.directory, 'concept.png');
    const originalPath = path.join(job.directory, 'concept-original.png');
    const cutoutPath = path.join(job.directory, 'concept-cutout.png');
    let image = first;
    let problem: string | null = null;
    try {
      await runner.assertAvailable();
      const rig = await this.options.characterModels?.resolveRig().catch(() => undefined);
      const findFace = rig?.face !== 'stylised';
      for (let attempt = 1; ; attempt++) {
        if (attempt > 1 && redraw) {
          await copyFile(conceptPath, path.join(job.directory, `concept-rejected-${attempt - 1}.png`));
          this.update(job, { message: `Drawing the front again: ${problem}` });
          image = await redraw(attempt);
          throwIfAborted(signal);
          await writeFile(conceptPath, image);
          this.update(job, { previewDataUrl: `data:image/png;base64,${image.toString('base64')}` });
        }
        this.update(job, { message: 'Checking the front image' });
        let check = await runner.checkFront({ imagePath: conceptPath, signal });
        let backgroundRemoved = false;
        await rm(originalPath, { force: true });
        if (!check.backgroundOk && runner.removeBackground) {
          this.update(job, { message: 'Removing the background' });
          await writeFile(originalPath, image);
          await runner.removeBackground({ imagePath: originalPath, outputPath: cutoutPath, signal });
          image = await readFile(cutoutPath);
          await writeFile(conceptPath, image);
          backgroundRemoved = true;
          check = await runner.checkFront({ imagePath: conceptPath, signal });
        }
        problem = null;
        job.landmarksPath = undefined;
        if (check.figures !== null && check.figures > 1) {
          problem = `It shows ${check.figures} characters instead of one.`;
        } else if (findFace) {
          this.update(job, { message: 'Finding the face' });
          try {
            job.landmarksPath = await runner.prepareReference({
              referencePath: conceptPath,
              outputPath: path.join(job.directory, 'avatar.vrm'),
              signal,
            });
          } catch (error) {
            throwIfAborted(signal);
            problem = (error instanceof Error ? error.message : String(error)).replace(
              /^The reference face could not be fitted: /,
              '',
            );
          }
        }
        this.update(job, {
          previewDataUrl: `data:image/png;base64,${image.toString('base64')}`,
          backgroundRemoved,
          frontCheck: { attempts: attempt, problem },
        });
        if (!problem || !redraw || attempt >= MAX_FRONT_ATTEMPTS) return image;
      }
    } catch (error) {
      throwIfAborted(signal);
      // The checks are a safeguard: when their tools are missing or fail, review goes ahead without them.
      this.options.logger?.warn?.('Could not check the front image.', {
        jobId: job.status.jobId,
        message: error instanceof Error ? error.message : String(error),
      });
      return image;
    }
  }

  private useConceptImage(job: JobState, image: Buffer, backgroundRemoved: boolean, message: string): void {
    // A changed image needs its face found again before the next build.
    job.landmarksPath = undefined;
    this.update(job, {
      previewDataUrl: `data:image/png;base64,${image.toString('base64')}`,
      backgroundRemoved,
      warnings: [],
      warningsAccepted: false,
      message,
      errorMessage: null,
    });
  }

  /** Explicit approval is the only entry to geometry, rigging or texture work. */
  async confirmConcept(jobId: string, confirmation?: AvatarGenerationConfirmation): Promise<void> {
    const job = this.getJob(jobId);
    const rebuild = ['completed', 'failed', 'cancelled'].includes(job.status.status);
    if (job.status.status !== 'awaiting_confirmation' && !rebuild)
      throw new Error('This concept is not awaiting confirmation.');
    if (rebuild && !job.status.previewDataUrl)
      throw new Error('This take has no image to build from. Generate a new one.');
    if ([...this.jobs.values()].some((other) => other !== job && isRunning(other.status.status)))
      throw new Error('Another avatar is being generated. Wait for it to finish or cancel it.');
    const previous = job.status.status;
    const previousMessage = job.status.message;
    if (rebuild) {
      job.abort = new AbortController();
      job.vrmPath = null;
    }
    const warningsAlreadyShown = Boolean(job.status.warnings?.length);
    this.update(job, { status: 'queued', message: 'Checking the reference', errorMessage: null });
    try {
      if (job.mode === 'new-character') {
        const runner = this.options.characterRunner;
        if (this.options.characterModels) {
          job.geometry = await this.options.characterModels.resolveGeometry(
            confirmation?.geometryModelId,
          );
          job.rig = await this.options.characterModels.resolveRig(confirmation?.rigModelId);
        }
        this.update(job, {
          geometryModelName: job.geometry?.name ?? 'TRELLIS.2',
          rigModelName: job.rig?.name ?? 'Blender auto-rig with fitted face',
        });
        await runner?.assertAvailable();
        // A stylised face is found on the painted 3D model while rigging, so only the fitted
        // (MediaPipe) face is checked here, along with its human-face template warnings.
        const fitted = (job.rig?.face ?? 'fitted') === 'fitted';
        if (fitted && !job.landmarksPath)
          job.landmarksPath = await runner?.prepareReference?.({
            referencePath: path.join(job.directory, 'concept.png'),
            outputPath: path.join(job.directory, 'avatar.vrm'),
            signal: job.abort.signal,
          });
        const warnings =
          fitted && job.landmarksPath
            ? ((await runner?.inspectReference?.(job.landmarksPath)) ?? [])
            : [];
        throwIfAborted(job.abort.signal);
        if (this.jobs.get(jobId) !== job)
          throw new Error('This avatar generation job was discarded.');
        this.update(job, { warnings });
        if (warnings.length && !(warningsAlreadyShown && confirmation?.acceptWarnings === true)) {
          this.update(job, {
            status: rebuild ? previous : 'awaiting_confirmation',
            message: 'Review the compatibility warnings before continuing',
          });
          return;
        }
      }
      job.buildComfy = await this.comfyFor(job.mode === 'new-character' ? 'mesh' : 'image');
      throwIfAborted(job.abort.signal);
      if (this.jobs.get(jobId) !== job)
        throw new Error('This avatar generation job was discarded.');
      const warningsAccepted =
        Boolean(job.status.warnings?.length) &&
        confirmation?.acceptWarnings === true &&
        warningsAlreadyShown;
      this.update(job, { warningsAccepted });
      await writeFile(
        path.join(job.directory, 'review.json'),
        JSON.stringify(
          {
            templatePolicyVersion: templatePolicy.version,
            warnings: job.status.warnings ?? [],
            warningsAccepted,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      if (!job.abort.signal.aborted && this.jobs.get(jobId) === job)
        this.update(job, {
          status: rebuild ? previous : 'awaiting_confirmation',
          message: rebuild ? previousMessage : 'Review the concept image before continuing',
        });
      throw error;
    }
    void this.run(job, 'build');
  }

  getStatus(jobId: string): AvatarGenerationStatus {
    const status = this.getJob(jobId).status;
    return {
      ...status,
      ...(status.warnings ? { warnings: status.warnings.map((w) => ({ ...w })) } : {}),
    };
  }

  /** Every take in this session, oldest first, for the studio history. */
  listJobs(): AvatarGenerationStatus[] {
    return [...this.jobs.values()]
      .sort((a, b) => (a.status.createdAt ?? 0) - (b.status.createdAt ?? 0))
      .map((job) => this.getStatus(job.status.jobId));
  }

  /** Stop a running job but keep its image, so it can be rebuilt or discarded later. */
  cancel(jobId: string): void {
    const job = this.getJob(jobId);
    if (!isRunning(job.status.status)) throw new Error('This avatar is not being generated.');
    job.abort.abort();
    this.update(job, { status: 'cancelled', message: 'Cancelled' });
    this.options.logger?.info?.('Avatar generation cancelled.', { jobId });
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
    if (isRunning(job.status.status)) {
      job.abort.abort();
    }
    await this.discard(job);
    this.options.logger?.info?.('Generated avatar discarded.', { jobId });
  }

  private assertIdle(): void {
    if ([...this.jobs.values()].some((job) => isRunning(job.status.status)))
      throw new Error('An avatar is already being generated. Wait for it to finish or cancel it.');
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

  /**
   * Repaint the front of the head, where the three drawings disagree most. It's an extra: whatever
   * goes wrong, the painted model is still good, and the job says why the close-up was left out.
   */
  private async paintHead(
    job: JobState,
    runner: CharacterRigRunner,
    meshPath: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!runner.paintHead) return;
    const skipped = (reason: string) => {
      this.options.logger?.warn?.('Avatar head close-up skipped.', { jobId: job.status.jobId, reason });
      this.update(job, { headPaint: { painted: false, reason } });
    };
    try {
      const checkpoint = await this.headCheckpoint(job);
      if (!checkpoint) {
        skipped('There is no SDXL model in ComfyUI to draw it with.');
        return;
      }
      this.update(job, { progress: 0.68, message: 'Repainting the face for a cleaner close-up' });
      const output = path.join(job.directory, 'source-head.glb');
      await runner.paintHead({
        meshPath,
        outputPath: output,
        reference,
        prompt: job.prompt,
        checkpoint,
        signal,
      });
      await rename(meshPath, path.join(job.directory, 'source-painted.glb'));
      await rename(output, meshPath);
      this.update(job, { headPaint: { painted: true } });
    } catch (error) {
      if (signal.aborted) throw error;
      skipped(error instanceof Error ? error.message : String(error));
    }
  }

  /** The front's own model when it's SDXL, else the first SDXL model installed. */
  private async headCheckpoint(job: JobState): Promise<string | undefined> {
    if (job.imageModel?.family === 'sdxl') return job.imageModel.model;
    const models = await this.options.imageModels?.list?.call(this.options.imageModels);
    const families = models?.modelFamilies ?? {};
    const id = Object.keys(families).find((key) => families[key] === 'sdxl');
    return id?.slice(id.indexOf(':') + 1);
  }

  /** The ComfyUI server for a stage, started and checked. */
  private async comfyFor(stage: 'image' | 'mesh'): Promise<ComfyUIClient> {
    if (this.options.pickComfy) return this.options.pickComfy(stage);
    await this.options.ensureComfyReady?.();
    if (!(await this.options.comfy.isAvailable())) {
      throw new Error(
        `ComfyUI isn't reachable at ${this.options.comfy.baseUrl}. Start ComfyUI (or choose another server in Models and servers) and try again.`,
      );
    }
    return this.options.comfy;
  }

  private async run(job: JobState, phase: 'concept' | 'build' = 'concept'): Promise<void> {
    const comfy = (phase === 'concept' ? job.imageComfy : job.buildComfy) ?? this.options.comfy;
    const signal = job.abort.signal;
    const seed = job.seed;
    const started = Date.now();

    try {
      if (phase === 'concept') {
        await mkdir(job.directory, { recursive: true });
        await writeFile(
          path.join(job.directory, 'request.json'),
          JSON.stringify(
            { prompt: job.prompt, mode: job.mode, imageModel: job.imageModel, seed },
            null,
            2,
          ),
        );

        this.update(job, {
          status: 'concept',
          progress: 0.02,
          message: job.referenceImage ? 'Preparing uploaded image' : 'Drawing a concept image',
        });
        const prompt =
          job.mode === 'new-character'
            ? characterConceptPrompt(job.prompt)
            : buildConceptPrompt(job.prompt);
        // Models with pose control draw the front over the A-pose skeleton.
        const pose = job.imageModel ? poseImageSize(job.imageModel) : undefined;
        const poseImage = pose && !job.referenceImage
          ? await comfy.uploadImage(`a-pose-${pose.width}x${pose.height}.png`, drawPoseSkeleton(pose.width, pose.height))
          : undefined;
        const draw = (drawSeed: number) =>
          comfy.run(
            job.imageModel
              ? buildAvatarImageWorkflow(job.imageModel, job.prompt, job.mode, drawSeed, poseImage)
              : conceptGraph(prompt, drawSeed),
            { signal },
          );
        let concept = job.referenceImage ?? (await draw(seed));
        throwIfAborted(signal);
        await writeFile(path.join(job.directory, 'concept.png'), concept);
        if (job.mode === 'new-character') {
          this.update(job, {
            progress: 0.08,
            previewDataUrl: `data:image/png;base64,${concept.toString('base64')}`,
          });
          concept = await this.checkFront(
            job,
            concept,
            job.referenceImage ? null : (attempt) => draw(seed + attempt * 7919),
            signal,
          );
          throwIfAborted(signal);
          if (job.imageModel?.family === 'qwen-image-2.1') {
            // A Qwen-Image front draws its own side and back views straight away (same model, one hop).
            const imageComfy = job.imageComfy;
            await this.drawViews(
              job,
              () => (imageComfy ? Promise.resolve(imageComfy) : this.comfyFor('image')),
              signal,
              seed + 101,
            );
            throwIfAborted(signal);
          } else {
            // Any other front (or an upload) waits for approval first, so the image model can be
            // judged before Qwen-Image spends minutes on the views.
            this.update(job, { views: {}, viewsMessage: VIEWS_AFTER_APPROVAL });
          }
        }
        this.update(job, {
          status: 'awaiting_confirmation',
          message: 'Review the concept image before continuing',
          progress: 0.15,
          previewDataUrl: `data:image/png;base64,${concept.toString('base64')}`,
        });

        return;
      }
      const concept = await readFile(path.join(job.directory, 'concept.png'));
      throwIfAborted(signal);

      if (job.mode === 'new-character') {
        const runner = this.options.characterRunner;
        if (!runner) throw new Error('New character rigging is unavailable.');
        job.vrmPath = path.join(job.directory, 'avatar.vrm');
        const painted = usesViews(job.geometry);
        if (painted && !runner.paintViews)
          throw new Error('Painting views onto the model is unavailable. Choose TRELLIS.2 instead.');
        this.update(job, {
          status: 'meshing',
          headPaint: undefined,
          progress: 0.2,
          message: painted
            ? 'Generating the 3D shape from the front, side and back views'
            : 'Generating new textured 3D geometry',
        });
        if (painted && !(await this.hasViews(job))) {
          // Views weren't drawn with the image (another model's front, or an upload): draw them now.
          this.update(job, { progress: 0.17, message: 'Drawing the side and back views' });
          await this.drawViews(job, () => this.comfyFor('image'), signal, seed + 101);
          throwIfAborted(signal);
          this.update(job, {
            progress: 0.2,
            message: 'Generating the 3D shape from the front, side and back views',
          });
        }
        const images = await this.uploadViews(job, comfy, concept);
        const mesh = await comfy.run(characterMeshGraph(images, seed, job.geometry), {
          signal,
          output: 'mesh',
        });
        throwIfAborted(signal);
        const meshPath = path.join(job.directory, 'source.glb');
        if (painted && runner.paintViews) {
          const shapePath = path.join(job.directory, 'source-shape.glb');
          await writeFile(shapePath, mesh);
          this.update(job, { progress: 0.65, message: 'Painting the views onto the model' });
          const cut = async (view: string, file: string, already = false): Promise<string> => {
            const source = path.join(job.directory, file);
            if (already || !runner.removeBackground) return source;
            // Painting finds the character by its white surroundings, so give it clean cut-outs.
            const output = path.join(job.directory, `paint-${view}.png`);
            return runner
              .removeBackground({ imagePath: source, outputPath: output, signal })
              .then(() => output)
              .catch((error: unknown) => {
                if (signal.aborted) throw error;
                return source;
              });
          };
          const front = await cut('front', 'concept.png', job.status.backgroundRemoved === true);
          await runner.paintViews({
            meshPath: shapePath,
            outputPath: meshPath,
            front,
            ...(images.left ? { left: await cut('left', 'view-left.png') } : {}),
            ...(images.back ? { back: await cut('back', 'view-back.png') } : {}),
            signal,
          });
          await this.paintHead(job, runner, meshPath, front, signal);
        } else {
          await writeFile(meshPath, mesh);
        }
        throwIfAborted(signal);
        this.update(job, {
          status: 'rigging',
          progress: 0.8,
          message: 'Fitting the face, body skeleton and animated expressions',
        });
        const stylised = job.rig?.face === 'stylised';
        // Qwen3-VL lives with the image model, on the image server.
        const vision = stylised
          ? {
              comfyUrl: (await this.comfyFor('image')).baseUrl,
              ...(job.rig?.visionModel ? { model: job.rig.visionModel } : {}),
            }
          : undefined;
        await runner.build({
          landmarksPath: stylised ? undefined : job.landmarksPath,
          allowTemplateWarnings: job.status.warningsAccepted === true,
          meshPath,
          referencePath: path.join(job.directory, 'concept.png'),
          outputPath: job.vrmPath,
          name: summarise(job.prompt),
          faceStyle: stylised ? 'stylised' : 'fitted',
          ...(vision ? { vision } : {}),
          signal,
        });
        throwIfAborted(signal);
        this.update(job, {
          status: 'completed',
          progress: 1,
          message: 'New 3D character ready for review',
          buildSeconds: Math.round((Date.now() - started) / 1000),
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

      this.update(job, {
        status: 'completed',
        progress: 1,
        message: 'Ready to review',
        buildSeconds: Math.round((Date.now() - started) / 1000),
      });
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

/** Work in progress that uses ComfyUI or Blender; only one job runs at a time. */
function isRunning(status: AvatarGenerationStatus['status']): boolean {
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
