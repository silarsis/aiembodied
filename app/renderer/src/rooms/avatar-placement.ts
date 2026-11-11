import * as THREE from 'three';
import { DEFAULT_IDLE_SETTINGS } from '../../../main/src/rooms/idle-settings.js';
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

/** Default gap between neighbours standing beside the home point, in metres. */
export const COMPANION_SPACING = 0.8;

/**
 * Where companion `index` (0-based) stands: beside the home point, alternating to the right (0, 2, 4...)
 * and left (1, 3, 5...) of the facing direction, each pair one `spacing` further out. They face the same
 * way as the home point. Facing is in degrees (0 = +Z); the right-hand side of facing `a` is (-cos a, 0, sin a).
 */
export function companionHome(
  home: { position: Vec3; facing: number },
  index: number,
  spacing: number = COMPANION_SPACING,
): { position: Vec3; facing: number } {
  const angle = (home.facing * Math.PI) / 180;
  const offset = (Math.floor(index / 2) + 1) * spacing * (index % 2 === 0 ? 1 : -1);
  return {
    position: [home.position[0] - Math.cos(angle) * offset, home.position[1], home.position[2] + Math.sin(angle) * offset],
    facing: home.facing,
  };
}

/** How tall the avatar stands in a room by default, in metres, sole to crown. */
export const DEFAULT_ROOM_AVATAR_HEIGHT = DEFAULT_IDLE_SETTINGS.avatarHeight;

/** Sole-to-crown height of the visible meshes at rest, in world metres; 0 if nothing is visible. */
export function measureAvatarHeight(root: THREE.Object3D): number {
  const box = visibleBounds(root);
  return box ? box.max.y - box.min.y : 0;
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
  const box = visibleBounds(root);
  if (!box) return 0;
  return Math.min(MAX_SOLE_LIFT, Math.max(0, -box.min.y));
}

function visibleBounds(root: THREE.Object3D): THREE.Box3 | null {
  root.updateWorldMatrix(true, true);
  const total = new THREE.Box3();
  const box = new THREE.Box3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true || !mesh.geometry || !isVisible(mesh, root)) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    if (!box.isEmpty()) total.union(box);
  });
  return total.isEmpty() ? null : total;
}

function isVisible(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === root) break;
  }
  return true;
}
