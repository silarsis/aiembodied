/**
 * The loaded avatar's rest skeleton, sent with motion requests so the motion service can calibrate
 * the arm swing to this avatar's build (services/motion/src/motion_service/calibration.py).
 *
 * Positions are the normalized humanoid bones in the avatar's own scene space, in metres, Y up,
 * facing +Z with the character's left on +X (VRM 1.0 / SOMA convention; VRM 0.x is mirrored to it).
 */
import * as THREE from 'three';
import type { AvatarRestSkeleton } from './types.js';

export const REST_SKELETON_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
] as const;

interface RestSkeletonSource {
  scene: THREE.Object3D;
  meta?: { metaVersion?: string } | null;
  humanoid?: { getNormalizedBoneNode(name: string): THREE.Object3D | null | undefined } | null;
}

/**
 * Measure the rest skeleton. Call it before any pose is applied (the normalized bones must still
 * be at identity). Returns null when the avatar lacks one of the bones, such as an upperChest.
 */
export function measureRestSkeleton(vrm: RestSkeletonSource): AvatarRestSkeleton | null {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return null;
  }
  vrm.scene.updateWorldMatrix(true, true);
  const mirror = vrm.meta?.metaVersion === '0';
  const skeleton: Partial<AvatarRestSkeleton> = {};
  for (const bone of REST_SKELETON_BONES) {
    const node = humanoid.getNormalizedBoneNode(bone);
    if (!node) {
      return null;
    }
    const p = vrm.scene.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
    skeleton[bone] = [round(mirror ? -p.x : p.x), round(p.y), round(mirror ? -p.z : p.z)];
  }
  return skeleton as AvatarRestSkeleton;
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

let current: AvatarRestSkeleton | null = null;

/** The skeleton of the avatar on screen, or null before one loads (or when it could not be measured). */
export function getAvatarRestSkeleton(): AvatarRestSkeleton | null {
  return current;
}

export function setAvatarRestSkeleton(skeleton: AvatarRestSkeleton | null): void {
  current = skeleton;
}
