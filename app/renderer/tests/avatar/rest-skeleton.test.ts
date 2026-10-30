import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  REST_SKELETON_BONES,
  getAvatarRestSkeleton,
  measureRestSkeleton,
  setAvatarRestSkeleton,
} from '../../src/avatar/rest-skeleton.js';

/** A flat fake humanoid: one node per bone, at its rest position in the scene. */
function fakeVrm(positions: Record<string, [number, number, number]>, metaVersion = '1') {
  const scene = new THREE.Group();
  const nodes = new Map<string, THREE.Object3D>();
  for (const [bone, p] of Object.entries(positions)) {
    const node = new THREE.Object3D();
    node.position.set(...p);
    scene.add(node);
    nodes.set(bone, node);
  }
  return { scene, meta: { metaVersion }, humanoid: { getNormalizedBoneNode: (name: string) => nodes.get(name) ?? null } };
}

const positions = Object.fromEntries(
  REST_SKELETON_BONES.map((bone, i) => [bone, [bone.startsWith('left') ? 0.1 : -0.1, Number((0.9 + i * 0.01).toFixed(2)), -0.02]]),
) as Record<string, [number, number, number]>;

describe('measureRestSkeleton', () => {
  it('reads every bone in scene space, ignoring how the scene is placed', () => {
    const vrm = fakeVrm(positions);
    vrm.scene.rotation.y = Math.PI;
    vrm.scene.position.set(3, 0, -2);
    vrm.scene.scale.setScalar(2);

    const skeleton = measureRestSkeleton(vrm);

    expect(skeleton?.leftUpperArm).toEqual(positions.leftUpperArm);
    expect(Object.keys(skeleton ?? {})).toEqual([...REST_SKELETON_BONES]);
  });

  it('mirrors VRM 0.x avatars to face +Z with the left on +X', () => {
    const skeleton = measureRestSkeleton(fakeVrm(positions, '0'));
    const [x, y, z] = positions.leftHand;
    expect(skeleton?.leftHand).toEqual([-x, y, -z]);
  });

  it('gives up when a bone is missing', () => {
    const { upperChest: _missing, ...rest } = positions;
    expect(measureRestSkeleton(fakeVrm(rest))).toBeNull();
  });

  it('holds the skeleton of the avatar on screen', () => {
    const skeleton = measureRestSkeleton(fakeVrm(positions));
    setAvatarRestSkeleton(skeleton);
    expect(getAvatarRestSkeleton()).toBe(skeleton);
    setAvatarRestSkeleton(null);
    expect(getAvatarRestSkeleton()).toBeNull();
  });
});
