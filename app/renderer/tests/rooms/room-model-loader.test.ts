import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildRoom } from '../../src/rooms/room-builder.js';
import { createModelLoader, modelUrl } from '../../src/rooms/room-model-loader.js';
import type { RoomObject } from '../../../main/src/rooms/types.js';
import { builtInRoom } from './fixtures.js';

const object = (over: Partial<RoomObject> = {}): RoomObject => ({
  id: 'chair',
  name: 'chair',
  position: [1, 0, 1],
  size: [1, 1, 1],
  model: { asset: 'polyhaven/ArmChair_01', file: 'textures/a b.gltf', scale: 2 },
  ...over,
});
const scene = () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.position.set(3, 5, -2); // off-centre in the file
  root.add(mesh);
  return root;
};

describe('model loader', () => {
  it('builds the asset URL', () => {
    expect(modelUrl(object())).toBe('aiembodied-asset://polyhaven/ArmChair_01/textures/a%20b.gltf');
    expect(modelUrl(object({ model: { file: 'x.glb' } }))).toBeNull();
  });
  it('builds the URL of a generated .glb, which the same loader grounds and centres', async () => {
    const generated = object({ model: { asset: 'generated/rocking-chair-3fa91c2e', file: 'model.glb', scale: 0.5 } });
    expect(modelUrl(generated)).toBe('aiembodied-asset://generated/rocking-chair-3fa91c2e/model.glb');
    const urls: string[] = [];
    const model = await createModelLoader({ load: async (url) => (urls.push(url), { scene: scene() }) })(generated);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    expect(urls).toEqual(['aiembodied-asset://generated/rocking-chair-3fa91c2e/model.glb']);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(0.5);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0);
  });
  it('scales, centres the footprint and puts the bottom on the floor', async () => {
    const urls: string[] = [];
    const load = createModelLoader({ load: async (url) => (urls.push(url), { scene: scene() }) });
    const model = await load(object());
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    expect(urls).toHaveLength(1);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(2);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0);
  });
  it('rejects objects without a library model', async () => {
    await expect(createModelLoader({ load: async () => ({ scene: scene() }) })(object({ model: { file: 'x.glb' } }))).rejects.toThrow();
  });
});

describe('buildRoom with library models', () => {
  const room = () => ({ ...builtInRoom('reading-room'), objects: [object({ parts: undefined })] });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('shows a grey placeholder at once and swaps the model in when it loads', async () => {
    const loaded = new THREE.Group();
    loaded.name = 'loaded';
    const built = buildRoom(room(), { loadModel: async () => loaded });
    const node = built.objectNodes.get('chair')!;
    expect(node.getObjectByName('placeholder')).toBeTruthy();
    await flush();
    expect(node.getObjectByName('placeholder')).toBeUndefined();
    expect(node.getObjectByName('loaded')).toBe(loaded);
    built.dispose();
  });

  it('keeps the grey box when loading fails', async () => {
    const built = buildRoom(room(), { loadModel: async () => { throw new Error('404'); } });
    await flush();
    expect(built.objectNodes.get('chair')!.getObjectByName('placeholder')).toBeTruthy();
    built.dispose();
  });

  it('ignores a model that arrives after the room is disposed', async () => {
    let finish!: (group: THREE.Group) => void;
    const built = buildRoom(room(), { loadModel: () => new Promise<THREE.Group>((resolve) => (finish = resolve)) });
    const node = built.objectNodes.get('chair')!;
    built.dispose();
    const late = new THREE.Group();
    late.name = 'late';
    finish(late);
    await flush();
    expect(node.getObjectByName('late')).toBeUndefined();
  });
});
