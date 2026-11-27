import { describe, expect, it } from 'vitest';
import type { FrameMeasure } from '../../src/sit-lab/measure.js';
import { computeMetrics, hingeExcessDeg, type MetricsInput } from '../../src/sit-lab/metrics.js';
import { quatMultiply } from '../../src/sit-lab/pose-math.js';
import type { Pose } from '../../src/sit-lab/types.js';
import { axisAngle } from './helpers.js';

function measure(over: Partial<FrameMeasure> = {}): FrameMeasure {
  return {
    furniturePen: 0,
    selfPen: 0,
    seatGap: 0,
    hips: [0, 0.5, 0],
    pelvisToSit: 0.02,
    sole: [0, 0],
    ankleAlong: [0.5, 0.5],
    feet: [
      [0.1, 0.08, 0.5],
      [-0.1, 0.08, 0.5],
    ],
    ...over,
  };
}

function pose(bones: Pose['bones'] = {}): Pose {
  return { bones: { hips: [0, 0, 0, 1], ...bones }, hips: [0, 1, 0] };
}

function input(over: Partial<MetricsInput> = {}): MetricsInput {
  const frames = 10;
  return {
    fps: 30,
    measures: Array.from({ length: frames }, () => measure()),
    raw: Array.from({ length: frames }, () => pose()),
    final: Array.from({ length: frames }, () => pose()),
    rawHips: Array.from({ length: frames }, () => [0, 0.5, 0]),
    translation: Array.from({ length: frames }, () => 0),
    sitStartFrame: 2,
    motionEndFrame: 6,
    frontEdge: 0.38,
    extraModelCalls: 0,
    computeMs: 0,
    ...over,
  };
}

describe('trial metrics', () => {
  it('passes a clean, unchanged sit', () => {
    const metrics = computeMetrics(input());
    expect(metrics.pass).toBe(true);
    expect(metrics.failures).toEqual([]);
    expect(metrics.shapeChangeMeanDeg).toBe(0);
    expect(metrics.settleTimeS).toBe(0);
  });

  it('names each failed criterion', () => {
    const measures = Array.from({ length: 10 }, () =>
      measure({
        furniturePen: 0.03,
        selfPen: 0.02,
        seatGap: -0.05,
        pelvisToSit: 0.2,
        sole: [0.1, 0],
        ankleAlong: [0.2, 0.5],
      }),
    );
    const { failures, pass } = computeMetrics(input({ measures }));
    expect(pass).toBe(false);
    expect(failures).toEqual([
      'furnitureMaxPenetrationEnd',
      'selfPenetrationMax',
      'seatGap',
      'pelvisToSitPoint',
      'footFloorError',
      'feetInFrontOfSeat',
    ]);
  });

  it('counts descent penetration separately from the end', () => {
    const measures = Array.from({ length: 10 }, (_, i) =>
      measure({ furniturePen: i === 4 ? 0.06 : 0 }),
    );
    const metrics = computeMetrics(input({ measures }));
    expect(metrics.furnitureMaxPenetrationDescent).toBeCloseTo(0.06, 9);
    expect(metrics.furnitureMaxPenetrationEnd).toBe(0);
  });

  it('measures shape change as the turn from the raw pose, ignoring hips yaw', () => {
    const turned = pose({ spine: axisAngle([1, 0, 0], 30) });
    const yawed = pose({ hips: axisAngle([0, 1, 0], 50) });
    const raw = Array.from({ length: 10 }, () => pose({ spine: [0, 0, 0, 1] }));
    const bent = computeMetrics(input({ raw, final: Array.from({ length: 10 }, () => turned) }));
    expect(bent.shapeChangeMaxDeg).toBeCloseTo(30, 4);
    expect(bent.shapeChangeMeanDeg).toBeGreaterThan(0);
    const yaw = computeMetrics(input({ raw, final: Array.from({ length: 10 }, () => yawed) }));
    expect(yaw.shapeChangeMaxDeg).toBeCloseTo(0, 4);
  });

  it('flags hinge joints past the tight limits only', () => {
    const fine = axisAngle([1, 0, 0], 90);
    expect(hingeExcessDeg(pose({ leftLowerLeg: fine }))).toBeLessThanOrEqual(0);
    const knee = quatMultiply(axisAngle([1, 0, 0], 80), axisAngle([0, 1, 0], 50));
    expect(hingeExcessDeg(pose({ leftLowerLeg: knee }))).toBeGreaterThan(10);
    const broken = computeMetrics(
      input({ final: Array.from({ length: 10 }, () => pose({ leftLowerLeg: knee })) }),
    );
    expect(broken.hingeBreaks.count).toBe(1);
    expect(broken.failures).toContain('hingeBreaks');
  });

  it('reports the time the body takes to go still after the motion', () => {
    const final = Array.from({ length: 10 }, (_, i) =>
      pose({ spine: axisAngle([1, 0, 0], i < 8 ? i * 5 : 40) }),
    );
    const metrics = computeMetrics(input({ final }));
    expect(metrics.settleTimeS).toBeCloseTo(2 / 30, 6);
  });

  it('sums foot slide while a foot stays planted during the descent', () => {
    const measures = Array.from({ length: 10 }, (_, i) =>
      measure({
        feet: [
          [0.1 + 0.01 * i, 0.08, 0.5],
          [-0.1, 0.08, 0.5],
        ],
      }),
    );
    const metrics = computeMetrics(input({ measures }));
    expect(metrics.footSlideDescent).toBeCloseTo(0.04, 9);
  });

  it('rejects mismatched frame counts', () => {
    expect(() => computeMetrics(input({ final: [pose()] }))).toThrow(/one measure/);
  });
});
