import { describe, expect, it } from 'vitest';
import type { StreamRequestPlan } from '../../src/rooms/scene-actions.js';
import { describeMethods, findMethod } from '../../src/sit-lab/methods/index.js';
import { resolveParams } from '../../src/sit-lab/methods/types.js';
import { buildStubRig, contextFor, holdMotion, seatedPose, sofaPhysics, SOFA } from './helpers.js';

describe('method parameters', () => {
  it('lists the ten methods with documented, in-range defaults', () => {
    const methods = describeMethods();
    expect(methods.map((m) => m.id)).toEqual([
      'baseline',
      'rigidTranslate',
      'translateYaw',
      'closedLoop',
      'wholeBodyTargets',
      'hipsOnlyIK',
      'poseOptimise',
      'bestOfN',
      'landThenSettle',
      'combo',
    ]);
    for (const method of methods) {
      for (const spec of method.params) {
        expect(spec.doc.length).toBeGreaterThan(5);
        expect(() => resolveParams(method.params, {}, method.id)).not.toThrow();
      }
    }
  });

  it('rejects unknown names and out-of-range values', () => {
    const { params } = findMethod('hipsOnlyIK');
    expect(() => resolveParams(params, { nope: 1 }, 'hipsOnlyIK')).toThrow(/unknown parameter/);
    expect(() => resolveParams(params, { blendS: 99 }, 'hipsOnlyIK')).toThrow(/above its maximum/);
    expect(() => findMethod('nothing')).toThrow(/Unknown method/);
  });
});

describe('methods on the sofa', () => {
  it('bestOfN asks the model for every seed and both wordings, and keeps the cleanest', async () => {
    const rig = buildStubRig();
    const physics = await sofaPhysics();
    const calls: Array<{ request: StreamRequestPlan; seed: number }> = [];
    const good = seatedPose(rig, 0.6);
    const bad = seatedPose(rig, 0.3);
    const ctx = contextFor(
      rig,
      physics,
      (_request, seed) => holdMotion(seed === 2 ? good : bad),
      calls,
    );
    const method = findMethod('bestOfN');
    const planned = await method.plan?.(ctx, resolveParams(method.params, { n: 3 }, 'bestOfN'));
    expect(calls).toHaveLength(6);
    expect(new Set(calls.map((c) => c.request.phases?.[0]?.prompt)).size).toBe(2);
    expect(planned?.motion.poses[0]).toBe(good);
  });

  it('rigidTranslate moves a sunken body up to the seat without bending it', async () => {
    const rig = buildStubRig();
    const physics = await sofaPhysics();
    const sunk = seatedPose(rig, 0.3);
    const ctx = contextFor(rig, physics, () => holdMotion(sunk));
    const method = findMethod('rigidTranslate');
    const motion = holdMotion(sunk);
    const corrector = method.correct?.(ctx, motion, resolveParams(method.params, {}, method.id));
    if (!corrector) throw new Error('no corrector');
    rig.writePose(sunk);
    corrector.frame(149, 5);
    rig.updateWorld();
    expect(rig.readPose().bones).toEqual(sunk.bones);
    expect(rig.rootShift()[1]).toBeGreaterThan(0.05);
    expect(ctx.measure().seatGap).toBeGreaterThan(-0.05);
  });
});
