import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RoomObject } from '../../../main/src/rooms/types.js';

export const ASSET_SCHEME = 'aiembodied-asset';

export interface GltfLike {
  scene: THREE.Object3D;
}
export interface ModelLoaderDeps {
  load?: (url: string) => Promise<GltfLike>;
}

/** The URL the main process serves a library model on. */
export function modelUrl(object: Pick<RoomObject, 'model'>): string | null {
  const model = object.model;
  if (!model?.asset || !model.file) return null;
  return `${ASSET_SCHEME}://${model.asset}/${model.file.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The `loadModel` hook of the room builder: fetches a library model, applies `model.scale`, and
 * puts its footprint centre on the object origin with the bottom on the floor.
 */
export function createModelLoader(deps: ModelLoaderDeps = {}): (object: RoomObject) => Promise<THREE.Object3D> {
  const load = deps.load ?? ((url: string) => new GLTFLoader().loadAsync(url));
  return async (object) => {
    const url = modelUrl(object);
    if (!url) throw new Error(`Object ${object.id} has no library model.`);
    const gltf = await load(url);
    const scale = object.model?.scale ?? 1;
    const inner = gltf.scene;
    inner.scale.multiplyScalar(scale);
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    if (box.isEmpty()) throw new Error(`Model for ${object.id} is empty.`);
    inner.position.set(inner.position.x - (box.min.x + box.max.x) / 2, inner.position.y - box.min.y, inner.position.z - (box.min.z + box.max.z) / 2);
    const holder = new THREE.Group();
    holder.name = `model:${object.id}`;
    holder.add(inner);
    return holder;
  };
}
