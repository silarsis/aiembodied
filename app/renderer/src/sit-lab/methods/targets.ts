/**
 * Methods that steer the motion model itself: whole-body targets from the seat (5), closed-loop correction of the
 * targets from what the model did (4) and a settling continuation after the sit (9).
 */
import type {
  AvatarMotionJoint,
  AvatarMotionObserved,
  AvatarMotionTarget,
} from '../../avatar/types.js';
import { SETTLE_PROMPT, type StreamRequestPlan } from '../../rooms/scene-actions.js';
import { heightToMotion, worldToMotion, worldYawToMotion } from '../../rooms/scene-frames.js';
import { legPoints, type LegPoints, type LegSpec } from '../destination.js';
import type { Vec3 } from '../pose-math.js';
import type { Pose } from '../types.js';
import {
  numberParam,
  type Method,
  type MethodContext,
  type MotionClip,
  type ParamSpec,
  type Planned,
} from './types.js';

const LEG_JOINTS: ReadonlyArray<readonly [AvatarMotionJoint, keyof LegPoints]> = [
  ['left_knee', 'leftKnee'],
  ['right_knee', 'rightKnee'],
  ['left_ankle', 'leftAnkle'],
  ['right_ankle', 'rightAnkle'],
];

/** The end of the sit phase, where the seat targets hold (the app puts them 0.1 s before the end). */
const TARGET_END_MARGIN_S = 0.1;

function requireLegs(ctx: MethodContext): NonNullable<MethodContext['legs']> {
  if (!ctx.legs)
    throw new Error('This method needs the avatar leg lengths, which could not be measured.');
  return ctx.legs;
}

function motionPoint(ctx: MethodContext, p: Vec3): [number, number, number] {
  const [x, z] = worldToMotion(ctx.frame, p[0], p[2]);
  return [round(x), round(heightToMotion(ctx.frame, p[1])), round(z)];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Knee and ankle joint targets in the motion frame for a set of world leg points. */
function jointTargets(
  ctx: MethodContext,
  points: LegPoints,
  span: { t: number; until: number; revealS: number },
): AvatarMotionTarget[] {
  return LEG_JOINTS.map(([joint, key]) => ({
    ...span,
    joint,
    position: motionPoint(ctx, points[key]),
  }));
}

function withoutJointTargets(request: StreamRequestPlan): AvatarMotionTarget[] {
  return (request.targets ?? []).filter((target) => target.joint === undefined);
}

/** The last held pelvis target of a sit plan: the one that pins the root, height and heading on the seat. */
function seatTarget(request: StreamRequestPlan): AvatarMotionTarget {
  const found = [...(request.targets ?? [])]
    .filter(
      (target) =>
        target.root !== undefined &&
        target.heading !== undefined &&
        target.joint === undefined &&
        target.hand === undefined &&
        (target.until ?? target.t) > target.t,
    )
    .sort((a, b) => b.t - a.t)[0];
  if (!found) throw new Error('The sit plan has no seat target.');
  return found;
}

const LEG_TARGET_PARAMS: readonly ParamSpec[] = [
  {
    name: 'kneeOverhang',
    doc: 'Metres the knee targets go past the seat front edge.',
    default: 0.03,
    min: 0,
    max: 0.15,
  },
  {
    name: 'footForward',
    doc: 'Metres the ankle targets go in front of the knees beyond a straight shin.',
    default: 0,
    min: 0,
    max: 0.3,
  },
];

export const wholeBodyTargets: Method = {
  id: 'wholeBodyTargets',
  label: 'Whole-body targets',
  params: [
    ...LEG_TARGET_PARAMS,
    {
      name: 'revealLeadS',
      doc: 'Seconds before the sit phase starts that the leg targets are revealed to the model (negative: later).',
      default: 0,
      min: -2,
      max: 2,
    },
    {
      name: 'holdS',
      doc: 'Seconds the leg targets are held at the end of the sit.',
      default: 0.5,
      min: 0.2,
      max: 2,
    },
  ],
  async plan(ctx, params): Promise<Planned> {
    const request = legTargetRequest(ctx, ctx.baseRequest, {
      spec: {
        kneeOverhang: numberParam(params, 'kneeOverhang'),
        footForward: numberParam(params, 'footForward'),
      },
      holdS: numberParam(params, 'holdS'),
      revealS: Math.max(0, ctx.sitStartS - numberParam(params, 'revealLeadS')),
    });
    return { motion: await ctx.generate(request, ctx.seed) };
  },
};

/** The plan's request with its joint targets replaced by ones derived from the seat. */
function legTargetRequest(
  ctx: MethodContext,
  base: StreamRequestPlan,
  options: { spec: LegSpec; holdS: number; revealS: number },
): StreamRequestPlan {
  const points = legPoints(ctx.dest, requireLegs(ctx), ctx.hipHalfSpacing, options.spec);
  const until = round(base.duration - TARGET_END_MARGIN_S);
  return {
    ...base,
    targets: [
      ...withoutJointTargets(base),
      ...jointTargets(ctx, points, {
        t: round(until - options.holdS),
        until,
        revealS: options.revealS,
      }),
    ],
  };
}

// -- Closed loop ----------------------------------------------------------------------------------

interface EndErrors {
  pelvis: Vec3;
  joints: Record<AvatarMotionJoint, Vec3>;
  /** Largest pelvis, knee and ankle error in metres. */
  pelvisNorm: number;
  kneeNorm: number;
  ankleNorm: number;
}

const BONE_OF_JOINT: Record<AvatarMotionJoint, string> = {
  left_knee: 'leftLowerLeg',
  right_knee: 'rightLowerLeg',
  left_ankle: 'leftFoot',
  right_ankle: 'rightFoot',
};

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Where the body ended against where the seat wants it (observed minus desired, world metres). */
function endErrors(ctx: MethodContext, end: Pose, desired: LegPoints): EndErrors {
  ctx.rig.writePose(end);
  ctx.rig.placeRoot([0, 0, 0]);
  const diff = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const hips = ctx.rig.world('hips');
  const pelvis = diff(hips, [ctx.dest.sitPoint[0], ctx.dest.pelvisY, ctx.dest.sitPoint[2]]);
  const goals: Record<AvatarMotionJoint, Vec3> = {
    left_knee: desired.leftKnee,
    right_knee: desired.rightKnee,
    left_ankle: desired.leftAnkle,
    right_ankle: desired.rightAnkle,
  };
  const error = (joint: AvatarMotionJoint): Vec3 =>
    diff(ctx.rig.world(BONE_OF_JOINT[joint]), goals[joint]);
  const joints: Record<AvatarMotionJoint, Vec3> = {
    left_knee: error('left_knee'),
    right_knee: error('right_knee'),
    left_ankle: error('left_ankle'),
    right_ankle: error('right_ankle'),
  };
  return {
    pelvis,
    joints,
    pelvisNorm: Math.hypot(pelvis[0], pelvis[2]),
    kneeNorm: Math.max(norm(joints.left_knee), norm(joints.right_knee)),
    ankleNorm: Math.max(norm(joints.left_ankle), norm(joints.right_ankle)),
  };
}

/** Moves a motion-frame target by minus `gain` times a world error, each component limited to `maxStep` metres. */
function pushed(
  ctx: MethodContext,
  target: AvatarMotionTarget,
  error: Vec3,
  gain: number,
  maxStep: number,
): AvatarMotionTarget {
  const limit = (v: number) => Math.max(-maxStep, Math.min(maxStep, -gain * v));
  const [dx, dz] = worldToMotion(
    ctx.frame,
    ctx.frame.origin.x + limit(error[0]),
    ctx.frame.origin.z + limit(error[2]),
  );
  const dy = limit(error[1]) / ctx.frame.scale;
  const moved: AvatarMotionTarget = { ...target };
  if (target.root) moved.root = [round(target.root[0] + dx), round(target.root[1] + dz)];
  if (target.height !== undefined) moved.height = round(target.height + dy);
  if (target.position) {
    moved.position = [
      round(target.position[0] + dx),
      round(target.position[1] + dy),
      round(target.position[2] + dz),
    ];
  }
  return moved;
}

export const closedLoop: Method = {
  id: 'closedLoop',
  label: 'Closed loop',
  params: [
    {
      name: 'maxIters',
      doc: 'Most model calls in all (the first is the plain plan).',
      default: 3,
      min: 1,
      max: 5,
    },
    {
      name: 'pelvisTol',
      doc: 'Pelvis error (horizontal, metres) that is good enough.',
      default: 0.03,
      min: 0.01,
      max: 0.1,
    },
    {
      name: 'kneeTol',
      doc: 'Knee error (metres) that is good enough.',
      default: 0.05,
      min: 0.02,
      max: 0.15,
    },
    {
      name: 'footTol',
      doc: 'Ankle error (metres) that is good enough.',
      default: 0.05,
      min: 0.02,
      max: 0.15,
    },
    {
      name: 'gain',
      doc: "How much of an error is subtracted from the next request's targets.",
      default: 0.8,
      min: 0.2,
      max: 1.5,
    },
  ],
  async plan(ctx, params): Promise<Planned> {
    const desired = legPoints(ctx.dest, requireLegs(ctx), ctx.hipHalfSpacing, {
      kneeOverhang: 0.03,
      footForward: 0,
    });
    let request = ctx.baseRequest;
    let best: { motion: MotionClip; score: number } | null = null;
    for (let iteration = 0; iteration < numberParam(params, 'maxIters'); iteration += 1) {
      const motion = await ctx.generate(request, ctx.seed);
      const end = motion.poses[motion.poses.length - 1];
      if (!end) throw new Error('The motion has no frames.');
      const errors = ctx.timed(() => endErrors(ctx, end, desired));
      const score = errors.pelvisNorm + errors.kneeNorm + errors.ankleNorm;
      if (!best || score < best.score) best = { motion, score };
      if (
        errors.pelvisNorm <= numberParam(params, 'pelvisTol') &&
        errors.kneeNorm <= numberParam(params, 'kneeTol') &&
        errors.ankleNorm <= numberParam(params, 'footTol')
      )
        break;
      const gain = numberParam(params, 'gain');
      request = {
        ...request,
        targets: (request.targets ?? []).map((target) => {
          if (target.joint) return pushed(ctx, target, errors.joints[target.joint], gain, 0.15);
          if (target.root !== undefined || target.height !== undefined) {
            return pushed(ctx, target, errors.pelvis, gain, 0.15);
          }
          return target;
        }),
      };
    }
    if (!best) throw new Error('closedLoop made no model call.');
    return { motion: best.motion };
  },
};

// -- Land, then settle ----------------------------------------------------------------------------

export const landThenSettle: Method = {
  id: 'landThenSettle',
  label: 'Land then settle',
  params: [
    {
      name: 'settleS',
      doc: 'Seconds of the continuation that holds the seat targets after the sit (the service needs at least 0.5).',
      default: 1.5,
      min: 0.5,
      max: 4,
    },
  ],
  async plan(ctx, params): Promise<Planned> {
    const legs = requireLegs(ctx);
    const landed = await ctx.generate(ctx.baseRequest, ctx.seed);
    const session = landed.stream.session;
    if (!session) throw new Error('The motion service gave no session to continue from.');
    const end = landed.poses[landed.poses.length - 1];
    if (!end) throw new Error('The motion has no frames.');
    const settleS = numberParam(params, 'settleS');
    const seat = seatTarget(ctx.baseRequest);
    const goals = legPoints(ctx.dest, legs, ctx.hipHalfSpacing, {
      kneeOverhang: 0.03,
      footForward: 0,
    });
    // Where the body really is, pinned onto the first frames of the continuation (services/motion/API.md).
    const observed = ctx.timed(() => {
      ctx.rig.writePose(end);
      ctx.rig.placeRoot([0, 0, 0]);
      const hips = ctx.rig.world('hips');
      const [hx, , hz] = motionPoint(ctx, hips);
      const at = (joint: AvatarMotionJoint) =>
        motionPoint(ctx, ctx.rig.world(BONE_OF_JOINT[joint]));
      const result: AvatarMotionObserved = {
        root: [hx, hz],
        height: heightToMotion(ctx.frame, hips[1]),
        joints: {
          left_knee: at('left_knee'),
          right_knee: at('right_knee'),
          left_ankle: at('left_ankle'),
          right_ankle: at('right_ankle'),
        },
      };
      return result;
    });
    const hold = { t: 0, until: settleS, revealS: 0 };
    const request: StreamRequestPlan = {
      prompt: SETTLE_PROMPT,
      duration: settleS,
      continueFrom: session,
      observed,
      targets: [
        { ...seat, ...hold, heading: seat.heading ?? worldYawToMotion(ctx.frame, ctx.dest.facing) },
        ...jointTargets(ctx, goals, hold),
      ],
    };
    return { motion: await ctx.generateContinuation(landed, request, ctx.seed) };
  },
};
