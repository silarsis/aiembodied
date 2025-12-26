import type OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import { VRMA_JSON_SCHEMA, parseVrmaSchema, VRMA_SLUG_PATTERN } from './vrma-schema.js';
import { buildVrmAnimation, encodeVrmaGlb } from './vrma-converter.js';
import type {
  AvatarAnimationUploadResult,
  AvatarAnimationSummary,
  AvatarAnimationGenerationRequest,
} from './types.js';
import type { AvatarAnimationService } from './avatar-animation-service.js';

export interface VrmaGenerationServiceOptions {
  client: OpenAI;
  animationService: AvatarAnimationService;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

const VRMA_SYSTEM_PROMPT = [
  'You are generating VRM animation data for a kiosk avatar.',
  'Return only JSON that matches the provided schema.',
  'Use local bone-space quaternions for rotation tracks.',
  'Keep loops smooth and avoid sudden snaps.',
].join(' ');

export class VrmaGenerationService {
  private readonly client: OpenAI;
  private readonly animationService: AvatarAnimationService;
  private readonly logger?: VrmaGenerationServiceOptions['logger'];

  constructor(options: VrmaGenerationServiceOptions) {
    this.client = options.client;
    this.animationService = options.animationService;
    this.logger = options.logger;
  }

  async generateAnimation(request: AvatarAnimationGenerationRequest): Promise<AvatarAnimationUploadResult> {
    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) {
      throw new Error('VRMA generation prompt is required.');
    }

    const input: ResponseInput = [
      {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: VRMA_SYSTEM_PROMPT }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    ];

    const text = {
      format: {
        type: 'json_schema',
        name: 'vrma_animation',
        schema: VRMA_JSON_SCHEMA,
      },
    };

    const response = await (this.client as unknown as { responses: { create: (args: unknown) => Promise<{ output_text: string }> } }).responses.create({
      model: 'gpt-4.1-mini',
      input,
      text,
    });

    const outputText = response?.output_text ?? '';
    if (!outputText) {
      throw new Error('VRMA generation returned an empty response.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`VRMA generation returned invalid JSON: ${message}`);
    }

    const definition = parseVrmaSchema(parsed);
    if (!VRMA_SLUG_PATTERN.test(definition.meta.name)) {
      throw new Error('VRMA metadata name must be a slug.');
    }

    const vrmAnimation = buildVrmAnimation(definition);
    const glbBuffer = encodeVrmaGlb(definition);
    const fileName = `${definition.meta.name}.vrma`;
    const data = glbBuffer.toString('base64');

    let result: AvatarAnimationUploadResult;
    try {
      result = await this.animationService.uploadAnimation({
        fileName,
        data,
        name: definition.meta.name,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to persist generated VRMA animation.', { message, fileName });
      throw error;
    }

    const animation = result.animation as AvatarAnimationSummary | undefined;
    this.logger?.info?.('VRMA animation generated.', {
      id: animation?.id ?? null,
      name: animation?.name ?? definition.meta.name,
      duration: animation?.duration ?? vrmAnimation.duration,
      metaDuration: definition.meta.duration ?? null,
    });

    return result;
  }
}
