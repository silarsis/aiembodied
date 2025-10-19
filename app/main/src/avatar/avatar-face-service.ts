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

interface AvatarFaceServiceOptions {
  client: OpenAI;
  store: MemoryStore;
  now?: () => number;
  logger?: { error?: (message: string, meta?: Record<string, unknown>) => void };
}

interface AvatarFaceDescriptor {
  hairColor: string;
  hairStyle: string;
  eyeColor: string;
  skinTone: string;
  facialHair: string;
  accessories: string[];
  notableFeatures: string;
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

const FACE_DESCRIPTOR_SCHEMA = {
  name: 'AvatarFaceDescriptor',
  type: 'json_schema' as const,
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'hairColor',
      'hairStyle',
      'eyeColor',
      'skinTone',
      'facialHair',
      'accessories',
      'notableFeatures',
    ],
    properties: {
      hairColor: {
        type: 'string',
        description: 'Primary hair color. Use "none" if the subject has no hair.',
      },
      hairStyle: {
        type: 'string',
        description: 'Short description of the hairstyle or head covering.',
      },
      eyeColor: {
        type: 'string',
        description: 'Dominant eye color or pattern.',
      },
      skinTone: {
        type: 'string',
        description: 'Visible skin tone rendered as a short description.',
      },
      facialHair: {
        type: 'string',
        description: 'Facial hair description or "none" when absent.',
      },
      accessories: {
        type: 'array',
        items: { type: 'string' },
        description: 'Accessories visible near the face (glasses, jewelry, hats, etc.). Use an empty array when none.',
      },
      notableFeatures: {
        type: 'string',
        description: 'Distinct traits like freckles, makeup, lighting, or other artistic cues. Use "none" if not notable.',
      },
    },
  },
};

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
  private readonly logger?: { error?: (message: string, meta?: Record<string, unknown>) => void };
  private readonly debugImagesEnabled: boolean;

  constructor(options: AvatarFaceServiceOptions) {
    const imagesApi = (options.client as unknown as { images: { create: () => unknown } }).images;
    if (!imagesApi || typeof imagesApi.create !== 'function') {
      throw new Error('AvatarFaceService requires an OpenAI images client.');
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

  private async saveDebugRequest(
    faceId: string,
    layerPrompts: string[],
    imageBase64: string,
    descriptor?: AvatarFaceDescriptor,
  ): Promise<void> {
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
          imageBase64Length: imageBase64.length,
          descriptor,
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

  private buildLayerPrompt(basePrompt: string, descriptor: AvatarFaceDescriptor): string {
    const accessories = descriptor.accessories.length > 0
      ? descriptor.accessories.join(', ')
      : 'none';

    const descriptorSummary = [
      `Hair: ${descriptor.hairColor} with ${descriptor.hairStyle}`,
      `Eyes: ${descriptor.eyeColor}`,
      `Skin tone: ${descriptor.skinTone}`,
      `Facial hair: ${descriptor.facialHair}`,
      `Accessories: ${accessories}`,
      `Notable: ${descriptor.notableFeatures}`,
    ].join('; ');

    return `${basePrompt} Ensure the artwork reflects these subject traits: ${descriptorSummary}.`
      + ' Match colors exactly and do not invent new accessories or features.';
  }

  private async generateFaceDescriptor(imageBase64: string): Promise<AvatarFaceDescriptor> {
    const responses = (this.client as unknown as {
      responses?: { create?: (params: unknown) => Promise<unknown> };
    }).responses;

    if (!responses || typeof responses.create !== 'function') {
      throw new Error('AvatarFaceService requires an OpenAI responses client.');
    }

    const systemPrompt =
      'You are an art director translating real faces into vivid cartoon avatar layers. '
      + 'Extract concise, objective descriptors needed to recreate the subject.';

    const userPrompt =
      'Analyze the portrait and fill the schema. '
      + 'Use short descriptive phrases. '
      + 'Return "none" when a feature does not exist. '
      + 'Accessories should include any glasses, jewelry, hats, hair accessories, or clothing elements near the face.';

    const response = await responses.create({
      model: 'gpt-4.1-mini',
      input: [
        {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: systemPrompt }],
        },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: userPrompt },
            { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}`, detail: 'auto' },
          ],
        },
      ],
      text: {
        format: FACE_DESCRIPTOR_SCHEMA,
      },
    });

    const text = this.extractStructuredText(response);
    if (!text) {
      throw new Error('Descriptor analysis returned no text content.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Descriptor analysis returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return this.normalizeDescriptor(parsed);
  }

  private extractStructuredText(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
      return '';
    }

    const response = payload as Record<string, unknown>;

    const direct = response.output_text;
    if (typeof direct === 'string') {
      return direct.trim();
    }

    const output = response.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        if ((item as { type?: unknown }).type === 'message' && Array.isArray((item as { content?: unknown }).content)) {
          for (const chunk of (item as { content: unknown[] }).content) {
            if (!chunk || typeof chunk !== 'object') {
              continue;
            }

            const chunkType = (chunk as { type?: unknown }).type;
            const chunkText = (chunk as { text?: unknown }).text;
            if ((chunkType === 'output_text' || chunkType === 'text') && typeof chunkText === 'string') {
              return chunkText.trim();
            }
          }
        }
      }
    }

    const choices = response.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!choice || typeof choice !== 'object') {
          continue;
        }
        const message = (choice as { message?: unknown }).message;
        if (!message || typeof message !== 'object') {
          continue;
        }
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) {
          continue;
        }
        for (const chunk of content) {
          if (!chunk || typeof chunk !== 'object') {
            continue;
          }
          const chunkType = (chunk as { type?: unknown }).type;
          const chunkText = (chunk as { text?: unknown }).text;
          if (chunkType === 'text' && typeof chunkText === 'string') {
            return chunkText.trim();
          }
        }
      }
    }

    return '';
  }

  private normalizeDescriptor(payload: unknown): AvatarFaceDescriptor {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Descriptor payload is missing expected fields.');
    }

    const descriptor = payload as Record<string, unknown>;
    const accessoriesRaw = Array.isArray(descriptor.accessories) ? descriptor.accessories : [];
    const accessories = accessoriesRaw
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }
        return String(item ?? '').trim();
      })
      .filter((item) => item.length > 0);

    return {
      hairColor: this.normalizeDescriptorString(descriptor.hairColor, 'unspecified'),
      hairStyle: this.normalizeDescriptorString(descriptor.hairStyle, 'unspecified'),
      eyeColor: this.normalizeDescriptorString(descriptor.eyeColor, 'unspecified'),
      skinTone: this.normalizeDescriptorString(descriptor.skinTone, 'unspecified'),
      facialHair: this.normalizeDescriptorString(descriptor.facialHair, 'none'),
      notableFeatures: this.normalizeDescriptorString(descriptor.notableFeatures, 'none'),
      accessories,
    };
  }

  private normalizeDescriptorString(value: unknown, fallback: string): string {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : fallback;
    }

    if (value === null || value === undefined) {
      return fallback;
    }

    const asString = String(value).trim();
    return asString.length > 0 ? asString : fallback;
  }

  async uploadFace(request: AvatarUploadRequest): Promise<AvatarUploadResult> {
    const imageDataUrl = request.imageDataUrl?.trim();
    if (!imageDataUrl) {
      throw new Error('An image data URL is required to upload an avatar face.');
    }

    const imageBase64 = this.extractBase64Payload(imageDataUrl);

    // Generate face ID early for debug logging
    const faceId = randomUUID();
    const timestamp = this.now();
    
    let descriptor: AvatarFaceDescriptor;
    try {
      descriptor = await this.generateFaceDescriptor(imageBase64);
    } catch (error) {
      this.logger?.error?.('Failed to analyze avatar face descriptors', {
        faceId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.saveDebugResponse(faceId, {
        analysisError: error instanceof Error ? error.message : String(error),
      });
      throw this.handleOpenAiError(error);
    }

    const layerPrompts = LAYER_SPECS.map(spec => this.buildLayerPrompt(spec.prompt, descriptor));

    // Save debug request
    await this.saveDebugRequest(faceId, layerPrompts, imageBase64, descriptor);

    const components: ParsedComponent[] = [];

    try {
      // Generate each avatar component layer using the images create API
      for (const [index, layerSpec] of LAYER_SPECS.entries()) {
        try {
          this.logger?.error?.(`Generating ${layerSpec.slot} layer...`, {
            faceId,
            slot: layerSpec.slot
          });

          const response = await (this.client as unknown as { images: { create: (params: unknown) => Promise<{ data: Array<{ b64_json: string }> }> } }).images.create({
            model: 'gpt-image-1',
            prompt: layerPrompts[index],
            size: '256x256', // OpenAI only supports specific sizes
            n: 1,
            response_format: 'b64_json',
          });

          if (!response.data?.[0]?.b64_json) {
            throw new Error(`No image data returned for ${layerSpec.slot}`);
          }

          const b64Data = response.data[0].b64_json;
          
          // Validate the generated component
          const validation = validateImageComponent(b64Data);
          
          if (!validation.valid) {
            this.logger?.error?.(`Component validation failed for ${layerSpec.slot}`, {
              slot: layerSpec.slot,
              issues: validation.issues,
              fileSize: validation.fileSize,
              dimensions: validation.dimensions
            });
          }

          components.push({
            slot: layerSpec.slot,
            mimeType: 'image/png',
            data: b64Data,
            sequence: layerSpec.sequence,
          });

          // Gentle pacing to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
          this.logger?.error?.(`Failed to generate ${layerSpec.slot}`, {
            faceId,
            slot: layerSpec.slot,
            error: error instanceof Error ? error.message : String(error)
          });
          
          // If this is the first layer and it fails with API error, re-throw the original error
          if (layerSpec.slot === 'base' && error instanceof Error) {
            throw error;
          }
          
          // Continue with other layers even if one fails
          continue;
        }
      }

      if (components.length === 0) {
        throw new Error('Failed to generate any avatar components');
      }

      // Save debug response
      await this.saveDebugResponse(faceId, { componentsGenerated: components.length, descriptor });

    } catch (error) {
      // Save debug response for errors too
      await this.saveDebugResponse(faceId, { error: error instanceof Error ? error.message : String(error) });
      throw this.handleOpenAiError(error);
    }

    // Save debug images for inspection (development only)
    await this.saveDebugImages(faceId, imageBase64, components);
    
    const faceName = sanitizeName(request.name, `Avatar face ${new Date(timestamp).toLocaleString()}`);

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

    // Log validation summary
    const validationResults = components.map(comp => validateImageComponent(comp.data));
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
