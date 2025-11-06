import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, readFile as fsReadFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMMetaLoaderPlugin } from '@pixiv/three-vrm-core';
import type { VRM1Meta } from '@pixiv/three-vrm-core';
import type { MemoryStore, VrmModelRecord } from '../memory/memory-store.js';
import type {
  AvatarModelSummary,
  AvatarModelUploadRequest,
  AvatarModelUploadResult,
} from './types.js';

interface FileSystemAdapter {
  mkdir: (target: string) => Promise<void>;
  writeFile: (target: string, data: Buffer) => Promise<void>;
  rm: (target: string) => Promise<void>;
  readFile: (target: string) => Promise<Buffer>;
}

interface AvatarModelServiceOptions {
  store: MemoryStore;
  modelsDirectory: string;
  now?: () => number;
  logger?: {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
  fs?: FileSystemAdapter;
}

interface ParsedGlb {
  json: Record<string, unknown>;
  binaryChunk: Buffer | null;
}

interface ThumbnailExtractionResult {
  buffer: Buffer;
  mimeType: string | null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87A_SIGNATURE = Buffer.from('GIF87a');
const GIF89A_SIGNATURE = Buffer.from('GIF89a');
const WEBP_RIFF_SIGNATURE = Buffer.from('RIFF');
const WEBP_WEBP_SIGNATURE = Buffer.from('WEBP');
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function ensureThreeCompatibility() {
  const globalAny = globalThis as Record<string, unknown>;
  if (typeof globalAny.self === 'undefined') {
    globalAny.self = globalAny;
  }
}

function sanitizeName(name: string | undefined, fallback: string): string {
  if (typeof name !== 'string') {
    return fallback;
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.slice(0, 200);
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  return copy.buffer;
}

function parseGlb(buffer: Buffer): ParsedGlb {
  if (buffer.length < 20) {
    throw new Error('Invalid VRM file: buffer too small.');
  }

  const magic = buffer.toString('utf8', 0, 4);
  if (magic !== 'glTF') {
    throw new Error('Invalid VRM file: missing glTF header.');
  }

  const version = buffer.readUInt32LE(4);
  if (version < 2) {
    throw new Error('Invalid VRM file: unsupported glTF version.');
  }

  const totalLength = buffer.readUInt32LE(8);
  if (totalLength !== buffer.length) {
    // Some exporters set total length differently, only warn when mismatched.
    // Continue processing rather than rejecting outright.
  }

  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let binaryChunk: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    offset += 8;

    if (offset + chunkLength > buffer.length) {
      throw new Error('Invalid VRM file: chunk extends beyond buffer length.');
    }

    const chunkData = buffer.slice(offset, offset + chunkLength);
    offset += chunkLength;

    if (chunkType === 0x4e4f534a) {
      try {
        json = JSON.parse(chunkData.toString('utf8')) as Record<string, unknown>;
      } catch (error) {
        throw new Error(
          `Invalid VRM file: failed to parse JSON chunk (${error instanceof Error ? error.message : 'unknown error'}).`,
        );
      }
    } else if (chunkType === 0x004e4942) {
      binaryChunk = Buffer.from(chunkData);
    }
  }

  if (!json) {
    throw new Error('Invalid VRM file: missing JSON chunk.');
  }

  return { json, binaryChunk };
}

function detectMimeType(buffer: Buffer | null): string | null {
  if (!buffer || buffer.length < 4) {
    return null;
  }

  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }

  if (buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }

  const gifHeader = buffer.subarray(0, 6);
  if (gifHeader.equals(GIF87A_SIGNATURE) || gifHeader.equals(GIF89A_SIGNATURE)) {
    return 'image/gif';
  }

  if (buffer.length >= 12) {
    const riff = buffer.subarray(0, 4);
    const webp = buffer.subarray(8, 12);
    if (riff.equals(WEBP_RIFF_SIGNATURE) && webp.equals(WEBP_WEBP_SIGNATURE)) {
      return 'image/webp';
    }
  }

  return null;
}

function toDataUrl(buffer: Buffer | null): string | null {
  if (!buffer) {
    return null;
  }

  const mime = detectMimeType(buffer) ?? 'application/octet-stream';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function extractThumbnail(parsed: ParsedGlb): ThumbnailExtractionResult | null {
  const extensions = parsed.json?.extensions as Record<string, unknown> | undefined;
  const vrm = extensions?.VRM as Record<string, unknown> | undefined;
  const meta = vrm?.meta as Record<string, unknown> | undefined;
  if (!meta) {
    return null;
  }

  const thumbnailIndex = meta.thumbnailImage;
  if (typeof thumbnailIndex !== 'number') {
    return null;
  }

  const images = (parsed.json.images as unknown[]) ?? [];
  const image = images[thumbnailIndex] as Record<string, unknown> | undefined;
  if (!image) {
    return null;
  }

  if (typeof image.uri === 'string') {
    const uri: string = image.uri;
    const commaIndex = uri.indexOf(',');
    if (commaIndex >= 0) {
      const mimeMatch = /^data:([^;]+);base64/.exec(uri.slice(0, commaIndex));
      const base64 = uri.slice(commaIndex + 1);
      try {
        const buffer = Buffer.from(base64, 'base64');
        const mimeType = mimeMatch ? mimeMatch[1] : detectMimeType(buffer);
        return { buffer, mimeType: mimeType ?? null };
      } catch {
        return null;
      }
    }
  }

  const bufferViewIndex = image.bufferView;
  if (typeof bufferViewIndex === 'number' && parsed.binaryChunk) {
    const bufferViews = (parsed.json.bufferViews as unknown[]) ?? [];
    const view = bufferViews[bufferViewIndex] as Record<string, unknown> | undefined;
    if (!view) {
      return null;
    }

    const byteOffset = typeof view.byteOffset === 'number' ? view.byteOffset : 0;
    const byteLength = typeof view.byteLength === 'number' ? view.byteLength : 0;
    if (byteLength <= 0 || byteOffset + byteLength > parsed.binaryChunk.length) {
      return null;
    }

    const buffer = parsed.binaryChunk.subarray(byteOffset, byteOffset + byteLength);
    const mimeType = typeof image.mimeType === 'string' ? image.mimeType : detectMimeType(buffer);
    return { buffer: Buffer.from(buffer), mimeType: mimeType ?? null };
  }

  return null;
}

async function loadVrmMetadata(buffer: Buffer): Promise<VRM1Meta> {
  ensureThreeCompatibility();

  const loader = new GLTFLoader();

  loader.register((parser: unknown) => {
    const metaPlugin = new VRMMetaLoaderPlugin(parser, { acceptV0Meta: false });
    metaPlugin.needThumbnailImage = false;

    return new VRMLoaderPlugin(parser, {
      metaPlugin,
    });
  });

  let gltf: GLTF;
  try {
    gltf = await loader.parseAsync(bufferToArrayBuffer(buffer), '');
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`VRM validation failed: ${reason}`);
  }

  const vrm = (gltf.userData as { vrm?: { meta?: unknown; dispose?: () => void } } | undefined)?.vrm;
  if (!vrm || !vrm.meta) {
    throw new Error('VRM validation failed: VRM metadata missing from parsed model.');
  }

  const meta = vrm.meta as VRM1Meta | { metaVersion?: string };
  if ((meta as { metaVersion?: string }).metaVersion !== '1') {
    throw new Error('VRM validation failed: expected VRM 1.0 metadata.');
  }

  try {
    if (typeof vrm.dispose === 'function') {
      vrm.dispose();
    }
  } catch {
    // Ignore disposal errors.
  }

  try {
    const parser = gltf.parser as { dispose?: () => void } | undefined;
    if (parser && typeof parser.dispose === 'function') {
      parser.dispose();
    }
  } catch {
    // Ignore parser disposal errors.
  }

  return meta as VRM1Meta;
}

const defaultFs: FileSystemAdapter = {
  mkdir: async (target) => {
    await mkdir(target, { recursive: true });
  },
  writeFile: async (target, data) => {
    await writeFile(target, data);
  },
  rm: async (target) => {
    await rm(target, { force: true });
  },
  readFile: async (target) => {
    return await fsReadFile(target);
  },
};

export class AvatarModelService {
  private readonly store: MemoryStore;
  private readonly modelsDirectory: string;
  private readonly now: () => number;
  private readonly logger?: AvatarModelServiceOptions['logger'];
  private readonly fs: FileSystemAdapter;

  constructor(options: AvatarModelServiceOptions) {
    this.store = options.store;
    this.modelsDirectory = path.resolve(options.modelsDirectory);
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.fs = options.fs ?? defaultFs;
  }

  listModels(): AvatarModelSummary[] {
    return this.store.listVrmModels().map((record) => this.toSummary(record));
  }

  getActiveModel(): AvatarModelSummary | null {
    const activeId = this.store.getActiveVrmModelId();
    if (activeId) {
      const record = this.store.getVrmModel(activeId);
      if (record) {
        return this.toSummary(record);
      }

      this.logger?.warn?.('Active VRM model missing from store; applying fallback.', { activeId });
    }

    return this.applyFallbackSelection();
  }

  setActiveModel(modelId: string | null): AvatarModelSummary | null {
    if (!modelId) {
      this.store.setActiveVrmModel(null);
      return null;
    }

    const record = this.store.getVrmModel(modelId);
    if (!record) {
      this.logger?.warn?.('Requested VRM model not found. Falling back to current selection.', { modelId });
      return this.getActiveModel();
    }

    this.store.setActiveVrmModel(modelId);
    return this.toSummary(record);
  }

  async loadModelBinary(modelId: string): Promise<ArrayBuffer> {
    const record = this.store.getVrmModel(modelId);
    if (!record) {
      throw new Error('Requested VRM model is not available.');
    }

    try {
      const buffer = await this.fs.readFile(record.filePath);
      if (buffer.length === 0) {
        throw new Error('VRM model binary is empty.');
      }

      return bufferToArrayBuffer(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to load VRM model binary.', {
        modelId,
        filePath: record.filePath,
        message,
      });
      throw new Error('Failed to load VRM model binary from disk.');
    }
  }

  async uploadModel(request: AvatarModelUploadRequest): Promise<AvatarModelUploadResult> {
    if (!request || typeof request.fileName !== 'string' || typeof request.data !== 'string') {
      throw new Error('Invalid VRM upload payload.');
    }

    const fileName = request.fileName.trim();
    if (!fileName.toLowerCase().endsWith('.vrm')) {
      throw new Error('VRM upload rejected: file must use the .vrm extension.');
    }

    const rawData = typeof request.data === 'string' ? request.data.trim() : '';
    if (!BASE64_PATTERN.test(rawData)) {
      throw new Error('VRM upload rejected: invalid base64 payload.');
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(rawData, 'base64');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`VRM upload rejected: invalid base64 payload (${message}).`);
    }

    if (buffer.length === 0) {
      throw new Error('VRM upload rejected: file is empty.');
    }

    const parsedGlb = parseGlb(buffer);
    const meta = await loadVrmMetadata(buffer);
    const thumbnail = extractThumbnail(parsedGlb);

    const baseName = path.parse(fileName).name || 'VRM Model';
    const modelName = sanitizeName(request.name ?? meta.name, baseName);
    const version = typeof meta.version === 'string' && meta.version.trim().length > 0 ? meta.version.trim() : '1.0';
    const id = randomUUID();
    const filePath = path.join(this.modelsDirectory, `${id}.vrm`);
    const createdAt = this.now();
    const fileSha = createHash('sha256').update(buffer).digest('hex');

    try {
      await this.fs.mkdir(this.modelsDirectory);
      await this.fs.writeFile(filePath, buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to persist VRM model binary.', { message, filePath });
      throw new Error('Failed to persist VRM model binary to disk.');
    }

    const record: VrmModelRecord = {
      id,
      name: modelName,
      createdAt,
      filePath,
      fileSha,
      version,
      thumbnail: thumbnail ? thumbnail.buffer : null,
    };

    try {
      this.store.createVrmModel(record);
    } catch (error) {
      await this.fs.rm(filePath).catch(() => {
        this.logger?.warn?.('Failed to clean up VRM binary after store write failure.', { filePath });
      });
      throw error;
    }

    if (!this.store.getActiveVrmModelId()) {
      this.store.setActiveVrmModel(id);
    }

    this.logger?.info?.('VRM model uploaded successfully.', { id, filePath, version });
    return { model: this.toSummary(record) };
  }

  async deleteModel(modelId: string): Promise<void> {
    const record = this.store.getVrmModel(modelId);
    if (!record) {
      this.logger?.warn?.('Attempted to delete missing VRM model.', { modelId });
      return;
    }

    this.store.deleteVrmModel(modelId);

    await this.fs.rm(record.filePath).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.('Failed to remove VRM model binary from disk.', { modelId, filePath: record.filePath, message });
    });

    const fallback = this.getActiveModel();
    if (fallback) {
      this.logger?.info?.('Active VRM model selection updated after deletion.', {
        removed: modelId,
        active: fallback.id,
      });
    } else {
      this.logger?.info?.('All VRM models removed; active selection cleared.', { removed: modelId });
    }
  }

  private applyFallbackSelection(): AvatarModelSummary | null {
    const models = this.store.listVrmModels();
    if (models.length === 0) {
      this.store.setActiveVrmModel(null);
      return null;
    }

    const next = models[0];
    this.store.setActiveVrmModel(next.id);
    return this.toSummary(next);
  }

  private toSummary(record: VrmModelRecord): AvatarModelSummary {
    return {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      version: record.version,
      fileSha: record.fileSha,
      thumbnailDataUrl: toDataUrl(record.thumbnail),
    };
  }
}
