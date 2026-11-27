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

describe('methods that move the body to clear furniture', () => {
  async function run(id: string, pose: ReturnType<typeof seatedPose>) {
    const rig = buildStubRig();
    const physics = await sofaPhysics();
    const ctx = contextFor(rig, physics, () => holdMotion(pose));
    // Penetration when the body is only lowered or raised onto the seat, which is all the old objective did.
    rig.writePose(pose);
    rig.placeRoot([0, 0, 0]);
    const plain = ctx.measure();
    rig.placeRoot([0, -plain.seatGap, 0]);
    const plainPen = ctx.measure().furniturePen;
    const method = findMethod(id);
    const corrector = method.correct?.(ctx, holdMotion(pose), resolveParams(method.params, {}, id));
    if (!corrector) throw new Error('no corrector');
    rig.writePose(pose);
    corrector.frame(149, 5);
    rig.updateWorld();
    return { measured: ctx.measure(), report: corrector.report, plainPen };
  }

  for (const id of ['rigidTranslate', 'translateYaw']) {
    it(`${id} ends with no more penetration than a plain seat shift, and says when it cannot clear`, async () => {
      const { measured, report, plainPen } = await run(id, seatedPose(buildStubRig(), 0.6, 90, 20));
      expect(measured.furniturePen).toBeLessThanOrEqual(plainPen + 1e-6);
      expect(report?.infeasible).toBe(measured.furniturePen > 0.004);
      expect(report?.residualPenetration).toBeCloseTo(measured.furniturePen, 5);
    });
  }

  it('wholeBodyTargets gives every knee and ankle target the seat root', async () => {
    const rig = buildStubRig();
    const physics = await sofaPhysics();
    const calls: Array<{ request: StreamRequestPlan; seed: number }> = [];
    const pose = seatedPose(rig, 0.6);
    const ctx = contextFor(rig, physics, () => holdMotion(pose), calls);
    const method = findMethod('wholeBodyTargets');
    await method.plan?.(ctx, resolveParams(method.params, {}, method.id));
    const joints = (calls[0]?.request.targets ?? []).filter((t) => t.joint !== undefined);
    expect(joints.map((t) => t.joint).sort()).toEqual([
      'left_ankle',
      'left_knee',
      'right_ankle',
      'right_knee',
    ]);
    for (const target of joints) expect(target.root).toEqual([0, 0.2]);
  });
});
