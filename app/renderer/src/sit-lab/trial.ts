import type { PlanWorld } from '../rooms/scene-actions.js';
import { INITIAL_STATE, planAction, type PlannedStream } from '../rooms/scene-actions.js';
import { destinationFor, horizontalDistance, type Destination } from './destination.js';
import { evaluateRawPoses } from './raw-poses.js';
import { FrameMeasurer, type FrameMeasure } from './measure.js';
import { computeMetrics, type TrialMetrics } from './metrics.js';
import { appendTracks, requestMotion, toWire, tracksFromChunks } from './motion-source.js';
import { quatAngleDeg, vecLength, vecSub, type Vec3 } from './pose-math.js';
import { withSitPrompt } from './methods/best-of-n.js';
import { findMethod } from './methods/index.js';
import { resolveParams, type MethodContext, type MotionClip } from './methods/types.js';
import {
  FPS,
  SETTLE_S,
  STEP_S,
  type LabSpec,
  type Params,
  type Pose,
  type TrialSpec,
  type ViewName,
} from './types.js';
import type { LabWorld } from './lab-world.js';

const DEFAULT_MOTION_URL = 'http://127.0.0.1:8190';
/** Frames of the sit phase that are photographed from the three-quarter view. */
const SIT_SHOTS = 5;
const VIEW_DISTANCE = 2.4;
/** How far inside the walls a close-up camera stays. */
const WALL_MARGIN = 0.15;
const MAX_VIEW_FOV = 100;
/** A joint the app's limits turned by less than this (degrees) is not reported. */
const CLAMP_REPORT_DEG = 0.1;

interface TrialCaptures {
  final: Record<ViewName, string>;
  sit: string[];
}

export interface TrialResult {
  method: string;
  params: Params;
  seed: number;
  prompt: string | null;
  start: { x: number; z: number; heading: number };
  label: string;
  metrics: TrialMetrics;
  timeline: {
    fps: number;
    frames: number;
    sitStartFrame: number;
    motionEndFrame: number;
    sitShotFrames: number[];
  };
  destination: Destination;
  /** The request the first model call sent. */
  request: Record<string, unknown>;
  modelCalls: number;
  modelMs: number;
  notes: string[];
  /** What the method reports about itself (for example that it could not clear the furniture), or null. */
  methodReport: Record<string, number | boolean | string | number[]> | null;
  /** Joints the app's joint limits turned at the end pose, and by how many degrees. */
  limitClamps: Array<{ joint: string; deg: number }>;
  poses: { raw: Pose[]; final: Pose[]; rootShift: Vec3[] };
  captures: TrialCaptures;
}

/** How far from `focus` a camera can go along `direction` before it reaches the room's walls (room centred on 0,0). */
function roomToWall(
  shell: { width: number; depth: number },
  focus: Vec3,
  direction: [number, number],
): number {
  const limit = (position: number, step: number, half: number): number =>
    step === 0 ? Infinity : ((step > 0 ? half : -half) - position) / step;
  return Math.min(
    VIEW_DISTANCE,
    limit(focus[0], direction[0], shell.width / 2 - WALL_MARGIN),
    limit(focus[2], direction[1], shell.depth / 2 - WALL_MARGIN),
  );
}

/**
 * Where the camera stands for a named view, around `focus` (a seated pelvis), and where it looks. A seat near a wall
 * would put the camera outside the room, so the side views take whichever side has more room, and the camera moves
 * in, widening its lens to keep the framing.
 */
function viewCamera(
  world: LabWorld,
  dest: Destination,
  view: ViewName,
  focus: Vec3,
): { position: Vec3; target: Vec3; fov: number } {
  const room = world.stage.room.camera;
  if (view === 'room') return { position: room.position, target: room.target, fov: room.fov };
  const [fx, fz] = dest.forward;
  const [lx, lz] = dest.left;
  const candidates: [number, number][] =
    view === 'front'
      ? [[fx, fz]]
      : view === 'side'
        ? [
            [lx, lz],
            [-lx, -lz],
          ]
        : [
            [(fx + lx) / Math.SQRT2, (fz + lz) / Math.SQRT2],
            [(fx - lx) / Math.SQRT2, (fz - lz) / Math.SQRT2],
          ];
  const shell = world.stage.room.shell;
  const [direction, distance] = candidates
    .map((d): [[number, number], number] => [d, roomToWall(shell, focus, d)])
    .reduce((best, next) => (next[1] > best[1] + 1e-6 ? next : best));
  const halfFov = (room.fov * Math.PI) / 360;
  const fov = Math.min(
    MAX_VIEW_FOV,
    (Math.atan((Math.tan(halfFov) * VIEW_DISTANCE) / distance) * 360) / Math.PI,
  );
  return {
    position: [
      focus[0] + direction[0] * distance,
      focus[1] + 0.35,
      focus[2] + direction[1] * distance,
    ],
    target: [focus[0], focus[1] + 0.1, focus[2]],
    fov,
  };
}

/** Renders the current state from a view and returns it as a PNG data URL. */
export function captureView(world: LabWorld, dest: Destination, view: ViewName): string {
  world.rig.updateWorld();
  const camera = viewCamera(world, dest, view, world.rig.world('hips'));
  world.camera.position.set(...camera.position);
  world.camera.fov = camera.fov;
  world.camera.lookAt(...camera.target);
  world.camera.updateProjectionMatrix();
  world.render();
  return world.renderer.domElement.toDataURL('image/png');
}

function hipHalfSpacing(world: LabWorld): number {
  world.rig.updateWorld();
  const left = world.rig.world('leftUpperLeg');
  const right = world.rig.world('rightUpperLeg');
  return horizontalDistance(left, right) / 2;
}

function plannedSit(world: LabWorld, seatId: string): { stream: PlannedStream; plan: PlanWorld } {
  const plan = world.planWorld();
  const action = planAction(plan, INITIAL_STATE, { kind: 'sit', objectId: seatId });
  if (action.type === 'skip') throw new Error(`The app would not plan this sit: ${action.reason}`);
  if (action.type === 'insert')
    throw new Error('The app wants to do something else before sitting.');
  return { stream: action.stream, plan };
}

export async function runTrial(
  world: LabWorld,
  spec: LabSpec,
  trial: TrialSpec,
): Promise<TrialResult> {
  const method = findMethod(trial.method);
  const params = resolveParams(method.params, trial.params ?? {}, method.id);
  const start = trial.start ?? spec.start;
  const motionUrl = spec.motionUrl ?? DEFAULT_MOTION_URL;
  world.placeAt(start);
  const { stream: planned, plan } = plannedSit(world, spec.seatObjectId);
  const dest = destinationFor(plan, spec.seatObjectId);
  const { rig } = world;
  const sitStartS = planned.request.phases?.[0]?.startS ?? 0;
  const baseRequest = trial.prompt ? withSitPrompt(planned.request, trial.prompt) : planned.request;
  const measurer = new FrameMeasurer(
    rig,
    dest,
    {
      colliders: world.stage.collision,
      surfaceAt: (x, z) => world.stage.surfaceHeightAt(spec.seatObjectId, x, z, dest.sitPoint[1]),
    },
    plan.restLegLengths ?? null,
    world.restOverlaps,
  );

  let modelCalls = 0;
  let modelMs = 0;
  let computeMs = 0;
  const sent: Array<Record<string, unknown>> = [];
  const evaluate = (tracks: MotionClip['tracks']) => {
    rig.writePose(world.neutralPose());
    return evaluateRawPoses(world.vrm, rig, tracks);
  };
  const ask = async (request: MotionClip['request'], seed: number) => {
    const wire = toWire(request, world.restSkeleton, seed);
    sent.push(wire);
    const stream = await requestMotion(motionUrl, wire);
    modelCalls += 1;
    modelMs += stream.requestMs;
    return stream;
  };
  const ctx: MethodContext = {
    rig,
    dest,
    legs: plan.restLegLengths ?? null,
    hipHalfSpacing: hipHalfSpacing(world),
    frame: plan.frame,
    baseRequest,
    sitStartS,
    seed: trial.seed,
    colliders: world.stage.collision,
    measure: () => measurer.measure(),
    generate: async (request, seed) => {
      const stream = await ask(request, seed);
      const tracks = tracksFromChunks(stream.chunks);
      return { poses: evaluate(tracks), tracks, stream, request };
    },
    generateContinuation: async (base, request, seed) => {
      const stream = await ask(request, seed);
      const tracks = appendTracks(base.tracks, tracksFromChunks(stream.chunks));
      return { poses: evaluate(tracks), tracks, stream, request };
    },
    timed: (fn) => {
      const began = performance.now();
      try {
        return fn();
      } finally {
        computeMs += performance.now() - began;
      }
    },
  };

  const planStep = method.plan
    ? await method.plan(ctx, params)
    : { motion: await ctx.generate(baseRequest, trial.seed) };
  const motion = planStep.motion;
  const corrector = method.correct
    ? method.correct(ctx, motion, params)
    : { appPipeline: false, frame: () => undefined };

  // -- Play the frames, one fixed step each -------------------------------------------------------
  const env = world.controller.sceneEnv;
  const motionFrames = motion.poses.length;
  const total = motionFrames + Math.ceil(SETTLE_S * FPS);
  const sitStartFrame = Math.round(sitStartS * FPS);
  const motionEndFrame = motionFrames - 1;
  const sitShotFrames = Array.from({ length: SIT_SHOTS }, (_, k) =>
    Math.round(sitStartFrame + ((motionEndFrame - sitStartFrame) * k) / (SIT_SHOTS - 1)),
  );
  rig.placeRoot([0, 0, 0]);
  if (corrector.appPipeline) {
    env.approachSeat(spec.seatObjectId);
    env.setStreamPlaying(true);
  }
  const raw: Pose[] = [];
  const final: Pose[] = [];
  const rootShift: Vec3[] = [];
  const measures: FrameMeasure[] = [];
  const rawHips: Vec3[] = [];
  const translation: number[] = [];
  const sitShots: string[] = [];
  const limitClamps: Array<{ joint: string; deg: number }> = [];
  for (let i = 0; i < total; i += 1) {
    const pose = motion.poses[Math.min(i, motionFrames - 1)];
    if (!pose) throw new Error('The motion has no frames.');
    world.limits.restore();
    rig.writePose(pose);
    if (!corrector.appPipeline) rig.placeRoot([0, 0, 0]);
    if (corrector.appPipeline) {
      if (i === motionFrames) {
        env.setStreamPlaying(false);
        env.setSeat(spec.seatObjectId);
      }
      world.controller.step(STEP_S);
    }
    const began = performance.now();
    corrector.frame(i, i * STEP_S);
    if (corrector.appPipeline) world.controller.solveContact(STEP_S);
    const unlimited = i === total - 1 ? rig.readPose() : null;
    world.limits.apply();
    if (unlimited) {
      const limited = rig.readPose();
      for (const [joint, before] of Object.entries(unlimited.bones)) {
        const after = limited.bones[joint];
        const deg = after ? quatAngleDeg(before, after) : 0;
        if (deg > CLAMP_REPORT_DEG) limitClamps.push({ joint, deg });
      }
    }
    computeMs += performance.now() - began;
    world.vrm.update(STEP_S);
    rig.updateWorld();
    const measure = measurer.measure();
    const rawAt = rig.hipsWorldAtBase(pose.hips);
    raw.push(pose);
    final.push(rig.readPose());
    rootShift.push(rig.rootShift());
    measures.push(measure);
    rawHips.push(rawAt);
    translation.push(vecLength(vecSub(measure.hips, rawAt)));
    if (sitShotFrames.includes(i)) sitShots.push(captureView(world, dest, 'threeQuarter'));
  }
  const finalShots: TrialCaptures['final'] = {
    front: captureView(world, dest, 'front'),
    side: captureView(world, dest, 'side'),
    threeQuarter: captureView(world, dest, 'threeQuarter'),
    room: captureView(world, dest, 'room'),
  };
  const request = sent[0];
  if (!request) throw new Error('The trial made no model call.');

  // The model's own poses with no method and no joint limits, root at its base, for the raw-output metrics.
  const rawMeasures: FrameMeasure[] = [];
  for (let i = Math.max(sitStartFrame, 0); i < raw.length; i += 1) {
    const pose = raw[i];
    if (!pose) continue;
    rig.placeRoot([0, 0, 0]);
    rig.writePose(pose);
    rawMeasures.push(measurer.measure());
  }
  const metrics = computeMetrics({
    fps: FPS,
    measures,
    raw,
    rawMeasures,
    final,
    rawHips,
    translation,
    sitStartFrame,
    motionEndFrame,
    frontEdge: dest.frontEdge,
    extraModelCalls: Math.max(0, modelCalls - 1),
    computeMs,
  });
  const notes: string[] = [];
  if (corrector.appPipeline) notes.push('app pipeline: seat fit, contact solver and joint limits');
  else notes.push('joint limits applied after the method, as the app does');
  if (corrector.report?.infeasible === true) {
    notes.push(`infeasible: ${JSON.stringify(corrector.report)}`);
  }
  return {
    method: method.id,
    params,
    seed: trial.seed,
    prompt: trial.prompt ?? null,
    start,
    label: planned.label,
    metrics,
    timeline: { fps: FPS, frames: total, sitStartFrame, motionEndFrame, sitShotFrames },
    destination: dest,
    request,
    modelCalls,
    modelMs,
    notes,
    methodReport: corrector.report ?? null,
    limitClamps,
    poses: { raw, final, rootShift },
    captures: { final: finalShots, sit: sitShots },
  };
}
