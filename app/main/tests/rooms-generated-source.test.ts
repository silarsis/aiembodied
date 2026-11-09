import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComfyGraph } from '../src/avatar/generation/comfyui-client.js';
import type { GeometryModel } from '../src/avatar/generation/character-model-service.js';
import type { ImageWorkflowModel } from '../src/avatar/generation/image-workflows.js';
import { GeneratedLibrary } from '../src/rooms/asset-library/generated-library.js';
import { GeneratedSource, type ObjectComfy } from '../src/rooms/asset-library/generated-source.js';
import { validateLayout, type LayoutObject } from '../src/rooms/room-layout.js';
import { makeGlb } from './rooms-glb-fixture.js';

const PNG = Buffer.from('fake-png-bytes');
const trellis: GeometryModel = { kind: 'trellis2', id: 'trellis.safetensors', name: 'TRELLIS.2', unet: 'trellis.safetensors', shapeVae: 'shape.safetensors', textureVae: 'tex.safetensors' };
const qwen: ImageWorkflowModel = {
  id: 'diffusion_models:qwen.safetensors',
  name: 'Qwen',
  family: 'qwen-image-2.1',
  model: 'qwen.safetensors',
  clip: 'clip.safetensors',
  vae: 'vae.safetensors',
  loras: [{ name: 'anime.safetensors', strength: 0.8, triggerWords: ['animestyle'] }],
};

function layoutObject(overrides: Record<string, unknown> = {}): LayoutObject {
  const layout = validateLayout({
    name: 'Study',
    shell: { width: 5, depth: 5, height: 2.7 },
    objects: [{ id: 'chair', name: 'rocking chair', search: 'rocking chair', category: 'seat', size: [0.6, 0.9, 0.6], color: 'walnut', place: { against: 'north' }, ...overrides }],
  });
  return layout.objects[0];
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'generated-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeComfy(options: { glb?: Buffer; failImage?: boolean; failMesh?: boolean } = {}) {
  const calls: Array<{ stage: string; graph?: ComfyGraph; output?: string; upload?: string }> = [];
  let running = 0;
  let peak = 0;
  const client: ObjectComfy = {
    async uploadImage(name) {
      calls.push({ stage: 'upload', upload: name });
      return `aiembodied/${name}`;
    },
    async run(graph, runOptions) {
      running += 1;
      peak = Math.max(peak, running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (runOptions?.signal?.aborted) throw new Error('ComfyUI job cancelled.');
        calls.push({ stage: runOptions?.output === 'mesh' ? 'mesh' : 'image', graph, output: runOptions?.output });
        if (runOptions?.output === 'mesh') {
          if (options.failMesh) throw new Error('ComfyUI failed: out of memory');
          return options.glb ?? makeGlb({ min: [-0.4, 0, -0.5], max: [0.4, 1.8, 0.5] });
        }
        if (options.failImage) throw new Error('ComfyUI rejected the workflow');
        return PNG;
      } finally {
        running -= 1;
      }
    },
  };
  return { client, calls, peak: () => peak };
}

function source(comfy: ObjectComfy, extra: { picked?: string[] } = {}) {
  let seed = 100;
  return new GeneratedSource({
    library: new GeneratedLibrary(dir),
    pickComfy: async (stage) => {
      extra.picked?.push(stage);
      return comfy;
    },
    imageModel: async () => qwen,
    geometryModel: async () => trellis,
    seed: () => (seed += 1),
    now: () => new Date('2026-11-09T10:00:00Z'),
  });
}

describe('GeneratedSource', () => {
  it('draws the object, builds the mesh from that picture and keeps it in the generated library', async () => {
    const { client, calls } = fakeComfy();
    const picked: string[] = [];
    const generated = source(client, { picked });
    const made = await generated.generate(layoutObject(), new AbortController().signal);

    expect(made.reused).toBe(false);
    expect(picked).toEqual(['image', 'mesh']);
    expect(made.resolved.model).toMatchObject({ file: 'model.glb' });
    expect(made.resolved.model.asset).toMatch(/^generated\/rocking-chair-[0-9a-f]{8}$/);
    // 0.9 m wanted, model is 1.8 m tall: scaled to 0.5 (the lowest allowed), real size follows.
    expect(made.resolved.model.scale).toBe(0.5);
    expect(made.resolved.size).toEqual([0.4, 0.9, 0.5]);

    const image = calls.find((c) => c.stage === 'image')!;
    expect(image.graph?.encode.inputs.prompt).toContain('a single rocking chair, walnut');
    expect(image.graph?.encode.inputs.prompt).not.toContain('animestyle');
    expect(JSON.stringify(image.graph)).not.toContain('anime.safetensors');
    expect(image.graph?.encode.inputs.negative_prompt).toContain('multiple objects');
    expect(image.graph?.save.inputs.filename_prefix).toBe('aiembodied/room-object');

    const upload = calls.find((c) => c.stage === 'upload')!;
    const mesh = calls.find((c) => c.stage === 'mesh')!;
    expect(mesh.output).toBe('mesh');
    expect(mesh.graph?.image.inputs.image).toBe(`aiembodied/${upload.upload}`);
    expect(mesh.graph?.unet.inputs.unet_name).toBe('trellis.safetensors');

    const folder = path.join(dir, made.resolved.model.asset);
    expect((await readdir(folder)).sort()).toEqual(['meta.json', 'model.glb', 'source.png']);
    expect((await readFile(path.join(folder, 'source.png'))).equals(PNG)).toBe(true);
    const meta = JSON.parse(await readFile(path.join(folder, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      name: 'rocking chair',
      search: 'rocking chair',
      category: 'seat',
      created: '2026-11-09T10:00:00.000Z',
      sourceImage: 'source.png',
      bbox: { size: [0.8, 1.8, 1] },
    });
    expect(meta.prompt).toContain('isolated on plain white background');
  });

  it('can use the single-view Hunyuan graph too', async () => {
    const { client, calls } = fakeComfy();
    const generated = new GeneratedSource({
      library: new GeneratedLibrary(dir),
      pickComfy: async () => client,
      imageModel: async () => qwen,
      geometryModel: async () => ({ kind: 'hunyuan3d-2mv', id: 'h.safetensors', name: 'Hunyuan3D 2mv', checkpoint: 'h.safetensors' }),
    });
    await generated.generate(layoutObject(), new AbortController().signal);
    const mesh = calls.find((c) => c.stage === 'mesh')!;
    expect(Object.keys(mesh.graph!)).toContain('front_image');
    expect(Object.keys(mesh.graph!)).not.toContain('left_image');
    expect(Object.keys(mesh.graph!)).not.toContain('back_image');
  });

  it('fails with the reason and stores nothing when the image or the mesh step fails', async () => {
    const image = fakeComfy({ failImage: true });
    await expect(source(image.client).generate(layoutObject(), new AbortController().signal)).rejects.toThrow('rejected the workflow');
    const mesh = fakeComfy({ failMesh: true });
    await expect(source(mesh.client).generate(layoutObject(), new AbortController().signal)).rejects.toThrow('out of memory');
    expect(await readdir(path.join(dir)).catch(() => [])).toEqual([]);
  });

  it('rejects a mesh that is not a usable glb', async () => {
    const { client } = fakeComfy({ glb: Buffer.from('this is not a glb') });
    await expect(source(client).generate(layoutObject(), new AbortController().signal)).rejects.toThrow(/usable model/);
    const flat = fakeComfy({ glb: makeGlb({ min: [0, 0, 0], max: [1, 0, 1] }) });
    await expect(source(flat.client).generate(layoutObject(), new AbortController().signal)).rejects.toThrow(/usable model/);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('reuses an earlier object for the same sort of thing, without calling ComfyUI', async () => {
    const { client, calls } = fakeComfy();
    const generated = source(client);
    const first = await generated.generate(layoutObject(), new AbortController().signal);
    const callsAfterFirst = calls.length;

    const again = layoutObject({ id: 'chair2', name: 'rocking chairs', search: 'rocking chair' });
    expect(await generated.resolve(again)).toMatchObject({ model: { asset: first.resolved.model.asset } });
    const second = await generated.generate(again, new AbortController().signal);
    expect(second.reused).toBe(true);
    expect(second.resolved.model.asset).toBe(first.resolved.model.asset);
    expect(calls).toHaveLength(callsAfterFirst);

    // Something else is not matched.
    expect(await generated.resolve(layoutObject({ id: 'lamp', name: 'floor lamp', search: 'floor lamp', category: 'lamp' }))).toBeNull();
    expect(await generated.resolve(layoutObject({ id: 'bed', name: 'rocking chair', search: 'rocking chair', category: 'bed' }))).toBeNull();
  });

  it('makes one object at a time', async () => {
    const fake = fakeComfy();
    const generated = source(fake.client);
    const signal = new AbortController().signal;
    await Promise.all([
      generated.generate(layoutObject({ id: 'a', name: 'bookshelf', search: 'bookshelf', category: 'storage' }), signal),
      generated.generate(layoutObject({ id: 'b', name: 'floor lamp', search: 'floor lamp', category: 'lamp' }), signal),
    ]);
    expect(fake.peak()).toBe(1);
    expect(await generated.list()).toHaveLength(2);
  });

  it('stops when cancelled', async () => {
    const { client } = fakeComfy();
    const controller = new AbortController();
    const pending = source(client).generate(layoutObject(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel/i);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('lists with the picture URL and deletes by folder name only', async () => {
    const { client } = fakeComfy();
    const generated = source(client);
    const made = await generated.generate(layoutObject(), new AbortController().signal);
    const [listed] = await generated.list();
    const id = made.resolved.model.asset.split('/')[1];
    expect(listed).toMatchObject({ id, name: 'rocking chair', imageUrl: `aiembodied-asset://generated/${id}/source.png` });
    await expect(generated.remove('../polyhaven')).rejects.toThrow();
    await generated.remove(id);
    expect(await generated.list()).toEqual([]);
    expect(await generated.resolve(layoutObject())).toBeNull();
  });

  it('does not offer a damaged entry', async () => {
    const { client } = fakeComfy();
    const generated = source(client);
    const made = await generated.generate(layoutObject(), new AbortController().signal);
    await rm(path.join(dir, made.resolved.model.asset, 'model.glb'));
    expect(await generated.list()).toEqual([]);
  });
});
