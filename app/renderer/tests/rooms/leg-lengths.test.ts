import { describe, expect, it } from 'vitest';
import { measureRestLegLengths, type LegBones } from '../../src/rooms/leg-lengths.js';

function bones(offsets: Record<string, [number, number, number]>): LegBones {
  return {
    getNormalizedBoneNode: (name) => {
      const o = offsets[name];
      return o ? { position: { x: o[0], y: o[1], z: o[2] } } : null;
    },
  };
}

describe('measureRestLegLengths', () => {
  it('measures thigh and shin from the bone offsets and the ankle height from what is left of the hips height', () => {
    const legs = measureRestLegLengths(
      bones({ leftUpperLeg: [0.08, -0.05, 0], leftLowerLeg: [0, -0.42, 0], leftFoot: [0, -0.41, 0] }),
      0.95,
    );
    expect(legs?.thigh).toBeCloseTo(0.42, 6);
    expect(legs?.shin).toBeCloseTo(0.41, 6);
    expect(legs?.ankleHeight).toBeCloseTo(0.95 - 0.05 - 0.42 - 0.41, 6);
  });

  it('clamps the ankle height and gives null for missing or nonsense bones', () => {
    const tall = measureRestLegLengths(bones({ leftUpperLeg: [0, 0, 0], leftLowerLeg: [0, -0.3, 0], leftFoot: [0, -0.3, 0] }), 1.2);
    expect(tall?.ankleHeight).toBe(0.15);
    expect(measureRestLegLengths(bones({ leftUpperLeg: [0, 0, 0] }), 0.95)).toBeNull();
    expect(measureRestLegLengths(bones({ leftUpperLeg: [0, 0, 0], leftLowerLeg: [0, 0, 0], leftFoot: [0, 0, 0] }), 0.95)).toBeNull();
  });
});
