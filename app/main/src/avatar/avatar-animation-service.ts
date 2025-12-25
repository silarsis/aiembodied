import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, readFile as fsReadFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnimationClip, KeyframeTrack } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import type { MemoryStore, VrmAnimationRecord } from '../memory/memory-store.js';
import type {
  AvatarAnimationSummary,
  AvatarAnimationUploadRequest,
  AvatarAnimationUploadResult,
} from './types.js';

interface FileSystemAdapter {
  mkdir: (target: string) => Promise<void>;
  writeFile: (target: string, data: Buffer) => Promise<void>;
  rm: (target: string) => Promise<void>;
  readFile: (target: string) => Promise<Buffer>;
}

interface AvatarAnimationServiceOptions {
  store: MemoryStore;
  animationsDirectory: string;
  now?: () => number;
  logger?: {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
  fs?: FileSystemAdapter;
}

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

function getFirstAnimation(animations: AnimationClip[]): AnimationClip | null {
  if (!Array.isArray(animations) || animations.length === 0) {
    return null;
  }

  const first = animations[0];
  return first ?? null;
}

function inferFpsFromTracks(tracks: readonly KeyframeTrack[]): number | null {
  let minDelta = Number.POSITIVE_INFINITY;

  for (const track of tracks) {
    const times = track.times;
    if (!times || times.length < 2) {
      continue;
    }

    for (let index = 1; index < times.length; index += 1) {
      const delta = times[index] - times[index - 1];
      if (delta > 0 && delta < minDelta) {
        minDelta = delta;
      }
    }
  }

  if (!Number.isFinite(minDelta)) {
    return null;
  }

  const fps = 1 / minDelta;
  if (!Number.isFinite(fps) || fps <= 0) {
    return null;
  }

  return Number(fps.toFixed(3));
}

async function parseAnimationMetadata(buffer: Buffer): Promise<{ duration: number | null; fps: number | null }> {
  ensureThreeCompatibility();

  const loader = new GLTFLoader();
  loader.register((parser: unknown) => new VRMAnimationLoaderPlugin(parser));

  let gltf: { animations?: AnimationClip[]; userData?: { vrmAnimations?: Array<{ duration?: number }> } };
  try {
    gltf = (await loader.parseAsync(bufferToArrayBuffer(buffer), '')) as typeof gltf;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`VRMA validation failed: ${reason}`);
  }

  const animations = Array.isArray(gltf.animations) ? gltf.animations : [];
  const firstAnimation = getFirstAnimation(animations);
  const vrmAnimations = Array.isArray(gltf.userData?.vrmAnimations) ? gltf.userData?.vrmAnimations : [];
  const vrmDuration = vrmAnimations?.[0]?.duration;
  const duration =
    typeof vrmDuration === 'number' && Number.isFinite(vrmDuration)
      ? vrmDuration
      : typeof firstAnimation?.duration === 'number' && Number.isFinite(firstAnimation.duration)
        ? firstAnimation.duration
        : null;
  const fps = firstAnimation ? inferFpsFromTracks(firstAnimation.tracks) : null;

  return { duration, fps };
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

export class AvatarAnimationService {
  private readonly store: MemoryStore;
  private readonly animationsDirectory: string;
  private readonly now: () => number;
  private readonly logger?: AvatarAnimationServiceOptions['logger'];
  private readonly fs: FileSystemAdapter;

  constructor(options: AvatarAnimationServiceOptions) {
    this.store = options.store;
    this.animationsDirectory = path.resolve(options.animationsDirectory);
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.fs = options.fs ?? defaultFs;
  }

  listAnimations(): AvatarAnimationSummary[] {
    return this.store.listVrmAnimations().map((record) => this.toSummary(record));
  }

  async loadAnimationBinary(animationId: string): Promise<ArrayBuffer> {
    const record = this.store.getVrmAnimation(animationId);
    if (!record) {
      throw new Error('Requested VRMA animation is not available.');
    }

    try {
      const buffer = await this.fs.readFile(record.filePath);
      if (buffer.length === 0) {
        throw new Error('VRMA animation binary is empty.');
      }

      return bufferToArrayBuffer(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to load VRMA animation binary.', {
        animationId,
        filePath: record.filePath,
        message,
      });
      throw new Error('Failed to load VRMA animation binary from disk.');
    }
  }

  async uploadAnimation(request: AvatarAnimationUploadRequest): Promise<AvatarAnimationUploadResult> {
    if (!request || typeof request.fileName !== 'string' || typeof request.data !== 'string') {
      throw new Error('Invalid VRMA upload payload.');
    }

    const fileName = request.fileName.trim();
    if (!fileName.toLowerCase().endsWith('.vrma')) {
      throw new Error('VRMA upload rejected: file must use the .vrma extension.');
    }

    const rawData = typeof request.data === 'string' ? request.data.trim() : '';
    if (!BASE64_PATTERN.test(rawData)) {
      throw new Error('VRMA upload rejected: invalid base64 payload.');
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(rawData, 'base64');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`VRMA upload rejected: invalid base64 payload (${message}).`);
    }

    if (buffer.length === 0) {
      throw new Error('VRMA upload rejected: file is empty.');
    }

    const metadata = await parseAnimationMetadata(buffer);
    const baseName = path.parse(fileName).name || 'VRM Animation';
    const name = sanitizeName(request.name, baseName);
    const id = randomUUID();
    const filePath = path.join(this.animationsDirectory, `${id}.vrma`);
    const createdAt = this.now();
    const fileSha = createHash('sha256').update(buffer).digest('hex');

    try {
      await this.fs.mkdir(this.animationsDirectory);
      await this.fs.writeFile(filePath, buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to persist VRMA animation binary.', { message, filePath });
      throw new Error('Failed to persist VRMA animation binary to disk.');
    }

    const record: VrmAnimationRecord = {
      id,
      name,
      createdAt,
      filePath,
      fileSha,
      duration: metadata.duration,
      fps: metadata.fps,
    };

    try {
      this.store.createVrmAnimation(record);
    } catch (error) {
      await this.fs.rm(filePath).catch(() => {
        this.logger?.warn?.('Failed to clean up VRMA binary after store write failure.', { filePath });
      });
      throw error;
    }

    this.logger?.info?.('VRMA animation uploaded successfully.', { id, filePath });
    return { animation: this.toSummary(record) };
  }

  async deleteAnimation(animationId: string): Promise<void> {
    const record = this.store.getVrmAnimation(animationId);
    if (!record) {
      this.logger?.warn?.('Attempted to delete missing VRMA animation.', { animationId });
      return;
    }

    this.store.deleteVrmAnimation(animationId);

    await this.fs.rm(record.filePath).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.('Failed to remove VRMA animation binary from disk.', {
        animationId,
        filePath: record.filePath,
        message,
      });
    });

    this.logger?.info?.('VRMA animation removed.', { animationId });
  }

  private toSummary(record: VrmAnimationRecord): AvatarAnimationSummary {
    return {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      fileSha: record.fileSha,
      duration: record.duration ?? null,
      fps: record.fps ?? null,
    };
  }
}
