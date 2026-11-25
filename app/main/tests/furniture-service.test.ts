import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FURNITURE_KEY, FurnitureService, type FurnitureServiceOptions } from '../src/furniture/furniture-service.js';
import { glbBounds } from '../src/rooms/asset-library/gltf-bounds.js';
import type { FurnitureItem } from '../src/furniture/types.js';
import { boxGlb } from './fixtures/box-glb.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const png = PNG.sync.write(new PNG({ width: 64, height: 48 }));
const geometry = { kind: 'trellis2', id: 't', name: 'T', unet: 'u', shapeVae: 's', textureVae: 'x' } as const;
const imageModel = { id: 'q', name: 'Q', family: 'qwen-image-2.1', model: 'q.safetensors', clip: 'c', vae: 'v' } as const;
const sized = '{"name":"Club Chair","category":"seating","width_m":0.9,"depth_m":0.8,"height_m":0.9}';

/** A promise to settle by hand, so a test can hold a ComfyUI run open. */
function gate<T = void>() {
  let release!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

async function setup(overrides: Partial<FurnitureServiceOptions> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'furniture-'));
  directories.push(directory);
  const values = new Map<string, string>();
  const events: FurnitureItem[] = [];
  const runs = { image: vi.fn(async () => png), mesh: vi.fn(async () => boxGlb([-1, 0, -1], [1, 2, 1])) };
  const comfy = {
    uploadImage: vi.fn(async (name: string) => name),
    run: vi.fn(async (_graph: unknown, options?: { signal?: AbortSignal; output?: 'image' | 'mesh' }) => (options?.output === 'mesh' ? runs.mesh() : runs.image())),
  };
  const options: FurnitureServiceOptions = {
    store: { getValue: (key) => values.get(key) ?? null, setValue: (key, value) => void values.set(key, value) },
    directory,
    pickComfy: async () => comfy,
    imageModel: async () => imageModel,
    geometryModel: async () => geometry,
    askHelper: async () => sized,
    onChanged: (item) => events.push(item),
    ...overrides,
  };
  const service = new FurnitureService(options);
  /** Waits until the piece is no longer generating. */
  const settled = async (id: string): Promise<FurnitureItem> => {
    await vi.waitFor(async () => expect((await service.load(id)).status).not.toBe('generating'));
    return service.load(id);
  };
  return { service, options, values, events, runs, comfy, directory, settled };
}

const exists = (file: string) => access(file).then(() => true, () => false);

describe('furniture generation', () => {
  it('returns at once as generating, then makes a model of the real size', async () => {
    const { service, directory, settled, events, comfy } = await setup();
    const started = await service.generate('  a leather club chair ');
    expect(started).toMatchObject({ status: 'generating', prompt: 'a leather club chair', hasModel: false });

    const item = await settled(started.id);
    expect(item).toMatchObject({ status: 'ready', name: 'Club Chair', category: 'seating', hasModel: true });
    expect(item.error).toBeUndefined();
    expect(item.dimensions).toEqual([0.9, 0.9, 0.9]);
    expect(item.fit?.scale).toBeCloseTo(0.45);
    expect(item.thumbnailDataUrl).toMatch(/^data:image\/png;base64,/);

    const model = await service.model(started.id);
    expect(glbBounds(model)?.size.map((n) => Math.round(n * 100) / 100)).toEqual([0.9, 0.9, 0.9]);
    for (const file of ['image.png', 'thumb.png', 'model-raw.glb', 'model.glb'])
      expect(await exists(path.join(directory, started.id, file))).toBe(true);
    expect(await exists(path.join(directory, started.id, 'next'))).toBe(false);
    expect(events.some((e) => e.message === 'Building the 3D model')).toBe(true);
    expect(events.at(-1)?.status).toBe('ready');
    // The mesh step is told to return a mesh; the picture is uploaded to it.
    expect(comfy.uploadImage).toHaveBeenCalledOnce();
    expect(comfy.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ output: 'mesh' }));
  });

  it('sizes from the keyword table without a helper', async () => {
    const { service, settled } = await setup({ askHelper: undefined });
    const item = await settled((await service.generate('a plush sofa')).id);
    expect(item.dimensions[1]).toBe(0.85);
    expect(item.category).toBe('seating');
  });

  it('paints a bare Hunyuan shape with the picture', async () => {
    const paint = vi.fn(async (input: { meshPath: string; outputPath: string }) => {
      const { copyFile } = await import('node:fs/promises');
      await copyFile(input.meshPath, input.outputPath);
    });
    const { service, settled } = await setup({
      paint,
      geometryModel: async () => ({ kind: 'hunyuan3d-2mv', id: 'h', name: 'H', checkpoint: 'h.safetensors' }),
    });
    expect((await settled((await service.generate('a chair')).id)).status).toBe('ready');
    expect(paint).toHaveBeenCalledOnce();
    expect(paint.mock.calls[0][0]).toMatchObject({ front: expect.stringContaining('image.png') });
  });

  it('fails with the reason, and keeps nothing, when there is no 3D model installed', async () => {
    const { service, settled, directory } = await setup({
      geometryModel: async () => {
        throw new Error('Install TRELLIS.2 or Hunyuan3D 2mv in ComfyUI.');
      },
    });
    const started = await service.generate('a chair');
    const item = await settled(started.id);
    expect(item).toMatchObject({ status: 'failed', error: 'Install TRELLIS.2 or Hunyuan3D 2mv in ComfyUI.', hasModel: false });
    expect(await exists(path.join(directory, started.id, 'next'))).toBe(false);
    await expect(service.model(started.id)).rejects.toThrow('no 3D model');
  });

  it('rejects empty and over-long prompts', async () => {
    const { service } = await setup();
    await expect(service.generate('   ')).rejects.toThrow('Describe a piece');
    await expect(service.generate('x'.repeat(1001))).rejects.toThrow('Describe a piece');
  });

  it('makes one piece at a time, in order', async () => {
    const first = gate<Buffer>();
    const { service, runs, settled } = await setup();
    runs.image.mockImplementationOnce(() => first.promise);
    const a = await service.generate('a chair');
    const b = await service.generate('a desk');
    await vi.waitFor(() => expect(runs.image).toHaveBeenCalledOnce());
    expect((await service.load(b.id)).message).toBe('Waiting for the earlier piece to finish');
    first.release(png);
    expect((await settled(a.id)).status).toBe('ready');
    expect((await settled(b.id)).status).toBe('ready');
    expect(runs.image).toHaveBeenCalledTimes(2);
  });
});

describe('editing', () => {
  it('runs again with the new prompt, keeping the id, and replaces the files', async () => {
    const { service, settled, runs } = await setup();
    const { id } = await service.generate('a chair');
    await settled(id);
    runs.mesh.mockResolvedValueOnce(boxGlb([0, 0, 0], [1, 4, 1]));
    const editing = await service.edit(id, 'a taller stool');
    expect(editing).toMatchObject({ id, status: 'generating', hasModel: true });
    const item = await settled(id);
    expect(item).toMatchObject({ id, prompt: 'a taller stool', status: 'ready' });
    expect(glbBounds(await service.model(id))?.size[0]).toBeCloseTo(0.225);
    expect(await service.list()).toHaveLength(1);
  });

  it('keeps the old model and says why when the new run fails', async () => {
    const { service, settled, runs } = await setup();
    const { id } = await service.generate('a chair');
    await settled(id);
    const before = await service.model(id);
    runs.image.mockRejectedValueOnce(new Error('ComfyUI is down.'));
    await service.edit(id, 'a stool');
    const item = await vi.waitFor(async () => {
      const current = await service.load(id);
      expect(current.status).toBe('ready');
      expect(current.error).toBe('ComfyUI is down.');
      return current;
    });
    expect(item).toMatchObject({ prompt: 'a chair', hasModel: true });
    expect((await service.model(id)).equals(before)).toBe(true);
  });

  it('refuses a piece that is already being made, or one that does not exist', async () => {
    const hold = gate<Buffer>();
    const { service, runs, settled } = await setup();
    runs.image.mockImplementationOnce(() => hold.promise);
    const { id } = await service.generate('a chair');
    await expect(service.edit(id, 'a stool')).rejects.toThrow('already being made');
    await expect(service.edit('00000000-0000-0000-0000-000000000000', 'x')).rejects.toThrow('not available');
    hold.release(png);
    await settled(id);
  });
});

describe('deleting', () => {
  it('removes the files and the record', async () => {
    const { service, settled, directory, values } = await setup();
    const { id } = await service.generate('a chair');
    await settled(id);
    await service.delete(id);
    expect(await service.list()).toEqual([]);
    expect(await exists(path.join(directory, id))).toBe(false);
    expect(JSON.parse(values.get(FURNITURE_KEY) ?? '[]')).toEqual([]);
    await expect(service.load(id)).rejects.toThrow('not available');
  });

  it('cancels a running job and does not bring the piece back', async () => {
    const hold = gate<Buffer>();
    const { service, runs, directory, comfy } = await setup();
    comfy.run.mockImplementationOnce(async (_graph, options) => {
      await new Promise<void>((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('ComfyUI job cancelled.'))));
      return hold.promise;
    });
    const { id } = await service.generate('a chair');
    await vi.waitFor(() => expect(comfy.run).toHaveBeenCalledOnce());
    await service.delete(id);
    expect(await service.list()).toEqual([]);
    expect(await exists(path.join(directory, id))).toBe(false);
    expect(runs.mesh).not.toHaveBeenCalled();
  });

  it('lets a queued piece go without waiting for the running one', async () => {
    const hold = gate<Buffer>();
    const { service, runs, settled } = await setup();
    runs.image.mockImplementationOnce(() => hold.promise);
    const a = await service.generate('a chair');
    const b = await service.generate('a desk');
    await service.delete(b.id);
    hold.release(png);
    expect((await settled(a.id)).status).toBe('ready');
    expect(runs.image).toHaveBeenCalledOnce();
  });
});

describe('restart', () => {
  it('turns interrupted runs into failures, keeping an old model', async () => {
    const { service, settled, values, options } = await setup();
    const { id } = await service.generate('a chair');
    await settled(id);
    const records = JSON.parse(values.get(FURNITURE_KEY) ?? '[]');
    const orphan = { ...records[0], id: '11111111-1111-1111-1111-111111111111', status: 'generating' };
    values.set(FURNITURE_KEY, JSON.stringify([{ ...records[0], status: 'generating' }, orphan]));
    const restarted = new FurnitureService(options);
    await restarted.initialize();
    expect(await restarted.load(id)).toMatchObject({ status: 'ready', error: 'Interrupted.' });
    expect(await restarted.load(orphan.id)).toMatchObject({ status: 'failed', error: 'Interrupted.' });
    expect((await readFile(path.join(options.directory, id, 'model.glb'))).length).toBeGreaterThan(0);
  });

  it('ignores a damaged library', async () => {
    const { service, values } = await setup();
    values.set(FURNITURE_KEY, '{nope');
    expect(await service.list()).toEqual([]);
  });
});
