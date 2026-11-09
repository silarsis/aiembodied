import { describe, expect, it } from 'vitest';
import {
  bakedRootPose,
  heightToMotion,
  motionPointToWorld,
  motionToWorld,
  motionYawToWorld,
  worldToMotion,
  worldYawToMotion,
  wrapRadians,
  yawToward,
  type MotionFrame,
} from '../../src/rooms/scene-frames.js';

const frame: MotionFrame = { origin: { x: 1, z: -2, yaw: Math.PI / 2 }, scale: 1.25 };

describe('motion frames', () => {
  it('puts the origin at (0, 0) and the facing direction on +Z', () => {
    expect(worldToMotion(frame, 1, -2)).toEqual([0, 0]);
    // yaw pi/2 faces +X in the world: one avatar metre ahead is 1.25 world metres along +X.
    const [mx, mz] = worldToMotion(frame, 1 + 1.25, -2);
    expect(mx).toBeCloseTo(0, 9);
    expect(mz).toBeCloseTo(1, 9);
  });

  it('maps world +X to motion +X (left of the character) when facing +Z', () => {
    const [mx, mz] = worldToMotion({ origin: { x: 0, z: 0, yaw: 0 }, scale: 1 }, 1, 0);
    expect([mx, mz]).toEqual([1, 0]);
  });

  it('round-trips points, headings and heights', () => {
    for (const [x, z] of [[0, 0], [3.2, -1.1], [-4, 5]] as const) {
      const [mx, mz] = worldToMotion(frame, x, z);
      const [bx, bz] = motionToWorld(frame, mx, mz);
      expect(bx).toBeCloseTo(x, 9);
      expect(bz).toBeCloseTo(z, 9);
    }
    expect(motionYawToWorld(frame, worldYawToMotion(frame, 2.8))).toBeCloseTo(2.8, 9);
    expect(heightToMotion(frame, 1.25)).toBe(1);
    const p = motionPointToWorld(frame, [0.2, 0.8, 0.5]);
    const [mx, mz] = worldToMotion(frame, p[0], p[2]);
    expect([mx, p[1] / frame.scale, mz].map((v) => Number(v.toFixed(9)))).toEqual([0.2, 0.8, 0.5]);
  });

  it('wraps angles into (-pi, pi]', () => {
    expect(wrapRadians(3 * Math.PI)).toBeCloseTo(-Math.PI, 9);
    expect(wrapRadians(-2.5 * Math.PI)).toBeCloseTo(-Math.PI / 2, 9);
    expect(worldYawToMotion({ origin: { x: 0, z: 0, yaw: 3 }, scale: 1 }, -3)).toBeCloseTo(2 * Math.PI - 6, 9);
  });

  it('measures yaw as atan2(dx, dz)', () => {
    expect(yawToward([0, 0, 0], [0, 0, 2])).toBe(0);
    expect(yawToward([0, 0, 0], [2, 0, 0])).toBeCloseTo(Math.PI / 2, 9);
    expect(Math.abs(yawToward([0, 0, 0], [0, 0, -1]))).toBeCloseTo(Math.PI, 9);
  });

  it('bakes the last pelvis position and heading back into the world', () => {
    // Two avatar metres ahead, turned 90 degrees to the left of the start heading.
    const baked = bakedRootPose(frame, { root: [0, 2], heading: Math.PI / 2 });
    expect(baked.x).toBeCloseTo(1 + 2.5, 9);
    expect(baked.z).toBeCloseTo(-2, 9);
    expect(Math.abs(baked.yaw)).toBeCloseTo(Math.PI, 9);
    // No movement bakes to the start pose.
    const same = bakedRootPose(frame, { root: [0, 0], heading: 0 });
    expect(same).toEqual({ x: 1, z: -2, yaw: Math.PI / 2 });
  });
});
