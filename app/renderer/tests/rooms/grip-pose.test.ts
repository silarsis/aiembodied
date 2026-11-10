import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GripPose, type Side } from '../../src/rooms/grip-pose.js';

/** A rig-less hand: a wrist with finger chains lying along +X (left) or -X (right), palm facing down. */
function buildHand(side: Side) {
  const sign = side === 'left' ? 1 : -1;
  const bones = new Map<string, THREE.Object3D>();
  const root = new THREE.Group();
  const hand = new THREE.Object3D();
  root.add(hand);
  const spread = { Index: 0.03, Middle: 0.01, Ring: -0.01, Little: -0.03 } as const;
  const tips = new Map<string, THREE.Object3D>();
  for (const finger of ['Index', 'Middle', 'Ring', 'Little'] as const) {
    let parent: THREE.Object3D = hand;
    ['Proximal', 'Intermediate', 'Distal'].forEach((joint, i) => {
      const bone = new THREE.Object3D();
      bone.position.set(sign * (i === 0 ? 0.08 : 0.03), 0, i === 0 ? spread[finger] : 0);
      parent.add(bone);
      bones.set(`${side}${finger}${joint}`, bone);
      parent = bone;
    });
    const tip = new THREE.Object3D();
    tip.position.set(sign * 0.025, 0, 0);
    parent.add(tip);
    tips.set(finger, tip);
  }
  let parent: THREE.Object3D = hand;
  ['Metacarpal', 'Proximal', 'Distal'].forEach((joint, i) => {
    const bone = new THREE.Object3D();
    bone.position.set(sign * 0.02, 0, i === 0 ? 0.03 : 0.02);
    parent.add(bone);
    bones.set(`${side}Thumb${joint}`, bone);
    parent = bone;
  });
  const thumbTip = new THREE.Object3D();
  thumbTip.position.set(sign * 0.01, 0, 0.02);
  parent.add(thumbTip);
  tips.set('Thumb', thumbTip);
  root.updateWorldMatrix(true, true);
  return { root, bones, tips, humanoid: { getNormalizedBoneNode: (name: string) => bones.get(name) ?? null } };
}

function tipHeights(rig: ReturnType<typeof buildHand>): number[] {
  rig.root.updateWorldMatrix(true, true);
  return [...rig.tips.values()].map((tip) => tip.getWorldPosition(new THREE.Vector3()).y);
}

describe('GripPose', () => {
  for (const side of ['left', 'right'] as const) {
    it(`curls the ${side} hand's fingers towards the palm and opens again`, () => {
      const rig = buildHand(side);
      const before = tipHeights(rig);
      const grip = new GripPose(rig.humanoid, side);
      expect(grip.available).toBe(true);
      grip.setGripped(true);
      for (let i = 0; i < 20; i += 1) grip.update(0.05);
      expect(grip.currentWeight).toBe(1);
      const closed = tipHeights(rig);
      for (let i = 0; i < closed.length; i += 1) expect(closed[i]!).toBeLessThan(before[i]! - 0.01);

      grip.setGripped(false);
      for (let i = 0; i < 20; i += 1) grip.update(0.05);
      expect(grip.active).toBe(false);
      const open = tipHeights(rig);
      open.forEach((height, i) => expect(height).toBeCloseTo(before[i]!, 9));
      for (const bone of rig.bones.values()) expect(bone.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    });
  }

  it('eases in over a quarter of a second and curls the knuckle about 55 degrees', () => {
    const rig = buildHand('right');
    const grip = new GripPose(rig.humanoid, 'right');
    grip.setGripped(true);
    grip.update(0.125);
    expect(grip.currentWeight).toBeCloseTo(0.5, 6);
    grip.update(1);
    expect(rig.bones.get('rightIndexProximal')!.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo((55 * Math.PI) / 180, 6);
    expect(rig.bones.get('rightThumbProximal')!.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo((25 * Math.PI) / 180, 6);
  });

  it('is a harmless no-op for an avatar without finger bones', () => {
    const grip = new GripPose({ getNormalizedBoneNode: () => null }, 'left');
    expect(grip.available).toBe(false);
    grip.setGripped(true);
    expect(() => grip.update(0.1)).not.toThrow();
  });
});
