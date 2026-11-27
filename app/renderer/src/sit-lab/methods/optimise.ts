/**
 * Method 7: find the smallest change to the pose the motion ends in (joint rotations and a body shift) that is
 * free of penetration, rests on the seat and floor, keeps the feet in front and stays within the tight hinge
 * limits; then blend that change in over the descent. A pattern search over about 20 joints, no gradients.
 */
import { hingeExcessDeg } from '../metrics.js';
import {
  quatMultiply,
  rotationVectorToQuat,
  smoothstep,
  type Quat,
  type Vec3,
} from '../pose-math.js';
import type { Pose } from '../types.js';
import { numberParam, type Corrector, type Method, type MethodContext } from './types.js';

/** Joints the optimiser may turn, with how much a change of each counts against the pose's shape. */
const JOINTS: ReadonlyArray<readonly [string, number]> = [
  ['hips', 1],
  ['spine', 1],
  ['chest', 1],
  ['neck', 0.5],
  ['leftShoulder', 0.5],
  ['rightShoulder', 0.5],
  ['leftUpperArm', 1],
  ['rightUpperArm', 1],
  ['leftLowerArm', 1],
  ['rightLowerArm', 1],
  ['leftUpperLeg', 1],
  ['rightUpperLeg', 1],
  ['leftLowerLeg', 1],
  ['rightLowerLeg', 1],
  ['leftFoot', 0.5],
  ['rightFoot', 0.5],
];

const PENALTY = 2000;
/** Slack that counts as clear: a millimetre or two of overlap or gap is not worth bending the pose for. */
const SLACK = 0.002;
const ROTATION_STEP = 0.06;
const SHIFT_STEP = 0.02;
const MIN_STEP_FRACTION = 0.03;

/** Variables: three rotation-vector components per joint (radians), then the shift x, y, z (metres). */
type Variables = number[];

function applyVariables(base: Pose, variables: readonly number[], scale: number): Pose {
  const bones: Record<string, Quat> = { ...base.bones };
  JOINTS.forEach(([name], i) => {
    const q = base.bones[name];
    if (!q) return;
    const turn = rotationVectorToQuat([
      (variables[i * 3] ?? 0) * scale,
      (variables[i * 3 + 1] ?? 0) * scale,
      (variables[i * 3 + 2] ?? 0) * scale,
    ]);
    bones[name] = quatMultiply(turn, q);
  });
  return { bones, hips: base.hips };
}

function shiftOf(variables: readonly number[]): Vec3 {
  const at = JOINTS.length * 3;
  return [variables[at] ?? 0, variables[at + 1] ?? 0, variables[at + 2] ?? 0];
}

export const poseOptimise: Method = {
  id: 'poseOptimise',
  label: 'Pose optimisation',
  params: [
    {
      name: 'shapeWeight',
      doc: 'Cost per squared radian of joint change (the shape term).',
      default: 1,
      min: 0.1,
      max: 20,
    },
    {
      name: 'shiftWeight',
      doc: 'Cost per squared metre of body shift; higher prefers bending to moving.',
      default: 3,
      min: 0,
      max: 50,
    },
    {
      name: 'iterations',
      doc: 'Sweeps of the search over all variables.',
      default: 25,
      min: 5,
      max: 200,
    },
    {
      name: 'blendStartS',
      doc: 'Seconds after the sit phase starts before the change begins to blend in.',
      default: 0.6,
      min: 0,
      max: 3,
    },
    {
      name: 'blendS',
      doc: 'Seconds the change takes to blend in fully.',
      default: 1.2,
      min: 0.2,
      max: 3,
    },
  ],
  correct(ctx, motion, params): Corrector {
    const end = motion.poses[motion.poses.length - 1];
    if (!end) throw new Error('The motion has no frames.');
    const solved = ctx.timed(() =>
      optimise(ctx, end, {
        shapeWeight: numberParam(params, 'shapeWeight'),
        shiftWeight: numberParam(params, 'shiftWeight'),
        iterations: numberParam(params, 'iterations'),
      }),
    );
    const start = ctx.sitStartS + numberParam(params, 'blendStartS');
    const blend = numberParam(params, 'blendS');
    return {
      appPipeline: false,
      frame: (index, timeS) => {
        const weight = smoothstep((timeS - start) / blend);
        const raw = motion.poses[Math.min(index, motion.poses.length - 1)];
        if (!raw) return;
        ctx.rig.writePose(applyVariables(raw, solved, weight));
        const shift = shiftOf(solved);
        ctx.rig.placeRoot([shift[0] * weight, shift[1] * weight, shift[2] * weight]);
      },
    };
  },
};

function optimise(
  ctx: MethodContext,
  end: Pose,
  weights: { shapeWeight: number; shiftWeight: number; iterations: number },
): Variables {
  const { rig, dest } = ctx;
  const count = JOINTS.length * 3 + 3;
  const cost = (variables: readonly number[]): number => {
    const pose = applyVariables(end, variables, 1);
    rig.writePose(pose);
    rig.placeRoot(shiftOf(variables));
    const m = ctx.measure();
    let total = 0;
    JOINTS.forEach(([, weight], i) => {
      const a = variables[i * 3] ?? 0;
      const b = variables[i * 3 + 1] ?? 0;
      const c = variables[i * 3 + 2] ?? 0;
      total += weights.shapeWeight * weight * (a * a + b * b + c * c);
    });
    const [sx, sy, sz] = shiftOf(variables);
    total += weights.shiftWeight * (sx * sx + sy * sy + sz * sz);
    const over = (value: number, limit: number) => Math.max(0, value - limit);
    const frontShort = Math.max(0, dest.frontEdge + 0.02 - Math.min(...m.ankleAlong));
    total +=
      PENALTY *
      (over(m.furniturePen, SLACK) ** 2 +
        over(m.selfPen, SLACK) ** 2 +
        over(Math.abs(m.seatGap), SLACK) ** 2 +
        over(m.pelvisToSit, 0.02) ** 2 +
        over(Math.abs(m.sole[0]), SLACK) ** 2 +
        over(Math.abs(m.sole[1]), SLACK) ** 2 +
        frontShort ** 2 +
        ((hingeExcessDeg(pose) * Math.PI) / 180) ** 2);
    return total;
  };

  let best: Variables = new Array<number>(count).fill(0);
  let bestCost = cost(best);
  let fraction = 1;
  for (let sweep = 0; sweep < weights.iterations && fraction > MIN_STEP_FRACTION; sweep += 1) {
    let improved = false;
    for (let i = 0; i < count; i += 1) {
      const step = (i < JOINTS.length * 3 ? ROTATION_STEP : SHIFT_STEP) * fraction;
      for (const sign of [1, -1]) {
        const trial = [...best];
        trial[i] = (trial[i] ?? 0) + sign * step;
        const c = cost(trial);
        if (c < bestCost - 1e-12) {
          best = trial;
          bestCost = c;
          improved = true;
          break;
        }
      }
    }
    if (!improved) fraction /= 2;
  }
  return best;
}
