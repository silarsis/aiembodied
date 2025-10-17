import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type OpenAI from 'openai';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInput,
  ResponseInputMessageContentList,
} from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { MemoryStore, FaceRecord, FaceComponentRecord } from '../memory/memory-store.js';
import {
  AVATAR_COMPONENT_SLOTS,
  type AvatarComponentSlot,
  type AvatarFaceDetail,
  type AvatarFaceSummary,
  type AvatarUploadRequest,
  type AvatarUploadResult,
} from './types.js';

interface AvatarFaceServiceOptions {
  client: Pick<OpenAI, 'responses'>;
  store: MemoryStore;
  now?: () => number;
  logger?: { error?: (message: string, meta?: Record<string, unknown>) => void };
}

interface ParsedComponent {
  slot: AvatarComponentSlot;
  mimeType: string;
  data: string;
  sequence?: number;
}

interface ParsedResponse {
  name?: string;
  components: ParsedComponent[];
}

const JsonResponseSchema = z.object({
  name: z
    .string()
    .trim()
    .max(120)
    .optional(),
  components: z
    .array(
      z.object({
        slot: z.enum(AVATAR_COMPONENT_SLOTS),
        mimeType: z
          .string()
          .trim()
          .min(1)
          .default('image/png'),
        data: z.string().min(1),
        sequence: z.number().int().min(0).optional(),
      }),
    )
    .min(1),
});

const RESPONSE_SCHEMA_DEFINITION = {
  name: 'AvatarComponents',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['components'],
    properties: {
      name: {
        type: 'string',
        description: 'Human-friendly name describing the style of the generated avatar components.',
      },
      components: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['slot', 'data'],
          properties: {
            slot: { type: 'string', enum: AVATAR_COMPONENT_SLOTS },
            data: {
              type: 'string',
              description: 'Base64 encoded PNG with transparent background sized consistently for rendering.',
            },
            mimeType: {
              type: 'string',
              enum: ['image/png', 'image/webp'],
              default: 'image/png',
            },
            sequence: {
              type: 'integer',
              minimum: 0,
              description: 'Ordering hint when multiple frames exist for a slot.',
            },
          },
        },
      },
    },
  },
} as const;

function sanitizeName(name: string | undefined, fallback: string): string {
  if (typeof name !== 'string') {
    return fallback;
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.slice(0, 120);
}

function toDataUrl(mimeType: string, data: Buffer): string {
  const normalizedMime = mimeType.trim() || 'image/png';
  const payload = data.toString('base64');
  return `data:${normalizedMime};base64,${payload}`;
}

export class AvatarFaceService {
  private readonly client: Pick<OpenAI, 'responses'>;
  private readonly store: MemoryStore;
  private readonly now: () => number;
  private readonly logger?: { error?: (message: string, meta?: Record<string, unknown>) => void };

  constructor(options: AvatarFaceServiceOptions) {
    if (!options.client?.responses || typeof options.client.responses.create !== 'function') {
      throw new Error('AvatarFaceService requires an OpenAI responses client.');
    }

    this.client = options.client;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  async uploadFace(request: AvatarUploadRequest): Promise<AvatarUploadResult> {
    const imageDataUrl = request.imageDataUrl?.trim();
    if (!imageDataUrl) {
      throw new Error('An image data URL is required to upload an avatar face.');
    }

    const imageBase64 = this.extractBase64Payload(imageDataUrl);

    const systemContent: ResponseInputMessageContentList = [
      {
        type: 'input_text',
        text:
          'You are an assistant that extracts animation-ready avatar layers from a single cartoon face image. '
          + 'Return transparent PNG components for the base, eyes (open/closed), and viseme mouth shapes (0-4, plus neutral).',
      },
    ];

    const userContent: ResponseInputMessageContentList = [
      {
        type: 'input_text',
        text:
          'Produce layered assets sized consistently with the source image. Ensure components are centered and share a '
          + 'transparent background so they can be composited for animation.',
      },
      { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}`, detail: 'auto' },
    ];

    const input: ResponseInput = [
      { type: 'message', role: 'system', content: systemContent },
      { type: 'message', role: 'user', content: userContent },
    ];

    const body: ResponseCreateParamsNonStreaming & {
      modalities: ['text'];
      response: {
        modalities: ['text'];
        text: { format: 'json_schema'; schema: typeof RESPONSE_SCHEMA_DEFINITION };
      };
    } = {
      model: 'gpt-4.1-mini',
      modalities: ['text'],
      input,
      response: {
        modalities: ['text'],
        text: {
          format: 'json_schema',
          schema: RESPONSE_SCHEMA_DEFINITION,
        },
      },
    };

    let responsePayload: unknown;
    try {
      responsePayload = await this.client.responses.create(body);
    } catch (error) {
      throw this.handleOpenAiError(error);
    }

    const parsed = this.parseResponse(responsePayload);

    const components: ParsedComponent[] = parsed.components;
    const timestamp = this.now();
    const faceId = randomUUID();
    const faceName = sanitizeName(request.name ?? parsed.name, `Avatar face ${new Date(timestamp).toLocaleString()}`);

    const faceRecord: FaceRecord = {
      id: faceId,
      name: faceName,
      createdAt: timestamp,
    };

    const faceComponents: FaceComponentRecord[] = components.map((component, index) => {
      const buffer = Buffer.from(component.data, 'base64');
      if (buffer.length === 0) {
        throw new Error(`Component for slot ${component.slot} is empty.`);
      }

      return {
        id: randomUUID(),
        faceId,
        slot: component.slot,
        sequence: component.sequence ?? index,
        mimeType: component.mimeType.trim() || 'image/png',
        data: buffer,
      };
    });

    this.store.createFace(faceRecord, faceComponents);
    this.store.setActiveFace(faceId);

    return { faceId };
  }

  private handleOpenAiError(error: unknown): Error {
    if (!error || typeof error !== 'object') {
      return error instanceof Error ? error : new Error(String(error));
    }

    const apiError = error as {
      status?: number;
      response?: { data?: unknown };
      message?: string;
    };

    const status = typeof apiError.status === 'number' ? apiError.status : null;
    const baseMessage = status
      ? `OpenAI response request failed with status ${status}`
      : 'OpenAI response request failed.';

    const errorBody = this.stringifyErrorBody(apiError.response?.data ?? apiError.message ?? '');
    const truncatedBody = this.truncateErrorBody(errorBody);

    this.logger?.error?.(baseMessage, {
      ...(status === null ? {} : { status }),
      body: truncatedBody || undefined,
    });

    const message = truncatedBody ? `${baseMessage}: ${truncatedBody}` : baseMessage;
    return new Error(message);
  }

  private stringifyErrorBody(data: unknown): string {
    if (!data) {
      return '';
    }

    if (typeof data === 'string') {
      return data.trim();
    }

    if (typeof data === 'object') {
      try {
        return JSON.stringify(data);
      } catch (error) {
        this.logger?.error?.('Failed to stringify OpenAI error payload.', {
          error: error instanceof Error ? error.message : String(error),
        });
        return '[object Object]';
      }
    }

    return String(data);
  }

  private truncateErrorBody(body: string): string {
    if (!body) {
      return '';
    }

    const MAX_LOG_LENGTH = 500;
    return body.length > MAX_LOG_LENGTH ? `${body.slice(0, MAX_LOG_LENGTH - 3)}...` : body;
  }

  async listFaces(): Promise<AvatarFaceSummary[]> {
    const faces = this.store.listFaces({ limit: 200 });
    return faces.map((face) => {
      const previewComponent =
        this.store.getFaceComponent(face.id, 'base') ??
        this.store.getFaceComponent(face.id, 'mouth-neutral') ??
        this.store.getFaceComponents(face.id)[0] ??
        null;

      return {
        id: face.id,
        name: face.name,
        createdAt: face.createdAt,
        previewDataUrl: previewComponent ? toDataUrl(previewComponent.mimeType, previewComponent.data) : null,
      };
    });
  }

  async getActiveFace(): Promise<AvatarFaceDetail | null> {
    const activeId = this.store.getActiveFaceId();
    if (!activeId) {
      return null;
    }

    return this.buildDetail(activeId);
  }

  async setActiveFace(faceId: string | null): Promise<AvatarFaceDetail | null> {
    if (!faceId) {
      this.store.setActiveFace(null);
      return null;
    }

    const detail = this.buildDetail(faceId);
    if (!detail) {
      throw new Error(`Avatar face ${faceId} does not exist.`);
    }

    this.store.setActiveFace(faceId);
    return detail;
  }

  async deleteFace(faceId: string): Promise<void> {
    const activeId = this.store.getActiveFaceId();
    this.store.deleteFace(faceId);

    if (activeId === faceId) {
      this.store.setActiveFace(null);
    }
  }

  private buildDetail(faceId: string): AvatarFaceDetail | null {
    const face = this.store.getFace(faceId);
    if (!face) {
      return null;
    }

    const components = this.store.getFaceComponents(faceId);
    if (components.length === 0) {
      this.logger?.error?.('Avatar face has no components; removing entry.', { faceId });
      this.store.deleteFace(faceId);
      return null;
    }

    return {
      id: face.id,
      name: face.name,
      createdAt: face.createdAt,
      components: components.map((component) => ({
        slot: component.slot,
        sequence: component.sequence,
        mimeType: component.mimeType,
        dataUrl: toDataUrl(component.mimeType, component.data),
      })),
    };
  }

  private parseResponse(response: unknown): ParsedResponse {
    try {
      const text = this.extractTextResponse(response);
      const json = JSON.parse(text) as unknown;
      return JsonResponseSchema.parse(json);
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.logger?.error?.('Failed to parse avatar component response JSON.', { message: error.message });
        throw new Error('OpenAI returned an invalid avatar component payload.');
      }

      if (error instanceof z.ZodError) {
        this.logger?.error?.('Avatar component response failed schema validation.', {
          issues: error.issues,
        });
        throw new Error('OpenAI response missing required avatar component data.');
      }

      throw error;
    }
  }

  private extractTextResponse(response: unknown): string {
    if (!response) {
      throw new Error('OpenAI response is empty.');
    }

    const typed = response as { output_text?: string; output?: Array<{ content?: Array<{ type: string; text?: string }> }>; };
    if (typeof typed.output_text === 'string' && typed.output_text.trim()) {
      return typed.output_text;
    }

    const output = typed.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (!item?.content) {
          continue;
        }
        for (const chunk of item.content) {
          if (chunk?.type === 'output_text' && typeof chunk.text === 'string' && chunk.text.trim()) {
            return chunk.text;
          }
        }
      }
    }

    throw new Error('OpenAI response does not contain text output.');
  }

  private extractBase64Payload(imageDataUrl: string): string {
    const DATA_URL_PATTERN = /^data:(?<mime>[^;,]+)?;base64,(?<payload>.*)$/s;
    const match = DATA_URL_PATTERN.exec(imageDataUrl.trim());

    if (!match) {
      throw new Error('Avatar image data URL is malformed; expected base64-encoded data.');
    }

    const payloadGroup = match.groups?.payload;
    if (payloadGroup === undefined) {
      throw new Error('Avatar image data URL is malformed; expected base64-encoded data.');
    }

    const payload = payloadGroup.replace(/\s+/g, '').trim();
    if (!payload) {
      throw new Error('Avatar image data URL is missing image data.');
    }

    return payload;
  }
}
