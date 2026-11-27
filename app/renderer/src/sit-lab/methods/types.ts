import type { StreamRequestPlan, RestLegLengths } from '../../rooms/scene-actions.js';
import type { Destination } from '../destination.js';
import type { LabRig } from '../lab-rig.js';
import type { Colliders, FrameMeasure } from '../measure.js';
import type { MotionStream, MotionTracks } from '../motion-source.js';
import type { Params, ParamValue, Pose } from '../types.js';
import type { MotionFrame } from '../../rooms/scene-frames.js';

/** One tunable value of a method: its default and the range it may be set within. */
export interface ParamSpec {
  name: string;
  doc: string;
  default: ParamValue;
  /** Numbers only. */
  min?: number;
  max?: number;
  /** Strings only. */
  options?: readonly string[];
}

/** What the motion model produced for one request: poses on the lab's frame grid, in the rig's own bone space. */
export interface MotionClip {
  poses: Pose[];
  tracks: MotionTracks;
  stream: MotionStream;
  request: StreamRequestPlan;
}

/** The motion a method settled on for the trial, and what it cost to get it. */
export interface Planned {
  motion: MotionClip;
}

/**
 * Per-frame post-processing. The trial writes the model's raw pose for a frame, then calls `frame`, which may change
 * bones, the hips and the root through the rig. With `appPipeline` the trial also runs the app's own seat fit,
 * contact solver and joint limits around it.
 */
export interface Corrector {
  appPipeline: boolean;
  frame(index: number, timeS: number): void;
  /** What the method found that the metrics alone do not show, written to the trial's JSON. */
  report?: Record<string, number | boolean | string | number[]>;
}

export interface MethodContext {
  rig: LabRig;
  dest: Destination;
  legs: RestLegLengths | null;
  /** Half the distance between the hip joints, metres in the world. */
  hipHalfSpacing: number;
  frame: MotionFrame;
  /** The plan the app makes for this sit (its request is what the baseline sends). */
  baseRequest: StreamRequestPlan;
  /** Seconds into the motion at which the sit phase begins. */
  sitStartS: number;
  seed: number;
  /** The room's colliders; null when its physics did not start. */
  colliders: Colliders | null;
  /** Measures the avatar as it stands in the rig now (the caller sets the pose and the root first). */
  measure(): FrameMeasure;
  /** Asks the motion model; every call is counted as a model call. */
  generate(request: StreamRequestPlan, seed: number): Promise<MotionClip>;
  /** The model's motion with a continuation appended (landThenSettle). */
  generateContinuation(
    base: MotionClip,
    request: StreamRequestPlan,
    seed: number,
  ): Promise<MotionClip>;
  /** Runs `fn` and adds its time to the method's compute time. */
  timed<T>(fn: () => T): T;
}

export interface Method {
  id: string;
  label: string;
  params: readonly ParamSpec[];
  /** Asks the model for the motion; the default is the app's own request. */
  plan?(ctx: MethodContext, params: Params): Promise<Planned>;
  /** Builds the per-frame correction for the planned motion; the default does nothing. */
  correct?(ctx: MethodContext, motion: MotionClip, params: Params): Corrector;
}

/** `given` checked against the specs: unknown names, wrong types and values out of range are errors. */
export function resolveParams(specs: readonly ParamSpec[], given: Params, label: string): Params {
  const known = new Set(specs.map((spec) => spec.name));
  for (const name of Object.keys(given)) {
    if (!known.has(name)) throw new Error(`${label}: unknown parameter ${name}`);
  }
  const resolved: Params = {};
  for (const spec of specs) {
    const value = given[spec.name] ?? spec.default;
    if (typeof spec.default === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label}: ${spec.name} must be a number`);
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new Error(`${label}: ${spec.name} ${value} is below its minimum ${spec.min}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new Error(`${label}: ${spec.name} ${value} is above its maximum ${spec.max}`);
      }
    } else if (spec.options && (typeof value !== 'string' || !spec.options.includes(value))) {
      throw new Error(`${label}: ${spec.name} must be one of ${spec.options.join(', ')}`);
    }
    resolved[spec.name] = value;
  }
  return resolved;
}

export function numberParam(params: Params, name: string): number {
  const value = params[name];
  if (typeof value !== 'number') throw new Error(`parameter ${name} is not a number`);
  return value;
}

export function stringParam(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== 'string') throw new Error(`parameter ${name} is not a string`);
  return value;
}
