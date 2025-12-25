import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory/memory-store.js';
import { AvatarAnimationService } from '../src/avatar/avatar-animation-service.js';

const parseAsyncMock = vi.fn<
  [],
  Promise<{
    animations?: Array<{ duration: number; tracks: Array<{ times: Float32Array }> }>;
    userData?: { vrmAnimations?: Array<{ duration?: number }> };
  }>
>();

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => {
  class MockGLTFLoader {
    register = vi.fn();
    parseAsync = parseAsyncMock;
  }
  return { GLTFLoader: MockGLTFLoader };
});

const hoistedMocks = vi.hoisted(() => ({
  vrmAnimationLoaderPluginMock: vi.fn(),
}));

vi.mock('@pixiv/three-vrm-animation', () => ({
  VRMAnimationLoaderPlugin: hoistedMocks.vrmAnimationLoaderPluginMock.mockImplementation((parser) => ({ parser })),
}));

const { vrmAnimationLoaderPluginMock } = hoistedMocks;

const tempDirs: string[] = [];
const stores: MemoryStore[] = [];

async function createEnvironment() {
  const root = await mkdtemp(path.join(tmpdir(), 'avatar-animation-service-'));
  tempDirs.push(root);
  const store = new MemoryStore({ filePath: path.join(root, 'memory.db') });
  stores.push(store);
  const animationsDirectory = path.join(root, 'animations');
  return { store, animationsDirectory };
}

function mockAnimationParser(duration = 1.5) {
  parseAsyncMock.mockResolvedValueOnce({
    animations: [
      {
        duration,
        tracks: [{ times: Float32Array.from([0, 0.5, 1.0]) }],
      },
    ],
    userData: {
      vrmAnimations: [{ duration }],
    },
  });
}

beforeEach(() => {
  parseAsyncMock.mockReset();
  vrmAnimationLoaderPluginMock.mockClear();
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

describe('AvatarAnimationService', () => {
  it('uploads VRMA animations, stores metadata, and persists binaries', async () => {
    const { store, animationsDirectory } = await createEnvironment();
    const service = new AvatarAnimationService({ store, animationsDirectory });
    mockAnimationParser(1.5);

    const base64 = Buffer.from('vrma-binary').toString('base64');
    const result = await service.uploadAnimation({ fileName: 'idle.vrma', data: base64 });

    expect(result.animation.name).toBe('idle');
    expect(result.animation.duration).toBeCloseTo(1.5);
    expect(result.animation.fps).toBeCloseTo(2);

    const listed = service.listAnimations();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(result.animation.id);

    const stored = await readFile(path.join(animationsDirectory, `${result.animation.id}.vrma`));
    expect(stored.length).toBeGreaterThan(0);
  });

  it('rejects non-base64 uploads', async () => {
    const { store, animationsDirectory } = await createEnvironment();
    const service = new AvatarAnimationService({ store, animationsDirectory });

    await expect(
      service.uploadAnimation({ fileName: 'idle.vrma', data: 'not-base64' }),
    ).rejects.toThrow(/invalid base64/i);
  });

  it('rejects files without the .vrma extension', async () => {
    const { store, animationsDirectory } = await createEnvironment();
    const service = new AvatarAnimationService({ store, animationsDirectory });

    await expect(
      service.uploadAnimation({ fileName: 'idle.glb', data: 'AAAA' }),
    ).rejects.toThrow(/must use the \.vrma extension/i);
  });

  it('loads VRMA binaries as array buffers for known animations', async () => {
    const { store, animationsDirectory } = await createEnvironment();
    const service = new AvatarAnimationService({ store, animationsDirectory });
    mockAnimationParser(1.0);

    const uploaded = await service.uploadAnimation({
      fileName: 'loop.vrma',
      data: Buffer.from('loop').toString('base64'),
    });

    const buffer = await service.loadAnimationBinary(uploaded.animation.id);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buffer).length).toBeGreaterThan(0);
  });

  it('throws a descriptive error when loading animation binaries fails', async () => {
    const { store, animationsDirectory } = await createEnvironment();
    const failingFs = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(new Error('nope')),
    };
    const service = new AvatarAnimationService({ store, animationsDirectory, fs: failingFs });
    mockAnimationParser(1.0);

    const uploaded = await service.uploadAnimation({
      fileName: 'fail.vrma',
      data: Buffer.from('fail').toString('base64'),
    });

    await expect(service.loadAnimationBinary(uploaded.animation.id)).rejects.toThrow(
      /failed to load vrma animation binary/i,
    );
  });
});
