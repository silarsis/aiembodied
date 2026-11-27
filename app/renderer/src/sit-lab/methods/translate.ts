/**
 * Methods 2 and 3: keep the model's pose exactly and move the whole body (and, for 3, turn it a little) so the
 * buttocks rest on the cushion and nothing is inside furniture. The move is found once, from the pose the motion
 * ends in, and blended in over the descent.
 */
import { furnitureDepth, type Capsule, type Colliders } from '../measure.js';
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

/** Capsules count as clear below this depth (metres). */
const CLEAR = 0.004;
/** Candidate shifts are searched in rings this far apart (metres), and yaws in steps of this many degrees. */
const RING_STEP = 0.02;
const YAW_STEP_DEG = 3;
const MAX_SHIFT = 0.3;

interface RigidMove {
  shift: Vec3;
  yawDeg: number;
  /** World point the yaw turns about (the pelvis). */
  pivot: Vec3;
  /** False when no move cleared everything within the search range: the best effort was used. */
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

function deepest(
  colliders: Colliders | null,
  capsules: readonly Capsule[],
  seatId: string,
  shift: Vec3,
  yawDeg: number,
  pivot: Vec3,
): number {
  if (!colliders) return 0;
  let worst = 0;
  for (const capsule of capsules) {
    worst = Math.max(
      worst,
      furnitureDepth(colliders, moved(capsule, shift, yawDeg, pivot), seatId),
    );
    if (worst > CLEAR) return worst;
  }
  return worst;
}

/** The ring of offsets (x, z) at `radius`, every `RING_STEP` or so along it. */
function ring(radius: number): Array<[number, number]> {
  if (radius === 0) return [[0, 0]];
  const count = Math.max(8, Math.round((2 * Math.PI * radius) / RING_STEP));
  return Array.from({ length: count }, (_, k) => {
    const angle = (2 * Math.PI * k) / count;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
}

/**
 * The smallest move (shift plus turn) of the posed body that seats the buttocks on the surface (the vertical
 * shift is fixed by that), keeps the pelvis within `pelvisTol` of the sit point and clears every collider.
 * Cost is the length of the shift plus `yawCost` metres per degree turned.
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
  const dy = dest.surfaceY - seatedContactY(hips[1], rig.restHipsHeight, dest.scale);
  const pivot: Vec3 = [hips[0], hips[1], hips[2]];
  const yaws = [0];
  for (let yaw = YAW_STEP_DEG; yaw <= limits.maxYawDeg + 1e-9; yaw += YAW_STEP_DEG)
    yaws.push(yaw, -yaw);

  type Best = { cost: number; shift: Vec3; yawDeg: number; depth: number };
  const search = (pelvisTol: number | null): Best | null => {
    let best: Best | null = null;
    for (const yawDeg of yaws) {
      const yawCost = limits.yawCost * Math.abs(yawDeg);
      for (let radius = 0; radius <= MAX_SHIFT + 1e-9; radius += RING_STEP) {
        // Rings only get longer: a clear ring is the cheapest for this yaw, and further ones cannot beat the best.
        if (best && Math.hypot(radius, dy) + yawCost >= best.cost) break;
        let found: Best | null = null;
        for (const [dx, dz] of ring(radius)) {
          if (
            pelvisTol !== null &&
            Math.hypot(hips[0] + dx - dest.sitPoint[0], hips[2] + dz - dest.sitPoint[2]) > pelvisTol
          )
            continue;
          const shift: Vec3 = [dx, dy, dz];
          const depth = deepest(colliders, capsules, dest.seatId, shift, yawDeg, pivot);
          if (depth > CLEAR) continue;
          const cost = Math.hypot(dx, dy, dz) + yawCost;
          if (!found || cost < found.cost) found = { cost, shift, yawDeg, depth };
        }
        if (found) {
          if (!best || found.cost < best.cost) best = found;
          break;
        }
      }
    }
    return best;
  };

  const best = search(limits.pelvisTol) ?? search(null);
  if (best) return { shift: best.shift, yawDeg: best.yawDeg, pivot, cleared: true };
  return { shift: [0, dy, 0], yawDeg: 0, pivot, cleared: false };
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
    doc: 'The pelvis must end within this many metres of the sit point (relaxed if nothing fits).',
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
