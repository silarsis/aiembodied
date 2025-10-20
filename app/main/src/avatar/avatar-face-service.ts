import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type OpenAI from 'openai';


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

function validateImageComponent(data: string): ValidationResult {
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
  type AvatarComponentSlot,
  type AvatarFaceDetail,
  type AvatarFaceSummary,
  type AvatarUploadRequest,
  type AvatarUploadResult,
} from './types.js';
import type { AvatarGenerationResult, AvatarGenerationStrategy } from './types.js';

interface AvatarFaceServiceOptions {
  client: OpenAI;
  store: MemoryStore;
  now?: () => number;
  logger?: { error?: (message: string, meta?: Record<string, unknown>) => void; warn?: (message: string, meta?: Record<string, unknown>) => void };
}

interface ParsedComponent {
  slot: AvatarComponentSlot;
  mimeType: string;
  data: string;
  sequence?: number;
}

// Layer specifications for generating avatar components
const LAYER_SPECS = [
  {
    slot: 'base' as AvatarComponentSlot,
    prompt: 'face outline, hair, and static facial features ONLY (no eyes, no mouth). Cartoon style, 150x150px, transparent background, bold lines.',
    sequence: 0,
  },
  {
    slot: 'eyes-open' as AvatarComponentSlot,
    prompt: 'both eyes open ONLY, isolated on transparent canvas. Cartoon style, 150x150px, bold features, high contrast.',
    sequence: 0,
  },
  {
    slot: 'eyes-closed' as AvatarComponentSlot,
    prompt: 'both eyes closed ONLY, isolated on transparent canvas. Cartoon style, 150x150px, bold features with eyelashes.',
    sequence: 0,
  },
  {
    slot: 'mouth-neutral' as AvatarComponentSlot,
    prompt: 'neutral mouth ONLY, isolated on transparent canvas. Cartoon style, 150x150px, pink/red lips.',
    sequence: 0,
  },
  {
    slot: 'mouth-0' as AvatarComponentSlot,
    prompt: 'small O phoneme mouth ONLY, isolated on transparent canvas. Cartoon style, 150x150px, pink/red lips.',
    sequence: 0,
  },
  {
    slot: 'mouth-1' as AvatarComponentSlot,
    prompt: 'medium O phoneme mouth ONLY, isolated on transparent canvas. Cartoon style, 150x150px, pink/red lips.',
    sequence: 0,
  },
  {
    slot: 'mouth-2' as AvatarComponentSlot,
    prompt: 'wide O phoneme mouth ONLY, isolated on transparent canvas. Cartoon style, 150x150px, pink/red lips.',
    sequence: 0,
  },
  {
    slot: 'mouth-3' as AvatarComponentSlot,
    prompt: 'smiling mouth ONLY, isolated on transparent canvas. Cartoon style, 150x150px, pink/red lips showing teeth.',
    sequence: 0,
  },
  {
    slot: 'mouth-4' as AvatarComponentSlot,
    prompt: 'open talking mouth ONLY, isolated on transparent canvas. Cartoon style, 150x150px, pink/red lips showing teeth.',
    sequence: 0,
  },
];

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
  private readonly client: OpenAI;
  private readonly store: MemoryStore;
  private readonly now: () => number;
  private readonly logger?: { error?: (message: string, meta?: Record<string, unknown>) => void; warn?: (message: string, meta?: Record<string, unknown>) => void };
  private readonly debugImagesEnabled: boolean;
  private readonly pendingGenerations: Map<string, { createdAt: number; candidates: { id: string; strategy: AvatarGenerationStrategy; components: ParsedComponent[] }[] }>; 
  private readonly hasImagesApi: boolean;

  constructor(options: AvatarFaceServiceOptions) {
    this.client = options.client;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.debugImagesEnabled = process.env.NODE_ENV !== 'production';
    this.pendingGenerations = new Map();

    // Images API is optional now; prefer Responses image_generation tool.
    // Detect any supported variant: generate, create, or edits.create.
    type ImagesApi = {
      edit?: (args: unknown) => Promise<unknown>;
      edits?: { create?: (args: unknown) => Promise<unknown> };
      generate?: (args: unknown) => Promise<unknown>;
      create?: (args: unknown) => Promise<unknown>;
    } | undefined;
    const imagesApi = (options.client as unknown as { images?: ImagesApi }).images;
    const hasEdit = Boolean(imagesApi && typeof imagesApi.edit === 'function');
    const hasEditsCreate = Boolean(imagesApi?.edits && typeof imagesApi.edits.create === 'function');
    const hasGenerate = Boolean(imagesApi && typeof imagesApi.generate === 'function');
    const hasCreate = Boolean(imagesApi && typeof imagesApi.create === 'function');
    this.hasImagesApi = hasEdit || hasEditsCreate || hasGenerate || hasCreate;
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

  private async saveDebugRequest(faceId: string, layerPrompts: string[], imageBase64: string): Promise<void> {
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
        request: {
          model: 'gpt-image-1',
          layerPrompts,
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

  async uploadFace(_request: AvatarUploadRequest): Promise<AvatarUploadResult> {
    void _request;
    throw new Error('uploadFace is deprecated. Use generateFace + applyGeneratedFace.');
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

  // Parallel generation: Responses (image_generation) + Images Edit
  async generateFace(request: AvatarUploadRequest): Promise<AvatarGenerationResult> {
    const imageDataUrl = request.imageDataUrl?.trim();
    if (!imageDataUrl) throw new Error('An image data URL is required to generate an avatar face.');
    const imageBase64 = this.extractBase64Payload(imageDataUrl);
    const generationId = randomUUID();
    const candidates: { id: string; strategy: AvatarGenerationStrategy; components: ParsedComponent[] }[] = [];

    const runResponses = (async () => {
      try {
        const comps: ParsedComponent[] = [];
        for (const spec of LAYER_SPECS) {
          const resp = await (this.client as unknown as { responses: { create: (args: unknown) => Promise<unknown> } }).responses.create({
            model: 'gpt-4.1-mini',
            input: `Generate a 150x150 PNG (transparent background): ${spec.prompt} The component must be clearly visible with opaque fills and high contrast. Do not include other parts.`,
            tools: [{ type: 'image_generation' }],
          });
          const outArr = (resp as { output?: unknown }).output;
          const outputs = Array.isArray(outArr) ? (outArr as Array<{ type?: string; result?: unknown }>) : [];
          const call = outputs.find((o) => o.type === 'image_generation_call');
          const b64 = typeof call?.result === 'string' ? call.result : undefined;
          if (!b64) continue;
          comps.push({ slot: spec.slot, mimeType: 'image/png', data: b64, sequence: spec.sequence });
          await new Promise((r) => setTimeout(r, 50));
        }
        if (comps.length > 0) candidates.push({ id: randomUUID(), strategy: 'responses', components: comps });
      } catch (error) {
        this.logger?.error?.('Responses generation failed', { error: error instanceof Error ? error.message : String(error) });
      }
    })();

    const runImagesEdit = (async () => {
      if (!this.hasImagesApi) {
        this.logger?.warn?.('Images API not available on OpenAI client; skipping images strategy');
        return;
      }
      try {
        const comps: ParsedComponent[] = [];
        for (const spec of LAYER_SPECS) {
          type ImagesApi = {
            edit?: (args: unknown) => Promise<unknown>;
            edits?: { create?: (args: unknown) => Promise<unknown> };
            generate?: (args: unknown) => Promise<unknown>;
            create?: (args: unknown) => Promise<unknown>;
          } | undefined;
          const images = (this.client as unknown as { images?: ImagesApi }).images;
          if (!images) {
            continue;
          }
          let res: unknown;
          const imageBuffer = Buffer.from(imageBase64, 'base64');
          if (typeof images.edit === 'function') {
            // Use images.edit; pass Buffer directly to accommodate SDK variants without toFile
            res = await images.edit({ image: imageBuffer, prompt: spec.prompt, size: '256x256', n: 1, response_format: 'b64_json' });
          } else if (images?.edits && typeof images.edits.create === 'function') {
            res = await images.edits.create({ model: 'gpt-image-1', image: imageBuffer, prompt: spec.prompt, size: '256x256', n: 1, response_format: 'b64_json' });
          } else if (typeof images.generate === 'function') {
            res = await images.generate({ model: 'gpt-image-1', prompt: spec.prompt, size: '256x256', n: 1, response_format: 'b64_json' });
          } else if (typeof images.create === 'function') {
            res = await images.create({ model: 'gpt-image-1', prompt: spec.prompt, size: '256x256', n: 1, response_format: 'b64_json' });
          } else {
            continue;
          }
          const maybe = (res as { data?: Array<{ b64_json?: unknown }> })?.data?.[0]?.b64_json;
          const b64 = typeof maybe === 'string' ? maybe : undefined;
          if (!b64) continue;
          comps.push({ slot: spec.slot, mimeType: 'image/png', data: b64, sequence: spec.sequence });
          await new Promise((r) => setTimeout(r, 50));
        }
        if (comps.length > 0) candidates.push({ id: randomUUID(), strategy: 'images_edit', components: comps });
      } catch (error) {
        this.logger?.error?.('Images edit generation failed', { error: error instanceof Error ? error.message : String(error) });
      }
    })();

    await Promise.allSettled([runResponses, runImagesEdit]);
    if (candidates.length === 0) throw new Error('Failed to generate avatar candidates');

    this.pendingGenerations.set(generationId, { createdAt: this.now(), candidates });
    return {
      generationId,
      candidates: candidates.map((c) => {
        const preview = c.components.find((cmp) => cmp.slot === 'base') ?? c.components.find((cmp) => cmp.slot === 'mouth-neutral') ?? c.components[0];
        const validCount = c.components.map((cmp) => validateImageComponent(cmp.data)).filter((v) => v.valid).length;
        const qualityScore = Math.round((validCount / c.components.length) * 100);
        return {
          id: c.id,
          strategy: c.strategy,
          previewDataUrl: preview ? `data:${preview.mimeType};base64,${preview.data}` : null,
          componentsCount: c.components.length,
          qualityScore,
        };
      }),
    } as AvatarGenerationResult;
  }

  async applyGeneratedFace(generationId: string, candidateId: string, name?: string): Promise<AvatarUploadResult> {
    const gen = this.pendingGenerations.get(generationId);
    if (!gen) throw new Error('Generation not found.');
    const cand = gen.candidates.find((c) => c.id === candidateId);
    if (!cand) throw new Error('Candidate not found.');

    const timestamp = this.now();
    const faceId = randomUUID();
    const faceRecord: FaceRecord = { id: faceId, name: sanitizeName(name, `Avatar face ${new Date(timestamp).toLocaleString()}`), createdAt: timestamp };
    const faceComponents: FaceComponentRecord[] = cand.components.map((component, index) => ({
      id: randomUUID(),
      faceId,
      slot: component.slot,
      sequence: component.sequence ?? index,
      mimeType: component.mimeType,
      data: Buffer.from(component.data, 'base64'),
    }));
    this.store.createFace(faceRecord, faceComponents);
    this.store.setActiveFace(faceId);
    this.pendingGenerations.delete(generationId);
    return { faceId };
  }
}
