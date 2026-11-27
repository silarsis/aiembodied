import { describe, expect, it } from 'vitest';
import {
  quatAngleDeg,
  quatAngleIgnoringYawDeg,
  quatMultiply,
  segmentDistance,
  smoothstep,
  swingTwist,
} from '../../src/sit-lab/pose-math.js';
import { axisAngle } from './helpers.js';

describe('pose maths', () => {
  it('measures the angle between rotations the short way round', () => {
    const a = axisAngle([1, 0, 0], 30);
    const b = axisAngle([1, 0, 0], 80);
    expect(quatAngleDeg(a, b)).toBeCloseTo(50, 6);
    expect(quatAngleDeg(a, [-a[0], -a[1], -a[2], -a[3]])).toBeCloseTo(0, 6);
  });

  it('ignores a turn about the vertical axis for the hips but not a tilt', () => {
    const yaw = axisAngle([0, 1, 0], 40);
    const tilt = axisAngle([1, 0, 0], 10);
    const tilted = quatMultiply(yaw, tilt);
    expect(quatAngleIgnoringYawDeg([0, 0, 0, 1], yaw)).toBeCloseTo(0, 6);
    expect(quatAngleIgnoringYawDeg(tilt, tilted)).toBeCloseTo(0, 6);
    expect(quatAngleIgnoringYawDeg([0, 0, 0, 1], tilted)).toBeCloseTo(10, 4);
  });

  it('splits a knee-like rotation into twist and sideways swing', () => {
    const flexion = axisAngle([1, 0, 0], 70);
    const twist = axisAngle([0, 1, 0], 20);
    // A swing axis in the plane perpendicular to the twist axis, tilted off the pure bending axis.
    const swing = axisAngle([0.8, 0, 0.6], 70);
    const split = swingTwist(quatMultiply(swing, twist), 1);
    expect(split.twistDeg).toBeCloseTo(20, 3);
    expect(Math.abs(split.swing[2]) * (180 / Math.PI)).toBeCloseTo(42, 3);
    const flexOnly = swingTwist(flexion, 1);
    expect(flexOnly.twistDeg).toBeCloseTo(0, 6);
    expect(Math.abs(flexOnly.swing[2])).toBeLessThan(1e-9);
  });

  it('finds the distance between two segments', () => {
    expect(segmentDistance([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0])).toBeCloseTo(1, 9);
    expect(segmentDistance([0, 0, 0], [1, 0, 0], [0.5, -1, 1], [0.5, 1, 1])).toBeCloseTo(1, 9);
    expect(segmentDistance([0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0])).toBeCloseTo(1, 9);
    expect(segmentDistance([0, 0, 0], [0, 0, 0], [3, 4, 0], [3, 4, 0])).toBeCloseTo(5, 9);
  });

  it('eases between 0 and 1', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 9);
  });
});
