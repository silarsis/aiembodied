import * as THREE from 'three';
import type { Vec3 } from '../../../main/src/rooms/types.js';

export interface AvatarBaseTransform {
  position: Vec3;
  rotationY: number;
}

/**
 * The normalised avatar's scene origin is offset from its body centre (the model is shifted so
 * the body sits on the world origin). Putting the body at `home` and turning it to `facing`
 * therefore rotates that offset too: position = home + Ry(facing) * basePosition.
 * Facing is in degrees (0 = +Z, direction (sin, 0, cos)); rotationY is in radians.
 */
export function placeAtHome(base: AvatarBaseTransform, home: { position: Vec3; facing: number }): AvatarBaseTransform {
  const angle = (home.facing * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const [bx, by, bz] = base.position;
  return {
    position: [home.position[0] + bx * cos + bz * sin, home.position[1] + by, home.position[2] - bx * sin + bz * cos],
    rotationY: base.rotationY + angle,
  };
}

/** Most a rest-pose sole may sit below the scene's ground line before it is treated as stray geometry. */
export const MAX_SOLE_LIFT = 0.2;

/**
 * How far to raise the avatar so its soles rest on the room floor. The avatar is normalised with
 * its ankle (foot bone) on y = 0, which suits the 2D stage (that aligns the rendered silhouette to
 * the backdrop) but leaves the soles under a 3D floor by the ankle height. Measured from the visible
 * meshes' rest bounds in world space; clamped to [0, MAX_SOLE_LIFT] so stray geometry can't fling it.
 */
export function measureSoleLift(root: THREE.Object3D): number {
  root.updateWorldMatrix(true, true);
  let minY = Infinity;
  const box = new THREE.Box3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true || !mesh.geometry || !isVisible(mesh, root)) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    if (!box.isEmpty()) minY = Math.min(minY, box.min.y);
  });
  if (!Number.isFinite(minY)) return 0;
  return Math.min(MAX_SOLE_LIFT, Math.max(0, -minY));
}

function isVisible(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === root) break;
  }
  return true;
}
