/**
 * Animation generation backed by the local motion service: a text prompt goes to ARDY or
 * Kimodo running on this machine, and the retargeted VRMA JSON comes back ready to encode.
 * Replaces the three-step OpenAI keyframe pipeline when the service is running.
 */
import { encodeVrmaGlb } from '../vrma-converter.js';
import { VRMA_SLUG_PATTERN } from '../vrma-schema.js';
import type { AvatarAnimationService } from '../avatar-animation-service.js';
import type {
  AvatarAnimationGenerationRequest,
  AvatarAnimationUploadResult,
  AvatarMotionChunkEvent,
  AvatarMotionStreamRequest,
  AvatarMotionStreamResult,
} from '../types.js';
import type { LocalMotionClient, MotionServiceHealth } from './local-motion-client.js';

export interface LocalMotionGenerationServiceOptions {
  client: LocalMotionClient;
  animationService: Pick<AvatarAnimationService, 'uploadAnimation'>;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
}

const DEFAULT_CLIP_DURATION = 3;
const DEFAULT_STREAM_DURATION = 4;
const MAX_CLIP_DURATION = 10;
const MAX_STREAM_DURATION = 20;
const MAX_SLUG_LENGTH = 40;

export class LocalMotionGenerationService {
  private readonly client: LocalMotionClient;
  private readonly animationService: Pick<AvatarAnimationService, 'uploadAnimation'>;
  private readonly logger: LocalMotionGenerationServiceOptions['logger'];
  private readonly now: () => number;

  constructor(options: LocalMotionGenerationServiceOptions) {
    this.client = options.client;
    this.animationService = options.animationService;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  async health(): Promise<MotionServiceHealth | null> {
    return this.client.health();
  }

  async isReady(): Promise<boolean> {
    return (await this.client.health())?.ready === true;
  }

  /** Generate a whole clip and save it to the animation library, like the OpenAI pipeline does. */
  async generateAnimation(request: AvatarAnimationGenerationRequest): Promise<AvatarAnimationUploadResult> {
    const prompt = requirePrompt(request?.prompt);
    const name = toSlug(prompt);
    const startedAt = this.now();

    const { vrma, timings } = await this.client.generateClip({
      prompt,
      duration: clampDuration(request.duration, DEFAULT_CLIP_DURATION, MAX_CLIP_DURATION),
      name,
    });

    const fileName = `${vrma.meta.name}.vrma`;
    const result = await this.animationService.uploadAnimation({
      fileName,
      data: encodeVrmaGlb(vrma).toString('base64'),
      name: vrma.meta.name,
    });

    this.logger?.info?.('Local motion animation generated.', {
      id: result.animation.id,
      name: result.animation.name,
      duration: result.animation.duration,
      serviceTimings: timings,
      totalMs: this.now() - startedAt,
    });
    return result;
  }

  /**
   * Stream a one-off movement: each chunk is encoded to a .vrma and handed to `onChunk` as soon
   * as the service yields it. Nothing is saved to the library.
   */
  async streamMotion(
    request: AvatarMotionStreamRequest,
    onChunk: (chunk: AvatarMotionChunkEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<AvatarMotionStreamResult> {
    const prompt = requirePrompt(request?.prompt);
    const streamId = request.streamId;
    const startedAt = this.now();
    let firstChunkMs: number | null = null;
    let count = 0;

    const stream = this.client.stream(
      {
        prompt,
        duration: clampDuration(request.duration, DEFAULT_STREAM_DURATION, MAX_STREAM_DURATION),
        name: toSlug(prompt),
      },
      options,
    );

    for (;;) {
      const next = await stream.next();
      if (next.done) {
        const totalMs = this.now() - startedAt;
        this.logger?.info?.('Local motion stream finished.', {
          streamId,
          chunks: count,
          firstChunkMs,
          totalMs,
          serviceTimings: next.value.timings,
        });
        return { streamId, chunks: count, firstChunkMs, totalMs };
      }

      const chunk = next.value;
      if (firstChunkMs === null) {
        firstChunkMs = this.now() - startedAt;
      }
      count += 1;
      onChunk({
        streamId,
        index: chunk.index,
        start: chunk.start,
        name: chunk.vrma.meta.name,
        duration: chunk.vrma.meta.duration ?? null,
        data: encodeVrmaGlb(chunk.vrma).toString('base64'),
      });
    }
  }
}

function requirePrompt(value: unknown): string {
  const prompt = typeof value === 'string' ? value.trim() : '';
  if (!prompt) {
    throw new Error('Motion prompt is required.');
  }
  return prompt;
}

function clampDuration(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, 0.5), max);
}

export function toSlug(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/(^-+|-+$)/g, '');
  return VRMA_SLUG_PATTERN.test(slug) ? slug : 'motion';
}
