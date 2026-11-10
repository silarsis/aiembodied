import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PoseBlend } from '../../src/avatar/pose-blend';

const raised = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
const lowered = new THREE.Quaternion();

describe('PoseBlend', () => {
  it('eases from the captured rotation to what the mixer wrote, then lets go', () => {
    const arm = new THREE.Object3D();
    arm.quaternion.copy(raised);
    const blend = new PoseBlend();
    blend.capture([arm, null], 0.3);
    expect(blend.active).toBe(true);

    // The mixer drops the arm to the standing pose; the blend keeps it near the captured pose at first.
    arm.quaternion.copy(lowered);
    blend.apply(0.005);
    expect(arm.quaternion.angleTo(raised)).toBeLessThan(0.01);

    arm.quaternion.copy(lowered);
    blend.apply(0.145);
    const halfway = arm.quaternion.angleTo(lowered);
    expect(halfway).toBeGreaterThan(0.6);
    expect(halfway).toBeLessThan(1.0);

    arm.quaternion.copy(lowered);
    blend.apply(0.2);
    expect(arm.quaternion.angleTo(lowered)).toBeLessThan(1e-6);
    expect(blend.active).toBe(false);
  });

  it('does nothing once cancelled', () => {
    const arm = new THREE.Object3D();
    arm.quaternion.copy(raised);
    const blend = new PoseBlend();
    blend.capture([arm], 0.3);
    blend.cancel();
    arm.quaternion.copy(lowered);
    blend.apply(0.01);
    expect(arm.quaternion.angleTo(lowered)).toBeLessThan(1e-6);
  });
});
