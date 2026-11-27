import { describe, expect, it } from 'vitest';
import { FrameMeasurer, restSelfOverlaps, type Capsule } from '../../src/sit-lab/measure.js';
import type { Vec3 } from '../../src/sit-lab/pose-math.js';
import { buildStubRig, SOFA } from './helpers.js';

function measurerWithRest(rest: readonly Capsule[]): FrameMeasurer {
  return new FrameMeasurer(
    buildStubRig(),
    SOFA,
    { colliders: null, surfaceAt: () => SOFA.surfaceY },
    null,
    restSelfOverlaps(rest),
  );
}

function capsule(name: string, from: Vec3, to: Vec3, radius: number): Capsule {
  return { name, p0: from, p1: to, radius };
}

/** Thighs 0.1 m apart (axes), radius 0.075: they overlap by 0.05 even at rest. */
function body(over: { rightThighX?: number; handAt?: Vec3 } = {}): Capsule[] {
  return [
    capsule('leftThigh', [0.05, 0.5, 0], [0.05, 0.5, 0.4], 0.075),
    capsule(
      'rightThigh',
      [over.rightThighX ?? -0.05, 0.5, 0],
      [over.rightThighX ?? -0.05, 0.5, 0.4],
      0.075,
    ),
    capsule('pelvis', [0, 0.6, 0], [0, 0.8, 0], 0.1),
    capsule('leftHand', over.handAt ?? [0.6, 1, 0], over.handAt ?? [0.6, 1, 0.05], 0.035),
  ];
}

describe('self penetration', () => {
  it('ignores the overlap a pair already has at rest, and counts only the excess', () => {
    const measurer = measurerWithRest(body());
    expect(measurer.selfPenetration(body())).toEqual({ depth: 0, pair: null });
    const squeezed = measurer.selfPenetration(body({ rightThighX: -0.02 }));
    expect(squeezed.pair).toBe('leftThigh/rightThigh');
    expect(squeezed.depth).toBeCloseTo(0.03, 5);
  });

  it('lets a hand rest on the thigh and counts it once the hand is inside', () => {
    const measurer = measurerWithRest(body());
    // Hand axis 0.10 m from the thigh axis: the capsules overlap by 0.01 but the axis is outside the thigh.
    const resting = measurer.selfPenetration(body({ handAt: [0.15, 0.5, 0.2] }));
    expect(resting.depth).toBe(0);
    // Axis 0.03 m from the thigh axis: inside the thigh by 0.045.
    const inside = measurer.selfPenetration(body({ handAt: [0.08, 0.5, 0.2] }));
    expect(inside.pair).toBe('leftHand/leftThigh');
    expect(inside.depth).toBeCloseTo(0.045, 5);
  });

  it('names the worst pair', () => {
    const rightHand = (at: Vec3) => capsule('rightHand', at, [at[0], at[1], at[2] + 0.05], 0.035);
    const measurer = measurerWithRest([...body(), rightHand([1, 1, 1])]);
    // The right hand's axis is inside the pelvis (0.135 - 0 - 0.035 = 0.1); the thighs are 0.01 over their rest overlap.
    const result = measurer.selfPenetration([
      ...body({ rightThighX: -0.04 }),
      rightHand([0, 0.7, 0]),
    ]);
    expect(result.pair).toBe('rightHand/pelvis');
    expect(result.depth).toBeCloseTo(0.1, 5);
  });
});
