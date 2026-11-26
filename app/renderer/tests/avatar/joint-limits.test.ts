import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { JointLimits } from '../../src/avatar/joint-limits';

const DEG = Math.PI / 180;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function rig(names: string[], vrm0 = false): {
  limits: JointLimits;
  bones: Map<string, THREE.Object3D>;
  bone: (name: string) => THREE.Object3D;
} {
  const bones = new Map(names.map((name) => [name, new THREE.Object3D()]));
  const bone = (name: string): THREE.Object3D => {
    const found = bones.get(name);
    if (!found) throw new Error(`no bone ${name}`);
    return found;
  };
  return {
    limits: new JointLimits({ getNormalizedBoneNode: (name) => bones.get(name) }, vrm0),
    bones,
    bone,
  };
}

function turn(bone: THREE.Object3D, axis: THREE.Vector3, degrees: number): void {
  bone.quaternion.setFromAxisAngle(axis, degrees * DEG);
}

/** Signed angle of the bone's rotation about one axis (for rotations that are a pure turn about it). */
function angleAbout(bone: THREE.Object3D, axis: THREE.Vector3): number {
  const { x, y, z, w } = bone.quaternion;
  const sign = w < 0 ? -1 : 1;
  return (2 * Math.atan2(sign * (x * axis.x + y * axis.y + z * axis.z), Math.abs(w))) / DEG;
}

describe('JointLimits', () => {
  it('clamps a head yawed past its twist limit, on the side it came from', () => {
    const { limits, bone } = rig(['head']);
    const head = bone('head');
    turn(head, Y_AXIS, 170);
    limits.apply();
    expect(angleAbout(head, Y_AXIS)).toBeCloseTo(40, 4);
    const second = rig(['head']);
    const other = second.bone('head');
    turn(other, Y_AXIS, -170);
    second.limits.apply();
    expect(angleAbout(other, Y_AXIS)).toBeCloseTo(-40, 4);
  });

  it('keeps clamping to the same side while the twist flips between +179 and -179 degrees', () => {
    const { limits, bone } = rig(['head']);
    const head = bone('head');
    for (const degrees of [179, -179, 179, -179]) {
      limits.restore();
      turn(head, Y_AXIS, degrees);
      limits.apply();
      expect(angleAbout(head, Y_AXIS)).toBeCloseTo(40, 4);
    }
  });

  it('leaves a pose inside the limits untouched', () => {
    const { limits, bone } = rig(['head']);
    const head = bone('head');
    turn(head, Y_AXIS, 30);
    const before = head.quaternion.clone();
    limits.apply();
    expect(head.quaternion.toArray()).toEqual(before.toArray());
  });

  it('stops a knee bending backwards but allows it bending forward', () => {
    const { limits, bone } = rig(['leftLowerLeg']);
    const knee = bone('leftLowerLeg');
    turn(knee, X_AXIS, -45);
    limits.apply();
    expect(angleAbout(knee, X_AXIS)).toBeCloseTo(-10, 4);

    limits.restore();
    turn(knee, X_AXIS, 120);
    const before = knee.quaternion.clone();
    limits.apply();
    expect(knee.quaternion.toArray()).toEqual(before.toArray());
  });

  it('clamps pitch and roll on the neck independently', () => {
    const { limits, bone } = rig(['neck']);
    const neck = bone('neck');
    // Roll is inside its 30 degrees; pitch is 70 degrees against a 40 degree limit.
    neck.quaternion
      .setFromAxisAngle(Z_AXIS, 20 * DEG)
      .multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, 70 * DEG));
    limits.apply();
    const swing = new THREE.Vector3(0, 0, 1).applyQuaternion(neck.quaternion);
    const reference = new THREE.Quaternion()
      .setFromAxisAngle(Z_AXIS, 20 * DEG)
      .multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, 40 * DEG));
    expect(neck.quaternion.angleTo(reference)).toBeLessThan(0.15);
    expect(swing.y).toBeLessThan(Math.sin(45 * DEG));
  });

  it('restores the pre-clamp value, but not over a bone something else rewrote', () => {
    const { limits, bone } = rig(['head']);
    const head = bone('head');
    turn(head, Y_AXIS, 170);
    const original = head.quaternion.clone();
    limits.apply();
    expect(head.quaternion.equals(original)).toBe(false);
    limits.restore();
    expect(head.quaternion.toArray()).toEqual(original.toArray());

    limits.apply();
    turn(head, Y_AXIS, 10);
    const rewritten = head.quaternion.clone();
    limits.restore();
    expect(head.quaternion.toArray()).toEqual(rewritten.toArray());
  });

  it('lets a seated leg bend in both VRM bases and stops a backwards knee in both', () => {
    for (const vrm0 of [false, true]) {
      // VRM 0 normalized bones face -Z, so flexion about X has the opposite sign.
      const flex = vrm0 ? -1 : 1;
      const { limits, bone } = rig(['leftUpperLeg', 'leftLowerLeg'], vrm0);
      turn(bone('leftUpperLeg'), X_AXIS, -90 * flex);
      turn(bone('leftLowerLeg'), X_AXIS, 100 * flex);
      limits.apply();
      expect(angleAbout(bone('leftUpperLeg'), X_AXIS)).toBeCloseTo(-90 * flex, 4);
      expect(angleAbout(bone('leftLowerLeg'), X_AXIS)).toBeCloseTo(100 * flex, 4);
      turn(bone('leftLowerLeg'), X_AXIS, -45 * flex);
      limits.apply();
      expect(angleAbout(bone('leftLowerLeg'), X_AXIS)).toBeCloseTo(-10 * flex, 4);
    }
  });

  describe('built-in base poses', () => {
    const directory = resolve(import.meta.dirname, '../../../main/src/shared/avatar/base-poses');
    const files = readdirSync(directory).filter((file) => file.endsWith('.pose.json'));

    it('finds the poses', () => {
      expect(files.length).toBeGreaterThanOrEqual(7);
    });

    for (const file of files) {
      for (const form of ['VRM 0', 'VRM 1']) {
        it(`${file} (${form}) is inside the limits`, () => {
          const pose = JSON.parse(readFileSync(resolve(directory, file), 'utf8')) as {
            bones: Record<string, { rotation: [number, number, number, number] }>;
          };
          const vrm0 = form === 'VRM 0';
          const { limits, bones } = rig(Object.keys(pose.bones), vrm0);
          for (const [name, data] of Object.entries(pose.bones)) {
            const [x, y, z, w] = data.rotation;
            if (vrm0) bones.get(name)?.quaternion.set(x, y, z, w);
            else bones.get(name)?.quaternion.set(-x, y, -z, w);
          }
          const before = new Map([...bones].map(([name, bone]) => [name, bone.quaternion.clone()]));
          limits.apply();
          for (const [name, bone] of bones) {
            expect(
              bone.quaternion.angleTo(before.get(name) ?? new THREE.Quaternion()),
              name,
            ).toBeLessThan(1e-6);
          }
        });
      }
    }
  });
});
