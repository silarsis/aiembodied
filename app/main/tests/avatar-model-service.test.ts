import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory/memory-store.js';
import { AvatarModelService } from '../src/avatar/avatar-model-service.js';

function createMockThumbnail(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG header
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk (partial, minimal placeholder)
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
  ]);
}

interface MockVrmOptions {
  name?: string;
  version?: string;
  metaVersion?: string;
  thumbnail?: Buffer;
  useVrmc?: boolean;
  specVersion?: string;
}

function createMockVrmGlb(options?: MockVrmOptions): Buffer {
  const thumbnail = options?.thumbnail ?? createMockThumbnail();
  const metaVersion = options?.metaVersion ?? '1';
  const name = options?.name ?? 'Mock Model';
  const version = options?.version ?? '1.0';
  const useVrmc = options?.useVrmc ?? false;
  const specVersion = options?.specVersion ?? '1.0';

  const vrmExtension = useVrmc
    ? {
        VRMC_vrm: {
          specVersion,
          meta: {
            name,
            version,
            thumbnailImage: 0,
          },
        },
      }
    : {
        VRM: {
          meta: {
            metaVersion,
            name,
            version,
            thumbnailImage: 0,
          },
        },
      };

  const json = {
    asset: { version: '2.0' },
    extensions: vrmExtension,
    images: [
      {
        bufferView: 0,
        mimeType: 'image/png',
      },
    ],
    bufferViews: [
      {
        buffer: 0,
        byteOffset: 0,
        byteLength: thumbnail.length,
      },
    ],
    buffers: [
      {
        byteLength: thumbnail.length,
      },
    ],
  };

  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc(jsonPadding, 0x20)]);

  const binPadding = (4 - (thumbnail.length % 4)) % 4;
  const binaryChunk = Buffer.concat([thumbnail, Buffer.alloc(binPadding, 0)]);

  const totalLength = 12 + 8 + paddedJson.length + 8 + binaryChunk.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binaryChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  return Buffer.concat([header, jsonHeader, paddedJson, binHeader, binaryChunk]);
}

const tempDirs: string[] = [];
const stores: MemoryStore[] = [];

async function createEnvironment() {
  const root = await mkdtemp(path.join(tmpdir(), 'avatar-model-service-'));
  tempDirs.push(root);
  const store = new MemoryStore({ filePath: path.join(root, 'memory.db') });
  stores.push(store);
  const modelsDirectory = path.join(root, 'models');
  return { store, modelsDirectory };
}

afterEach(async () => {
  while (stores.length > 0) {
    const store = stores.pop();
    store?.dispose();
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('AvatarModelService', () => {
  it('uploads VRM models, stores metadata, and sets active selection', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    const glb = createMockVrmGlb({ name: 'Meta Model', version: '1.2', useVrmc: true });
    const base64 = glb.toString('base64');
    const result = await service.uploadModel({ fileName: 'sample.vrm', data: base64 });

    expect(result.model.name).toBe('Meta Model');
    expect(result.model.version).toBe('1.2');
    expect(result.model.thumbnailDataUrl).toMatch(/^data:image\/png;base64,/);

    const models = service.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe(result.model.id);
    expect(store.getActiveVrmModelId()).toBe(result.model.id);

    const written = await readFile(path.join(modelsDirectory, `${result.model.id}.vrm`));
    expect(written.length).toBeGreaterThan(0);
  });

  it('rejects uploads when VRM metadata uses an unsupported version', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    const glb = createMockVrmGlb({ metaVersion: '2' });
    const base64 = glb.toString('base64');

    await expect(service.uploadModel({ fileName: 'legacy.vrm', data: base64 })).rejects.toThrow(
      /expected VRM 0\.0\/1\.0/i,
    );
    expect(service.listModels()).toHaveLength(0);
  });

  it('accepts VRM 0.x metadata when VRM 1.0 metadata is not present', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    const glb = createMockVrmGlb({ metaVersion: '0', name: 'Legacy Model' });
    const base64 = glb.toString('base64');

    const result = await service.uploadModel({ fileName: 'legacy.vrm', data: base64 });
    expect(result.model.name).toBe('Legacy Model');
  });

  it('falls back to another model when the active model is deleted', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    const first = await service.uploadModel({
      fileName: 'primary.vrm',
      data: createMockVrmGlb({ name: 'Primary', useVrmc: true }).toString('base64'),
    });

    const second = await service.uploadModel({
      fileName: 'secondary.vrm',
      data: createMockVrmGlb({ name: 'Secondary', useVrmc: true }).toString('base64'),
    });

    await service.setActiveModel(second.model.id);
    expect(service.getActiveModel()?.id).toBe(second.model.id);

    await service.deleteModel(second.model.id);
    const active = service.getActiveModel();
    expect(active?.id).toBe(first.model.id);
    expect(service.listModels()).toHaveLength(1);
  });

  it('returns current selection when attempting to set an unknown model id', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    const uploaded = await service.uploadModel({
      fileName: 'only.vrm',
      data: createMockVrmGlb({ name: 'Only Model', useVrmc: true }).toString('base64'),
    });

    const activeBefore = service.getActiveModel();
    expect(activeBefore?.id).toBe(uploaded.model.id);

    const activeAfter = await service.setActiveModel('missing-model-id');
    expect(activeAfter?.id).toBe(uploaded.model.id);
  });

  it('rejects non-base64 payloads during upload', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    await expect(service.uploadModel({ fileName: 'invalid.vrm', data: '***notbase64***' })).rejects.toThrow(/invalid base64/i);
  });

  it('rejects files without the .vrm extension', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    await expect(service.uploadModel({ fileName: 'avatar.glb', data: 'AAAA' })).rejects.toThrow(/must use the \.vrm extension/i);
  });

  it('clears active selection when requested', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    await service.uploadModel({ fileName: 'model.vrm', data: createMockVrmGlb({ useVrmc: true }).toString('base64') });

    await service.setActiveModel(null);
    expect(store.getActiveVrmModelId()).toBeNull();
  });

  it('loads VRM binaries as array buffers for known models', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    const uploaded = await service.uploadModel({
      fileName: 'model.vrm',
      data: createMockVrmGlb({ useVrmc: true }).toString('base64'),
    });

    const buffer = await service.loadModelBinary(uploaded.model.id);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buffer).length).toBeGreaterThan(0);
  });

  it('throws a descriptive error when loading binaries fails', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const failingFs = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(new Error('nope')),
    };
    const service = new AvatarModelService({ store, modelsDirectory, fs: failingFs });

    const uploaded = await service.uploadModel({
      fileName: 'model.vrm',
      data: createMockVrmGlb({ useVrmc: true }).toString('base64'),
    });

    await expect(service.loadModelBinary(uploaded.model.id)).rejects.toThrow(
      /failed to load vrm model binary/i,
    );
  });
});
