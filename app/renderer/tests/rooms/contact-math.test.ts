import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  HIP_FLEXION_MAX_OFFSET,
  HIP_MAX_OFFSET,
  capDirectional,
  headExcessCorrection,
  clampCone,
  clampHinge,
  easeTowards,
  hingeAngle,
  projectToHinge,
  rotationAngle,
  smallestRotation,
  solveTwoBone,
  stepSpring,
  type Spring,
} from '../../src/rooms/contact-math.js';

const X = new THREE.Vector3(1, 0, 0);
const deg = (d: number) => (d * Math.PI) / 180;

describe('smallestRotation', () => {
  it('turns a downward segment so its end moves up by the depth', () => {
    const dir = new THREE.Vector3(0, -1, 0);
    const normal = new THREE.Vector3(0, 0, 1);
    const q = new THREE.Quaternion();
    const angle = smallestRotation(dir, normal, 0.05, 0.4, q);
    expect(angle).toBeCloseTo(Math.atan2(0.05, 0.4), 9);
    const moved = new THREE.Vector3(0, -0.4, 0).applyQuaternion(q);
    expect(moved.z).toBeGreaterThan(0.04);
    expect(moved.y).toBeGreaterThan(-0.4);
    expect(q.angleTo(new THREE.Quaternion())).toBeCloseTo(angle, 9);
  });

  it('is identity when the push is along the bone or there is nothing to do', () => {
    const q = new THREE.Quaternion(0.1, 0.2, 0.3, 0.9);
    expect(
      smallestRotation(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0), 0.05, 0.4, q),
    ).toBe(0);
    expect(q.angleTo(new THREE.Quaternion())).toBe(0);
    expect(
      smallestRotation(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), 0, 0.4, q),
    ).toBe(0);
  });
});

describe('joint limits', () => {
  it('measures the hinge angle about an axis', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(X, deg(70));
    expect(hingeAngle(q, X)).toBeCloseTo(deg(70), 9);
    expect(hingeAngle(q.clone().invert(), X)).toBeCloseTo(-deg(70), 9);
  });

  it('projects a turn onto the hinge', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(30), deg(40), 0));
    const projected = projectToHinge(q, X, new THREE.Quaternion());
    expect(hingeAngle(projected, X)).toBeCloseTo(hingeAngle(q, X), 9);
    expect(rotationAngle(projected)).toBeCloseTo(Math.abs(hingeAngle(q, X)), 9);
  });

  it('clamps flexion to the range', () => {
    const out = new THREE.Quaternion();
    clampHinge(new THREE.Quaternion().setFromAxisAngle(X, deg(170)), X, 0, deg(150), 0, out);
    expect(hingeAngle(out, X)).toBeCloseTo(deg(150), 9);
    clampHinge(new THREE.Quaternion().setFromAxisAngle(X, -deg(20)), X, 0, deg(150), 0, out);
    expect(hingeAngle(out, X)).toBeCloseTo(0, 9);
    clampHinge(new THREE.Quaternion().setFromAxisAngle(X, deg(100)), X, 0, deg(150), 0, out);
    expect(hingeAngle(out, X)).toBeCloseTo(deg(100), 9);
  });

  it('does not pull in a pose the animation already put past the limit', () => {
    const out = new THREE.Quaternion();
    const total = new THREE.Quaternion().setFromAxisAngle(X, deg(160));
    clampHinge(total, X, 0, deg(150), deg(160), out);
    expect(hingeAngle(out, X)).toBeCloseTo(deg(160), 9);
    clampHinge(new THREE.Quaternion().setFromAxisAngle(X, deg(170)), X, 0, deg(150), deg(160), out);
    expect(hingeAngle(out, X)).toBeCloseTo(deg(160), 9);
  });

  it('clamps a cone to its angle from rest', () => {
    const out = new THREE.Quaternion();
    const axis = new THREE.Vector3(1, 1, 0).normalize();
    clampCone(new THREE.Quaternion().setFromAxisAngle(axis, deg(150)), deg(120), 0, out);
    expect(rotationAngle(out)).toBeCloseTo(deg(120), 9);
    clampCone(new THREE.Quaternion().setFromAxisAngle(axis, deg(90)), deg(120), 0, out);
    expect(rotationAngle(out)).toBeCloseTo(deg(90), 9);
    clampCone(new THREE.Quaternion().setFromAxisAngle(axis, deg(150)), deg(120), deg(150), out);
    expect(rotationAngle(out)).toBeCloseTo(deg(150), 9);
  });
});

describe('solveTwoBone', () => {
  const root = new THREE.Vector3(0, 1, 0);

  it('reaches a reachable target with both segments keeping their length', () => {
    const mid = new THREE.Vector3();
    const end = new THREE.Vector3();
    const target = new THREE.Vector3(0, 0.3, 0.4);
    const reached = solveTwoBone(root, target, new THREE.Vector3(0, 0, 1), 0.45, 0.45, mid, end);
    expect(reached).toBe(true);
    expect(end.distanceTo(target)).toBeLessThan(1e-9);
    expect(mid.distanceTo(root)).toBeCloseTo(0.45, 9);
    expect(end.distanceTo(mid)).toBeCloseTo(0.45, 9);
    expect(mid.z).toBeGreaterThan(0.2); // bends towards the pole
  });

  it('stretches straight towards an unreachable target', () => {
    const mid = new THREE.Vector3();
    const end = new THREE.Vector3();
    const reached = solveTwoBone(
      root,
      new THREE.Vector3(0, -2, 0),
      new THREE.Vector3(0, 0, 1),
      0.45,
      0.45,
      mid,
      end,
    );
    expect(reached).toBe(false);
    expect(end.x).toBeCloseTo(0, 6);
    expect(end.y).toBeCloseTo(0.1, 5);
    expect(mid.y).toBeCloseTo(0.55, 5);
  });

  it('copes with a pole along the limb', () => {
    const mid = new THREE.Vector3();
    const end = new THREE.Vector3();
    solveTwoBone(
      root,
      new THREE.Vector3(0, 0.3, 0),
      new THREE.Vector3(0, -1, 0),
      0.45,
      0.45,
      mid,
      end,
    );
    expect(Number.isFinite(mid.x + mid.y + mid.z)).toBe(true);
    expect(mid.distanceTo(root)).toBeCloseTo(0.45, 6);
  });
});

describe('easing', () => {
  it('eases towards a target and snaps when close', () => {
    expect(easeTowards(0, 1, 0.05, 0.05)).toBeCloseTo(1 - Math.exp(-1), 9);
    expect(easeTowards(0.9995, 1, 0.01, 0.05, 0.002)).toBe(1);
    expect(easeTowards(0.3, 0.3, 0.1, 0.05)).toBe(0.3);
  });

  it('settles a critically damped spring in about its smooth time without overshoot', () => {
    const spring: Spring = { value: 0, velocity: 0 };
    let peak = 0;
    for (let i = 0; i < 12; i += 1) {
      stepSpring(spring, 0.05, 1 / 60, 0.12);
      peak = Math.max(peak, spring.value);
    }
    expect(spring.value).toBeGreaterThan(0.03);
    for (let i = 0; i < 120; i += 1) {
      stepSpring(spring, 0.05, 1 / 60, 0.12);
      peak = Math.max(peak, spring.value);
    }
    expect(spring.value).toBe(0.05);
    expect(peak).toBeLessThanOrEqual(0.05 + 1e-9);
  });
});

describe('clampCone', () => {
  it('shrinks a rotation in place without losing its direction', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(X, -deg(130));
    clampCone(q, deg(120), 0, q);
    expect(rotationAngle(q)).toBeCloseTo(deg(120), 6);
    expect(hingeAngle(q, X)).toBeCloseTo(-deg(120), 6);
  });
});

describe('capDirectional', () => {
  const Z = new THREE.Vector3(0, 0, 1);
  const cap = (q: THREE.Quaternion) => {
    const out = new THREE.Quaternion();
    const cut = capDirectional(q, X, HIP_FLEXION_MAX_OFFSET, HIP_MAX_OFFSET, out);
    return { out, cut };
  };

  it('lets flexion (negative about the lateral axis) reach 45 degrees and no more', () => {
    expect(cap(new THREE.Quaternion().setFromAxisAngle(X, -deg(40))).cut).toBe(false);
    const { out, cut } = cap(new THREE.Quaternion().setFromAxisAngle(X, -deg(60)));
    expect(cut).toBe(true);
    expect(hingeAngle(out, X)).toBeCloseTo(-deg(45), 6);
  });

  it('keeps 25 degrees for extension, abduction and twist', () => {
    const extension = cap(new THREE.Quaternion().setFromAxisAngle(X, deg(40)));
    expect(extension.cut).toBe(true);
    expect(hingeAngle(extension.out, X)).toBeCloseTo(deg(25), 6);
    const abduction = cap(new THREE.Quaternion().setFromAxisAngle(Z, deg(40)));
    expect(abduction.cut).toBe(true);
    expect(rotationAngle(abduction.out)).toBeCloseTo(deg(25), 6);
    const within = cap(new THREE.Quaternion().setFromAxisAngle(Z, deg(20)));
    expect(within.cut).toBe(false);
  });

  it('caps the flexion and the rest separately and may write in place', () => {
    const q = new THREE.Quaternion()
      .setFromAxisAngle(X, -deg(40))
      .multiply(new THREE.Quaternion().setFromAxisAngle(Z, deg(40)));
    expect(capDirectional(q, X, HIP_FLEXION_MAX_OFFSET, HIP_MAX_OFFSET, q)).toBe(true);
    expect(hingeAngle(q, X)).toBeLessThan(-deg(35));
    expect(rotationAngle(q)).toBeGreaterThan(deg(40));
  });
});

describe('headExcessCorrection', () => {
  const limits = [deg(35), deg(25), deg(15)] as const;
  const yawOf = (q: THREE.Quaternion) =>
    (new THREE.Euler().setFromQuaternion(q, 'YXZ').y * 180) / Math.PI;

  it('takes only the excess off a 58 degree yaw', () => {
    const head = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, deg(58), 0, 'YXZ'));
    const out = new THREE.Quaternion();
    expect(headExcessCorrection(head, ...limits, out)).toBe(true);
    expect(yawOf(out.multiply(head))).toBeCloseTo(35, 6);
  });

  it('leaves a 20 degree yaw alone', () => {
    const head = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, deg(20), 0, 'YXZ'));
    const out = new THREE.Quaternion(1, 2, 3, 4);
    expect(headExcessCorrection(head, ...limits, out)).toBe(false);
    expect(out.equals(new THREE.Quaternion())).toBe(true);
  });
});
