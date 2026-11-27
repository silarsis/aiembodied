/**
 * Methods 2 and 3: keep the model's pose exactly and move the whole body (and, for 3, turn it a little) to the
 * place that minimises furniture penetration and seat error together. The move is found once, from the pose the
 * motion ends in, and blended in over the descent. A body that cannot be cleared without leaving the seat is
 * placed at the best compromise and reported as infeasible.
 */
import { FURNITURE_CLEAR, furnitureDepth, type Capsule, type Colliders } from '../measure.js';
import { smoothstep, type Vec3 } from '../pose-math.js';
import type { Pose } from '../types.js';
import { seatedContactY } from '../../rooms/seat-fit.js';
import {
  numberParam,
  type Corrector,
  type Method,
  type MethodContext,
  type MotionClip,
  type ParamSpec,
} from './types.js';

/**
 * Search ranges. Sideways shift: within MAX_SHIFT of where the model put the pelvis. Vertical shift: from
 * LOWER_DY below to UPPER_DY above the one that seats the buttocks exactly (lifting off the seat can free thighs
 * that sink into the cushion, and costs seat error). Coarse grid steps, then a fine pass around the best one.
 */
const MAX_SHIFT = 0.3;
const LOWER_DY = 0.02;
const UPPER_DY = 0.06;
const COARSE_STEP = 0.04;
const FINE_STEP = 0.01;
const YAW_STEP_DEG = 3;
/**
 * Objective, all in metres: deepest furniture penetration, plus seat error (vertical miss of the buttocks plus how
 * far the pelvis is outside its tolerance of the sit point), plus a small cost for moving sideways and for turning.
 * Penetration and seat error weigh the same, so a body that cannot clear the furniture without leaving the seat
 * is placed where the two errors are smallest together.
 */
const SEAT_WEIGHT = 1;
const SIDEWAYS_COST = 0.1;

interface RigidMove {
  shift: Vec3;
  yawDeg: number;
  /** World point the yaw turns about (the pelvis). */
  pivot: Vec3;
  /** Deepest penetration that remains after the move (metres). */
  residual: number;
  /** Buttocks height error plus pelvis distance beyond tolerance after the move (metres). */
  seatError: number;
  /** False when the best move still leaves more than `FURNITURE_CLEAR` of penetration. */
  cleared: boolean;
}

function moved(capsule: Capsule, shift: Vec3, yawDeg: number, pivot: Vec3): Capsule {
  const yaw = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const place = (p: Vec3): Vec3 => {
    const dx = p[0] - pivot[0];
    const dz = p[2] - pivot[2];
    return [
      pivot[0] + dx * cos + dz * sin + shift[0],
      p[1] + shift[1],
      pivot[2] - dx * sin + dz * cos + shift[2],
    ];
  };
  return { ...capsule, p0: place(capsule.p0), p1: place(capsule.p1) };
}

/** Deepest penetration of the moved body; stops counting as soon as it passes `cutoff`. */
function deepest(
  colliders: Colliders | null,
  capsules: readonly Capsule[],
  seatId: string,
  move: { shift: Vec3; yawDeg: number; pivot: Vec3 },
  cutoff: number,
): number {
  if (!colliders) return 0;
  let worst = 0;
  for (const capsule of capsules) {
    worst = Math.max(
      worst,
      furnitureDepth(colliders, moved(capsule, move.shift, move.yawDeg, move.pivot), seatId),
    );
    if (worst >= cutoff) return worst;
  }
  return worst;
}

/**
 * The move (shift in x, y and z plus a turn about the pelvis) of the posed body that minimises the objective
 * above: furniture penetration, seat error and a small movement cost. Never ignores penetration: when no move
 * within the ranges clears the furniture, the best compromise is returned with `cleared` false.
 */
function solveRigidMove(
  ctx: MethodContext,
  pose: Pose,
  limits: { maxYawDeg: number; pelvisTol: number; yawCost: number },
): RigidMove {
  const { rig, dest, colliders } = ctx;
  rig.writePose(pose);
  rig.placeRoot([0, 0, 0]);
  const capsules = rig.capsules();
  const hips = rig.world('hips');
  const dySeat = dest.surfaceY - seatedContactY(hips[1], rig.restHipsHeight, dest.scale);
  const pivot: Vec3 = [hips[0], hips[1], hips[2]];
  const yaws = [0];
  for (let yaw = YAW_STEP_DEG; yaw <= limits.maxYawDeg + 1e-9; yaw += YAW_STEP_DEG)
    yaws.push(yaw, -yaw);

  const seatErrorAt = (dx: number, dy: number, dz: number): number =>
    Math.abs(dy - dySeat) +
    Math.max(
      0,
      Math.hypot(hips[0] + dx - dest.sitPoint[0], hips[2] + dz - dest.sitPoint[2]) -
        limits.pelvisTol,
    );

  type Best = { cost: number; shift: Vec3; yawDeg: number };
  let best: Best = { cost: Infinity, shift: [0, dySeat, 0], yawDeg: 0 };
  const consider = (dx: number, dy: number, dz: number, yawDeg: number): void => {
    const seat = SEAT_WEIGHT * seatErrorAt(dx, dy, dz);
    const cost0 = seat + SIDEWAYS_COST * Math.hypot(dx, dz) + limits.yawCost * Math.abs(yawDeg);
    if (cost0 >= best.cost) return;
    const shift: Vec3 = [dx, dy, dz];
    const pen = deepest(
      colliders,
      capsules,
      dest.seatId,
      { shift, yawDeg, pivot },
      best.cost - cost0,
    );
    const cost = cost0 + pen;
    if (cost < best.cost) best = { cost, shift, yawDeg };
  };
  const sweep = (
    centre: Vec3,
    reach: { xz: number; below: number; above: number },
    step: number,
    yawList: readonly number[],
  ): void => {
    for (const yawDeg of yawList) {
      for (let dx = centre[0] - reach.xz; dx <= centre[0] + reach.xz + 1e-9; dx += step) {
        for (let dz = centre[2] - reach.xz; dz <= centre[2] + reach.xz + 1e-9; dz += step) {
          if (Math.hypot(dx, dz) > MAX_SHIFT + 1e-9) continue;
          for (
            let dy = centre[1] - reach.below;
            dy <= centre[1] + reach.above + 1e-9;
            dy += step / 2
          ) {
            consider(dx, dy, dz, yawDeg);
          }
        }
      }
    }
  };
  // Coarse over the whole range (every yaw), then fine around the winner (its yaw only).
  consider(0, dySeat, 0, 0);
  sweep([0, dySeat, 0], { xz: MAX_SHIFT, below: LOWER_DY, above: UPPER_DY }, COARSE_STEP, yaws);
  const coarse = best;
  sweep(
    coarse.shift,
    { xz: COARSE_STEP, below: COARSE_STEP / 2, above: COARSE_STEP / 2 },
    FINE_STEP,
    [coarse.yawDeg],
  );

  const residual = deepest(
    colliders,
    capsules,
    dest.seatId,
    { shift: best.shift, yawDeg: best.yawDeg, pivot },
    Infinity,
  );
  return {
    shift: best.shift,
    yawDeg: best.yawDeg,
    pivot,
    residual,
    seatError: seatErrorAt(...best.shift),
    cleared: residual <= FURNITURE_CLEAR,
  };
}

const BLEND_PARAMS: readonly ParamSpec[] = [
  {
    name: 'blendStartS',
    doc: 'Seconds after the sit phase starts before the move begins to blend in.',
    default: 0.6,
    min: 0,
    max: 3,
  },
  {
    name: 'blendS',
    doc: 'Seconds the move takes to blend in fully.',
    default: 1.2,
    min: 0.2,
    max: 3,
  },
  {
    name: 'pelvisTol',
    doc: 'The pelvis may be this many metres from the sit point before that counts as seat error.',
    default: 0.05,
    min: 0,
    max: 0.08,
  },
];

function blended(
  ctx: MethodContext,
  end: Pose,
  blend: { startS: number; durationS: number },
  limits: { maxYawDeg: number; pelvisTol: number; yawCost: number },
): Corrector {
  const move = ctx.timed(() => solveRigidMove(ctx, end, limits));
  const start = ctx.sitStartS + blend.startS;
  return {
    appPipeline: false,
    report: {
      infeasible: !move.cleared,
      residualPenetration: move.residual,
      seatError: move.seatError,
      shift: move.shift,
      yawDeg: move.yawDeg,
    },
    frame: (_index, timeS) => {
      const weight = smoothstep((timeS - start) / blend.durationS);
      ctx.rig.placeRoot(
        [move.shift[0] * weight, move.shift[1] * weight, move.shift[2] * weight],
        move.yawDeg * weight,
        move.pivot,
      );
    },
  };
}

function lastPose(motion: MotionClip): Pose {
  const end = motion.poses[motion.poses.length - 1];
  if (!end) throw new Error('The motion has no frames.');
  return end;
}

export const rigidTranslate: Method = {
  id: 'rigidTranslate',
  label: 'Rigid translate',
  params: BLEND_PARAMS,
  correct: (ctx, motion, params) =>
    blended(
      ctx,
      lastPose(motion),
      { startS: numberParam(params, 'blendStartS'), durationS: numberParam(params, 'blendS') },
      { maxYawDeg: 0, pelvisTol: numberParam(params, 'pelvisTol'), yawCost: 0 },
    ),
};

export const translateYaw: Method = {
  id: 'translateYaw',
  label: 'Translate and yaw',
  params: [
    ...BLEND_PARAMS,
    {
      name: 'maxYawDeg',
      doc: 'Largest turn of the whole body about the pelvis, in degrees either way.',
      default: 15,
      min: 0,
      max: 30,
    },
    {
      name: 'yawCost',
      doc: 'Metres of shift one degree of turn is worth when choosing the cheapest move.',
      default: 0.002,
      min: 0,
      max: 0.02,
    },
  ],
  correct: (ctx, motion, params) =>
    blended(
      ctx,
      lastPose(motion),
      { startS: numberParam(params, 'blendStartS'), durationS: numberParam(params, 'blendS') },
      {
        maxYawDeg: numberParam(params, 'maxYawDeg'),
        pelvisTol: numberParam(params, 'pelvisTol'),
        yawCost: numberParam(params, 'yawCost'),
      },
    ),
};
