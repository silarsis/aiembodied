/**
 * Trial metrics, from the per-frame measurements and the raw and final poses. Pure: nothing here touches a
 * renderer, so every number can be checked on synthetic data.
 */
import type { FrameMeasure } from './measure.js';
import {
  quatAngleDeg,
  quatAngleIgnoringYawDeg,
  swingTwist,
  type Quat,
  type Vec3,
} from './pose-math.js';
import type { Pose } from './types.js';

/**
 * How much each joint's change from the motion model's own rotation counts towards "shape change". The torso and
 * limbs that make the seated silhouette count fully; small end joints less. The hips count with their turn about
 * the vertical axis taken out (the sit's heading is the plan's, not shape).
 */
const SHAPE_WEIGHTS: Readonly<Record<string, number>> = {
  hips: 1,
  spine: 1,
  chest: 1,
  upperChest: 0.5,
  neck: 0.5,
  head: 0.5,
  leftShoulder: 0.5,
  rightShoulder: 0.5,
  leftUpperArm: 1,
  rightUpperArm: 1,
  leftLowerArm: 1,
  rightLowerArm: 1,
  leftHand: 0.25,
  rightHand: 0.25,
  leftUpperLeg: 1,
  rightUpperLeg: 1,
  leftLowerLeg: 1,
  rightLowerLeg: 1,
  leftFoot: 0.5,
  rightFoot: 0.5,
  leftToes: 0.25,
  rightToes: 0.25,
};

/**
 * The tight limits of the lab (not the app's joint limits): an elbow or knee is a hinge, so its swing sideways
 * from the bending plane stays within 15 degrees and its twist within 30. Value: [twist axis (0 = X, 1 = Y), name].
 */
const HINGE_SIDEWAYS_LIMIT_DEG = 15;
const HINGE_TWIST_LIMIT_DEG = 30;
const HINGES: ReadonlyArray<readonly [string, 0 | 1]> = [
  ['leftLowerLeg', 1],
  ['rightLowerLeg', 1],
  ['leftLowerArm', 0],
  ['rightLowerArm', 0],
];

/** The pass criteria of a trial (metres unless noted). */
const PASS_LIMITS = {
  furnitureEnd: 0.01,
  selfPenetration: 0.005,
  seatGap: 0.02,
  pelvisToSit: 0.08,
  footFloor: 0.02,
} as const;

/** A joint counts as still when it moves less than this per frame (degrees). */
const STILL_DEG = 0.5;
/** A foot is planted while its sole is within this height of the floor (metres). */
const PLANTED_SOLE = 0.03;

type HingeComponent = 'twist' | 'sideways';

interface HingeBreak {
  joint: string;
  component: HingeComponent;
  /** Degrees past the tight limit of that component, at the worst frame. */
  excessDeg: number;
}

interface HingeBreaks {
  count: number;
  maxDeg: number;
  /** One entry per joint that broke, worst first. */
  joints: HingeBreak[];
}

export interface MetricsInput {
  fps: number;
  /** Measurements of the final pose, one per frame. */
  measures: readonly FrameMeasure[];
  /** The motion model's own pose, one per frame. */
  raw: readonly Pose[];
  /** Measurements of the raw poses with no method and no joint limits, from `sitStartFrame` on. */
  rawMeasures: readonly FrameMeasure[];
  /** The pose after the method, one per frame. */
  final: readonly Pose[];
  /** Hips in the world with the root at its start and the raw pose, one per frame. */
  rawHips: readonly Vec3[];
  /** How far the method moved the body from the raw pose's place, one per frame (metres). */
  translation: readonly number[];
  /** First frame of the sit phase, and the last frame the motion model produced. */
  sitStartFrame: number;
  motionEndFrame: number;
  /** Metres from the sit point to the seat's front edge. */
  frontEdge: number;
  extraModelCalls: number;
  computeMs: number;
}

export interface TrialMetrics {
  furnitureMaxPenetrationEnd: number;
  furnitureMaxPenetrationDescent: number;
  selfPenetrationMax: number;
  /** The pair behind `selfPenetrationMax`; null when there is none. */
  selfPenPair: string | null;
  /** What the motion model did on its own, before any method or joint limit: separates model faults from method faults. */
  rawFurnitureEnd: number;
  rawSelfPen: number;
  rawSelfPenPair: string | null;
  rawHingeMaxDeg: number;
  rawHingeJoint: string | null;
  rawHingeComponent: HingeComponent | null;
  seatGap: number;
  pelvisToSitPoint: number;
  footFloorError: number;
  feetInFrontOfSeat: boolean;
  shapeChangeMeanDeg: number;
  shapeChangeMaxDeg: number;
  translationUsed: number;
  hingeBreaks: HingeBreaks;
  jerkPeak: number;
  jerkPeakRaw: number;
  settleTimeS: number | null;
  footSlideDescent: number;
  extraModelCalls: number;
  computeMs: number;
  pass: boolean;
  /** Which pass criteria failed, by metric name. */
  failures: string[];
}

function last<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error('metrics need at least one frame');
  return item;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`metrics: no frame ${index}`);
  return item;
}

function jerkPeak(points: readonly Vec3[], from: number, fps: number): number {
  let peak = 0;
  for (let i = Math.max(from, 0) + 3; i < points.length; i += 1) {
    const [a, b, c, d] = [at(points, i - 3), at(points, i - 2), at(points, i - 1), at(points, i)];
    const jerk = Math.hypot(
      d[0] - 3 * c[0] + 3 * b[0] - a[0],
      d[1] - 3 * c[1] + 3 * b[1] - a[1],
      d[2] - 3 * c[2] + 3 * b[2] - a[2],
    );
    peak = Math.max(peak, jerk * fps ** 3);
  }
  return peak;
}

function jointAngle(name: string, a: Pose, b: Pose): number {
  const qa = a.bones[name];
  const qb = b.bones[name];
  if (!qa || !qb) return 0;
  return name === 'hips' ? quatAngleIgnoringYawDeg(qa, qb) : quatAngleDeg(qa, qb);
}

function shapeChange(
  raw: readonly Pose[],
  final: readonly Pose[],
  from: number,
): { mean: number; max: number } {
  let total = 0;
  let frames = 0;
  let max = 0;
  for (let i = from; i < raw.length; i += 1) {
    let weighted = 0;
    let weights = 0;
    for (const [name, weight] of Object.entries(SHAPE_WEIGHTS)) {
      const angle = jointAngle(name, at(raw, i), at(final, i));
      weighted += weight * angle;
      weights += weight;
      max = Math.max(max, angle);
    }
    total += weighted / weights;
    frames += 1;
  }
  return { mean: frames > 0 ? total / frames : 0, max };
}

/** How far past the tight limits a hinge joint's rotation is, in degrees (negative inside them), and which part is worse. */
function hingeExcess(q: Quat, twistAxis: 0 | 1): { excess: number; component: HingeComponent } {
  const { twistDeg, swing } = swingTwist(q, twistAxis);
  const sideways = (Math.abs(swing[2]) * 180) / Math.PI - HINGE_SIDEWAYS_LIMIT_DEG;
  const twist = Math.abs(twistDeg) - HINGE_TWIST_LIMIT_DEG;
  return sideways > twist
    ? { excess: sideways, component: 'sideways' }
    : { excess: twist, component: 'twist' };
}

/** The worst excess over the tight limits among the elbows and knees of one pose (0 when all are inside). */
export function hingeExcessDeg(pose: Pose): number {
  let worst = 0;
  for (const [name, twistAxis] of HINGES) {
    const q = pose.bones[name];
    if (q) worst = Math.max(worst, hingeExcess(q, twistAxis).excess);
  }
  return worst;
}

/** The worst excess of each hinge joint over the frames from `from`, joints that broke only, worst first. */
function hingeBreaks(poses: readonly Pose[], from: number): HingeBreaks {
  const joints: HingeBreak[] = [];
  for (const [name, twistAxis] of HINGES) {
    let worst: HingeBreak | null = null;
    for (let i = from; i < poses.length; i += 1) {
      const q = at(poses, i).bones[name];
      if (!q) continue;
      const { excess, component } = hingeExcess(q, twistAxis);
      if (excess > 0 && (!worst || excess > worst.excessDeg)) {
        worst = { joint: name, component, excessDeg: excess };
      }
    }
    if (worst) joints.push(worst);
  }
  joints.sort((a, b) => b.excessDeg - a.excessDeg);
  return { count: joints.length, maxDeg: joints[0]?.excessDeg ?? 0, joints };
}

/** Frames after the motion until every joint moves less than 0.5 degrees per frame for good; null if it never does. */
function settleTime(final: readonly Pose[], motionEnd: number, fps: number): number | null {
  const lastIndex = final.length - 1;
  let quietFrom = lastIndex + 1;
  for (let i = lastIndex; i > motionEnd; i -= 1) {
    let moved = 0;
    for (const name of Object.keys(SHAPE_WEIGHTS)) {
      moved = Math.max(moved, jointAngle(name, at(final, i), at(final, i - 1)));
    }
    if (moved >= STILL_DEG) break;
    quietFrom = i;
  }
  if (quietFrom > lastIndex) return null;
  return (quietFrom - (motionEnd + 1)) / fps;
}

function footSlide(measures: readonly FrameMeasure[], from: number, to: number): number {
  let slid = 0;
  for (let i = Math.max(from, 0) + 1; i <= Math.min(to, measures.length - 1); i += 1) {
    const now = at(measures, i);
    const before = at(measures, i - 1);
    for (const foot of [0, 1] as const) {
      if (now.sole[foot] > PLANTED_SOLE || before.sole[foot] > PLANTED_SOLE) continue;
      slid += Math.hypot(
        now.feet[foot][0] - before.feet[foot][0],
        now.feet[foot][2] - before.feet[foot][2],
      );
    }
  }
  return slid;
}

export function computeMetrics(input: MetricsInput): TrialMetrics {
  const { measures, raw, final, fps } = input;
  if (measures.length === 0 || raw.length !== final.length || measures.length !== raw.length) {
    throw new Error('metrics need one measure, raw pose and final pose per frame');
  }
  const end = last(measures);
  const from = input.sitStartFrame;
  const window = measures.slice(Math.max(from, 0));
  const shape = shapeChange(raw, final, Math.max(from, 0));
  const hinge = hingeBreaks(final, Math.max(from, 0));
  const rawHinge = hingeBreaks(raw, Math.max(from, 0)).joints[0] ?? null;
  const rawEnd = last(input.rawMeasures);
  const selfWorst = window.reduce((worst, m) => (m.selfPen > worst.selfPen ? m : worst), end);
  const rawSelfWorst = input.rawMeasures.reduce(
    (worst, m) => (m.selfPen > worst.selfPen ? m : worst),
    rawEnd,
  );
  const descent = measures.slice(Math.max(from, 0), input.motionEndFrame + 1);

  const metrics: Omit<TrialMetrics, 'pass' | 'failures'> = {
    furnitureMaxPenetrationEnd: end.furniturePen,
    furnitureMaxPenetrationDescent: Math.max(0, ...descent.map((m) => m.furniturePen)),
    selfPenetrationMax: Math.max(0, ...window.map((m) => m.selfPen)),
    selfPenPair: selfWorst.selfPen > 0 ? selfWorst.selfPenPair : null,
    rawFurnitureEnd: rawEnd.furniturePen,
    rawSelfPen: rawSelfWorst.selfPen,
    rawSelfPenPair: rawSelfWorst.selfPen > 0 ? rawSelfWorst.selfPenPair : null,
    rawHingeMaxDeg: rawHinge?.excessDeg ?? 0,
    rawHingeJoint: rawHinge?.joint ?? null,
    rawHingeComponent: rawHinge?.component ?? null,
    seatGap: end.seatGap,
    pelvisToSitPoint: end.pelvisToSit,
    footFloorError: Math.max(Math.abs(end.sole[0]), Math.abs(end.sole[1])),
    feetInFrontOfSeat: end.ankleAlong.every((along) => along > input.frontEdge),
    shapeChangeMeanDeg: shape.mean,
    shapeChangeMaxDeg: shape.max,
    translationUsed: last(input.translation),
    hingeBreaks: hinge,
    jerkPeak: jerkPeak(
      measures.map((m) => m.hips),
      from,
      fps,
    ),
    jerkPeakRaw: jerkPeak(input.rawHips, from, fps),
    settleTimeS: settleTime(final, input.motionEndFrame, fps),
    footSlideDescent: footSlide(measures, from, input.motionEndFrame),
    extraModelCalls: input.extraModelCalls,
    computeMs: input.computeMs,
  };

  const checks: Array<[string, boolean]> = [
    ['furnitureMaxPenetrationEnd', metrics.furnitureMaxPenetrationEnd < PASS_LIMITS.furnitureEnd],
    ['selfPenetrationMax', metrics.selfPenetrationMax < PASS_LIMITS.selfPenetration],
    ['seatGap', Math.abs(metrics.seatGap) <= PASS_LIMITS.seatGap],
    ['pelvisToSitPoint', metrics.pelvisToSitPoint <= PASS_LIMITS.pelvisToSit],
    ['footFloorError', metrics.footFloorError <= PASS_LIMITS.footFloor],
    ['feetInFrontOfSeat', metrics.feetInFrontOfSeat],
    ['hingeBreaks', metrics.hingeBreaks.count === 0],
  ];
  const failures = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return { ...metrics, pass: failures.length === 0, failures };
}
