import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type OpenAI from 'openai';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseFormatTextJSONSchemaConfig,
  ResponseInput,
  ResponseInputMessageContentList,
} from 'openai/resources/responses/responses.mjs';
import { z } from 'zod';

// Image validation utilities
function validatePNGHeader(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const pngHeader = buffer.subarray(0, 8);
  const expectedHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return pngHeader.equals(expectedHeader);
}

function extractPNGDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function hasAlphaChannel(buffer: Buffer): boolean {
  if (buffer.length < 25) return false;
  const colorType = buffer[25];
  return colorType === 4 || colorType === 6;
}

interface ValidationResult {
  valid: boolean;
  issues: string[];
  dimensions: { width: number; height: number } | null;
  fileSize: number;
  hasAlpha: boolean;
}

function validateImageComponent(data: string, slot: string): ValidationResult {
  const issues: string[] = [];
  
  try {
    const buffer = Buffer.from(data, 'base64');
    
    if (!validatePNGHeader(buffer)) {
      issues.push('Invalid PNG header');
    }
    
    const dimensions = extractPNGDimensions(buffer);
    if (!dimensions) {
      issues.push('Cannot extract dimensions');
    } else if (dimensions.width !== 150 || dimensions.height !== 150) {
      issues.push(`Wrong size: ${dimensions.width}x${dimensions.height} (expected 150x150)`);
    }
    
    if (!hasAlphaChannel(buffer)) {
      issues.push('No alpha channel (transparent background)');
    }
    
    if (buffer.length < 200) {
      issues.push(`Very small file (${buffer.length} bytes) - likely empty`);
    }
    
    return {
      valid: issues.length === 0,
      issues,
      dimensions,
      fileSize: buffer.length,
      hasAlpha: hasAlphaChannel(buffer)
    };
  } catch (error) {
    return {
      valid: false,
      issues: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
      dimensions: null,
      fileSize: 0,
      hasAlpha: false
    };
  }
}
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
  type: 'json_schema',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'components'],
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
          required: ['slot', 'mimeType', 'data', 'sequence'],
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
} satisfies ResponseFormatTextJSONSchemaConfig;

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
  private readonly debugImagesEnabled: boolean;

  constructor(options: AvatarFaceServiceOptions) {
    if (!options.client?.responses || typeof options.client.responses.create !== 'function') {
      throw new Error('AvatarFaceService requires an OpenAI responses client.');
    }

    this.client = options.client;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.debugImagesEnabled = process.env.NODE_ENV !== 'production';
  }

  private async saveDebugImages(faceId: string, originalImageBase64: string, components: ParsedComponent[]): Promise<void> {
    if (!this.debugImagesEnabled) {
      return;
    }

    try {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const debugDir = resolve(currentDir, '../../../images', faceId);
      await mkdir(debugDir, { recursive: true });

      // Save original uploaded image
      const originalBuffer = Buffer.from(originalImageBase64, 'base64');
      await writeFile(resolve(debugDir, 'original.png'), originalBuffer);

      // Save each generated component
      for (const component of components) {
        const componentBuffer = Buffer.from(component.data, 'base64');
        const filename = `${component.slot}-seq${component.sequence ?? 0}.png`;
        await writeFile(resolve(debugDir, filename), componentBuffer);
      }

      this.logger?.error?.('Debug images saved for inspection', {
        faceId,
        debugDir,
        originalSize: originalBuffer.length,
        componentCount: components.length
      });
    } catch (error) {
      this.logger?.error?.('Failed to save debug images', {
        faceId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async saveDebugRequest(faceId: string, requestBody: ResponseCreateParamsNonStreaming, imageBase64: string): Promise<void> {
    if (!this.debugImagesEnabled) {
      return;
    }

    try {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const debugDir = resolve(currentDir, '../../../images', faceId);
      await mkdir(debugDir, { recursive: true });

      // Create sanitized request data (remove actual image data to keep file readable)
      const sanitizedRequest = {
        ...requestBody,
        input: Array.isArray(requestBody.input) 
          ? requestBody.input.map((item: any) => ({
              ...item,
              content: Array.isArray(item.content) 
                ? item.content.map((content: any) => {
                    if (content.type === 'input_image') {
                      return {
                        ...content,
                        image_url: `data:image/png;base64,... (${imageBase64.length} characters)`
                      };
                    }
                    return content;
                  })
                : item.content
            }))
          : requestBody.input
      };

      const debugData = {
        timestamp: new Date().toISOString(),
        faceId,
        request: {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'aiembodied-avatar-service',
            'Authorization': 'Bearer [REDACTED]'
          },
          body: sanitizedRequest,
          imageBase64Length: imageBase64.length
        }
      };

      await writeFile(
        resolve(debugDir, 'request.json'),
        JSON.stringify(debugData, null, 2)
      );

    } catch (error) {
      this.logger?.error?.('Failed to save debug request', {
        faceId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async saveDebugResponse(faceId: string, response: unknown): Promise<void> {
    if (!this.debugImagesEnabled) {
      return;
    }

    try {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const debugDir = resolve(currentDir, '../../../images', faceId);
      await mkdir(debugDir, { recursive: true });

      const debugData = {
        timestamp: new Date().toISOString(),
        faceId,
        response: {
          headers: {
            'Content-Type': 'application/json'
          },
          body: response
        }
      };

      await writeFile(
        resolve(debugDir, 'response.json'),
        JSON.stringify(debugData, null, 2)
      );

    } catch (error) {
      this.logger?.error?.('Failed to save debug response', {
        faceId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
          'You are an avatar generation specialist that converts portrait photos into animation-ready layered components. '
          + 'Given a portrait photo, extract these transparent PNG layers at 150x150 pixels: '
          + '- base: Face outline, hair, and static facial features (no eyes or mouth) '
          + '- eyes-open: Open eyes only on transparent background '
          + '- eyes-closed: Closed eyes only on transparent background '
          + '- mouth-neutral through mouth-4: Different mouth shapes for speech animation (neutral, small-o, medium-o, wide-o, smile, open) '
          + 'Each component must be precisely aligned and sized for perfect overlay compositing.',
      },
    ];

    const userContent: ResponseInputMessageContentList = [
      {
        type: 'input_text',
        text:
          'Convert this portrait into avatar animation layers. Make each component: '
          + '- Exactly 150x150 pixels with transparent background '
          + '- Perfectly aligned so they composite seamlessly '
          + '- High contrast and clearly visible '
          + '- Cartoon-style but recognizable as the source person '
          + '- Ready for real-time animation overlay '
          + 'Focus on clear, bold features that will be visible in a small avatar display.',
      },
      { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}`, detail: 'auto' },
    ];

    const input: ResponseInput = [
      { type: 'message', role: 'system', content: systemContent },
      { type: 'message', role: 'user', content: userContent },
    ];

    const body: ResponseCreateParamsNonStreaming = {
      model: 'gpt-4.1-mini',
      input,
      text: {
        format: RESPONSE_SCHEMA_DEFINITION,
      },
    };

    // Generate face ID early for debug logging
    const faceId = randomUUID();
    
    // Save debug request
    await this.saveDebugRequest(faceId, body, imageBase64);

    let responsePayload: unknown;
    try {
      responsePayload = await this.client.responses.create(body);
      
      // Save debug response
      await this.saveDebugResponse(faceId, responsePayload);
    } catch (error) {
      // Save debug response for errors too
      await this.saveDebugResponse(faceId, { error: error instanceof Error ? error.message : String(error) });
      throw this.handleOpenAiError(error);
    }

    const parsed = this.parseResponse(responsePayload);

    const components: ParsedComponent[] = parsed.components;
    const timestamp = this.now();

    // Save debug images for inspection (development only)
    await this.saveDebugImages(faceId, imageBase64, components);
    const faceName = sanitizeName(request.name ?? parsed.name, `Avatar face ${new Date(timestamp).toLocaleString()}`);

    const faceRecord: FaceRecord = {
      id: faceId,
      name: faceName,
      createdAt: timestamp,
    };

    const faceComponents: FaceComponentRecord[] = components.map((component, index) => {
      // Validate component before storage
      const validation = validateImageComponent(component.data, component.slot);
      
      if (!validation.valid) {
        this.logger?.error?.(`Avatar component validation failed for slot ${component.slot}`, {
          slot: component.slot,
          issues: validation.issues,
          fileSize: validation.fileSize,
          dimensions: validation.dimensions
        });
      }

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

    // Log validation summary
    const validationResults = components.map(comp => validateImageComponent(comp.data, comp.slot));
    const validComponents = validationResults.filter(v => v.valid).length;
    const qualityScore = Math.round((validComponents / components.length) * 100);
    
    if (validComponents < components.length) {
      this.logger?.error?.('Avatar face upload validation issues detected', {
        faceId,
        totalComponents: components.length,
        validComponents,
        qualityScore: `${qualityScore}%`,
        failedComponents: components.length - validComponents
      });
    }

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
