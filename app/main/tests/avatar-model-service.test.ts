import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory/memory-store.js';
import { AvatarModelService } from '../src/avatar/avatar-model-service.js';

const parseAsyncMock = vi.fn<[], Promise<{ userData: { vrm?: { meta?: unknown; dispose?: () => void } }; parser?: { dispose?: () => void } }>>();

const hoistedMocks = vi.hoisted(() => ({
  vrmLoaderPluginMock: vi.fn(),
  vrmMetaLoaderPluginMock: vi.fn(),
}));

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => {
  class MockGLTFLoader {
    register = vi.fn();
    parseAsync = parseAsyncMock;
  }
  return { GLTFLoader: MockGLTFLoader };
});

vi.mock('@pixiv/three-vrm', () => ({
  VRMLoaderPlugin: hoistedMocks.vrmLoaderPluginMock.mockImplementation((_parser, options) => options),
}));

vi.mock('@pixiv/three-vrm-core', () => ({
  VRMMetaLoaderPlugin: hoistedMocks.vrmMetaLoaderPluginMock.mockImplementation((_parser, options?: { acceptV0Meta?: boolean }) => ({
    acceptV0Meta: options?.acceptV0Meta ?? true,
    needThumbnailImage: false,
  })),
}));

const { vrmLoaderPluginMock, vrmMetaLoaderPluginMock } = hoistedMocks;

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
}

function createMockVrmGlb(options?: MockVrmOptions): Buffer {
  const thumbnail = options?.thumbnail ?? createMockThumbnail();
  const metaVersion = options?.metaVersion ?? '1';
  const name = options?.name ?? 'Mock Model';
  const version = options?.version ?? '1.0';

  const json = {
    asset: { version: '2.0' },
    extensions: {
      VRM: {
        meta: {
          metaVersion,
          name,
          version,
          thumbnailImage: 0,
        },
      },
    },
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

beforeEach(() => {
  parseAsyncMock.mockReset();
  vrmLoaderPluginMock.mockClear();
  vrmMetaLoaderPluginMock.mockClear();
});

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

function mockParser(meta: { metaVersion?: string; name?: string; version?: string }) {
  parseAsyncMock.mockResolvedValueOnce({
    userData: {
      vrm: {
        meta,
        dispose: vi.fn(),
      },
    },
    parser: { dispose: vi.fn() },
  });
}

describe('AvatarModelService', () => {
  it('uploads VRM models, stores metadata, and sets active selection', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });
    mockParser({ metaVersion: '1', name: 'Meta Model', version: '1.2' });

    const glb = createMockVrmGlb({ name: 'Meta Model', version: '1.2' });
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

  it('rejects uploads when VRM metadata is not 1.0', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });
    mockParser({ metaVersion: '0', name: 'Legacy Model' });

    const glb = createMockVrmGlb({ metaVersion: '0' });
    const base64 = glb.toString('base64');

    await expect(service.uploadModel({ fileName: 'legacy.vrm', data: base64 })).rejects.toThrow(
      /expected VRM 1\.0/i,
    );
    expect(service.listModels()).toHaveLength(0);
  });

  it('falls back to another model when the active model is deleted', async () => {
    const { store, modelsDirectory } = await createEnvironment();
    const service = new AvatarModelService({ store, modelsDirectory });

    mockParser({ metaVersion: '1', name: 'Primary' });
    const first = await service.uploadModel({ fileName: 'primary.vrm', data: createMockVrmGlb({ name: 'Primary' }).toString('base64') });

    mockParser({ metaVersion: '1', name: 'Secondary' });
    const second = await service.uploadModel({ fileName: 'secondary.vrm', data: createMockVrmGlb({ name: 'Secondary' }).toString('base64') });

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

    mockParser({ metaVersion: '1', name: 'Only Model' });
    const uploaded = await service.uploadModel({
      fileName: 'only.vrm',
      data: createMockVrmGlb({ name: 'Only Model' }).toString('base64'),
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

    mockParser({ metaVersion: '1', name: 'Model' });
    await service.uploadModel({ fileName: 'model.vrm', data: createMockVrmGlb().toString('base64') });

    await service.setActiveModel(null);
    expect(store.getActiveVrmModelId()).toBeNull();
  });
});
