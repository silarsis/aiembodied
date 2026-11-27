/**
 * Method 6: move the pelvis to the seat and let the legs follow with two-bone IK so the feet stay on the floor in
 * front of the seat. Spine, arms and head are children of the pelvis and keep their pelvis-relative angles because
 * their local rotations are not touched. The pelvis offset is low-passed so it settles smoothly.
 */
import * as THREE from 'three';
import { solveTwoBone } from '../../rooms/contact-math.js';
import { seatedContactY } from '../../rooms/seat-fit.js';
import { CAPSULE_RADII } from '../../rooms/contact-body.js';
import { alongSeat } from '../destination.js';
import { FURNITURE_CLEAR, furnitureDepth } from '../measure.js';
import { smoothstep, type Vec3 } from '../pose-math.js';
import { STEP_S } from '../types.js';
import { numberParam, type Corrector, type Method, type MethodContext } from './types.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Metres a foot goal is pushed forward past a measured shin or foot penetration, on top of it. */
const PUSH_MARGIN = 0.01;
const MAX_PUSHES = 5;

/**
 * Where the foot bone should be on the floor in front of the seat: the model's own spot, pushed so the shin's
 * surface (not just its axis) is `clearance` past the seat's front edge.
 */
function footGoal(ctx: MethodContext, ankle: Vec3, clearance: number): THREE.Vector3 {
  const { dest, legs } = ctx;
  const ankleY = dest.footFloorY + (legs?.ankleHeight ?? 0) * dest.scale;
  const shin = CAPSULE_RADII.shin * dest.bodyFactor;
  const short = dest.frontEdge + clearance + shin - alongSeat(dest, ankle);
  const push = Math.max(0, short);
  return new THREE.Vector3(
    ankle[0] + dest.forward[0] * push,
    ankleY,
    ankle[2] + dest.forward[1] * push,
  );
}

/** Turns `bone` so the direction to `child` points at `target` (world), by the shortest rotation. */
function aim(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3): void {
  bone.updateWorldMatrix(true, true);
  const from = child
    .getWorldPosition(new THREE.Vector3())
    .sub(bone.getWorldPosition(new THREE.Vector3()));
  const to = target.clone().sub(bone.getWorldPosition(new THREE.Vector3()));
  if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) return;
  const turn = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const parent = (bone.parent ?? bone).getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parent.invert().multiply(turn).multiply(world));
  bone.updateWorldMatrix(true, true);
}

/**
 * Twists the thigh about its own axis so the knee still bends in the plane the hip, knee and foot now span. Turning
 * the thigh by the shortest arc alone leaves the knee's hinge axis wherever it fell, which shows as a sideways knee.
 */
function keepKneeHinge(
  hip: THREE.Object3D,
  knee: THREE.Object3D,
  thigh: THREE.Vector3,
  shin: THREE.Vector3,
): void {
  const normal = new THREE.Vector3().crossVectors(thigh, shin);
  if (normal.lengthSq() < 1e-8) return;
  normal.normalize();
  const axis = thigh.clone().normalize();
  // The knee flexes about its local X axis.
  const hinge = new THREE.Vector3(1, 0, 0).applyQuaternion(
    knee.getWorldQuaternion(new THREE.Quaternion()),
  );
  hinge.addScaledVector(axis, -hinge.dot(axis));
  if (hinge.lengthSq() < 1e-8) return;
  hinge.normalize();
  if (hinge.dot(normal) < 0) normal.negate();
  const angle = Math.atan2(
    axis.dot(new THREE.Vector3().crossVectors(hinge, normal)),
    hinge.dot(normal),
  );
  const world = hip.getWorldQuaternion(new THREE.Quaternion());
  const parent = (hip.parent ?? hip).getWorldQuaternion(new THREE.Quaternion());
  const turn = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  hip.quaternion.copy(parent.invert().multiply(turn).multiply(world));
  hip.updateWorldMatrix(true, true);
}

/** Puts the foot of one leg at `goal` by bending the hip and knee only; the foot keeps its world orientation. */
function reachWithLeg(ctx: MethodContext, side: 'left' | 'right', goal: THREE.Vector3): void {
  const { rig } = ctx;
  const hip = rig.node(`${side}UpperLeg`);
  const knee = rig.node(`${side}LowerLeg`);
  const foot = rig.node(`${side}Foot`);
  if (!hip || !knee || !foot) throw new Error(`The avatar lacks a ${side} leg bone.`);
  rig.updateWorld();
  const root = hip.getWorldPosition(new THREE.Vector3());
  const kneeAt = knee.getWorldPosition(new THREE.Vector3());
  const footAt = foot.getWorldPosition(new THREE.Vector3());
  const footWorld = foot.getWorldQuaternion(new THREE.Quaternion());
  const mid = new THREE.Vector3();
  const end = new THREE.Vector3();
  solveTwoBone(
    root,
    goal,
    kneeAt.clone().sub(root),
    kneeAt.distanceTo(root),
    footAt.distanceTo(kneeAt),
    mid,
    end,
  );
  aim(hip, knee, mid);
  keepKneeHinge(hip, knee, mid.clone().sub(root), end.clone().sub(mid));
  aim(knee, foot, end);
  const parent = (foot.parent ?? foot).getWorldQuaternion(new THREE.Quaternion());
  foot.quaternion.copy(parent.invert().multiply(footWorld));
  rig.updateWorld();
}

/** Deepest of a leg's shin and foot capsules in furniture now (metres). */
function legDepth(ctx: MethodContext, side: 'left' | 'right'): number {
  if (!ctx.colliders) return 0;
  let worst = 0;
  for (const capsule of ctx.rig.capsules()) {
    if (capsule.name !== `${side}Shin` && capsule.name !== `${side}Foot`) continue;
    worst = Math.max(worst, furnitureDepth(ctx.colliders, capsule, ctx.dest.seatId));
  }
  return worst;
}

/**
 * Pushes the foot goal forward and reaches again while the shin or foot is inside furniture (the knee may sit
 * behind the front edge even when the ankle is past it). Returns the penetration that is left.
 */
function clearShins(
  ctx: MethodContext,
  side: 'left' | 'right',
  goal: THREE.Vector3,
  forward: readonly [number, number],
): number {
  let depth = legDepth(ctx, side);
  for (let push = 0; push < MAX_PUSHES && depth > FURNITURE_CLEAR; push += 1) {
    goal.x += forward[0] * (depth + PUSH_MARGIN);
    goal.z += forward[1] * (depth + PUSH_MARGIN);
    reachWithLeg(ctx, side, goal);
    depth = legDepth(ctx, side);
  }
  return depth;
}

export const hipsOnlyIK: Method = {
  id: 'hipsOnlyIK',
  label: 'Hips-only IK',
  params: [
    {
      name: 'blendStartS',
      doc: 'Seconds after the sit phase starts before the pelvis begins to move to the seat.',
      default: 0.6,
      min: 0,
      max: 3,
    },
    { name: 'blendS', doc: 'Seconds the move to the seat takes.', default: 1.2, min: 0.2, max: 3 },
    {
      name: 'settleDamping',
      doc: 'Rate (1/s) at which the pelvis offset follows its target; higher is stiffer, lower is smoother.',
      default: 12,
      min: 2,
      max: 40,
    },
    {
      name: 'footClearance',
      doc: 'Metres between the seat front edge and the shin surface, at least (the shin radius is added to the ankle goal; goals are then pushed forward until the shin and foot capsules clear the furniture).',
      default: 0.03,
      min: 0,
      max: 0.15,
    },
  ],
  correct(ctx, motion, params): Corrector {
    const { rig, dest } = ctx;
    const end = motion.poses[motion.poses.length - 1];
    if (!end) throw new Error('The motion has no frames.');
    // The pelvis is shifted by the same amount the buttocks need to land on the surface at the sit point.
    const endHips = rig.hipsWorldAtBase(end.hips);
    const wanted: Vec3 = [
      dest.sitPoint[0] - endHips[0],
      dest.surfaceY - seatedContactY(endHips[1], rig.restHipsHeight, dest.scale),
      dest.sitPoint[2] - endHips[2],
    ];
    const start = ctx.sitStartS + numberParam(params, 'blendStartS');
    const blend = numberParam(params, 'blendS');
    const follow = 1 - Math.exp(-numberParam(params, 'settleDamping') * STEP_S);
    const clearance = numberParam(params, 'footClearance');
    const offset: Vec3 = [0, 0, 0];
    const report = { infeasible: false, residualLegPenetration: 0 };
    return {
      appPipeline: false,
      report,
      frame: (index, timeS) => {
        const weight = smoothstep((timeS - start) / blend);
        const raw = motion.poses[Math.min(index, motion.poses.length - 1)];
        if (!raw) return;
        rig.placeRoot([0, 0, 0]);
        // Where the model put the feet, before the pelvis moves.
        const ankles = (['left', 'right'] as const).map((side) => rig.world(`${side}Foot`));
        for (let axis = 0; axis < 3; axis += 1) {
          offset[axis] =
            (offset[axis] ?? 0) + ((wanted[axis] ?? 0) * weight - (offset[axis] ?? 0)) * follow;
        }
        const scale = rig.scale;
        const turned = new THREE.Vector3(offset[0], offset[1], offset[2])
          .applyAxisAngle(UP, -rig.scene.rotation.y)
          .multiplyScalar(1 / scale);
        rig
          .node('hips')
          ?.position.set(raw.hips[0] + turned.x, raw.hips[1] + turned.y, raw.hips[2] + turned.z);
        rig.updateWorld();
        let legDepthNow = 0;
        for (const [i, side] of (['left', 'right'] as const).entries()) {
          const ankle = ankles[i];
          if (!ankle) continue;
          const goal = footGoal(ctx, ankle, clearance);
          const raw3 = new THREE.Vector3(ankle[0], ankle[1], ankle[2]);
          const target = raw3.lerp(goal, weight);
          reachWithLeg(ctx, side, target);
          legDepthNow = Math.max(legDepthNow, clearShins(ctx, side, target, dest.forward));
        }
        // The last frame's value is the one left in the report.
        report.residualLegPenetration = legDepthNow;
        report.infeasible = legDepthNow > FURNITURE_CLEAR;
      },
    };
  },
};
