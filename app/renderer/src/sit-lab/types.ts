import type { RoomFile } from '../../../main/src/shared/rooms/types.js';
import type { Quat, Vec3 } from './pose-math.js';

/** The motion model's frame rate; the lab steps at exactly this rate. */
export const FPS = 30;
export const STEP_S = 1 / FPS;
/** Seconds the last pose is held after the motion ends, to see whether the body settles. */
export const SETTLE_S = 1.5;

/** Local rotation of every tracked bone plus the hips' local position (normalised-scene metres, before the root scale). */
export interface Pose {
  bones: Record<string, Quat>;
  hips: Vec3;
}

export interface StartSpec {
  x: number;
  z: number;
  /** World heading in degrees; 0 faces +Z, 90 faces +X. */
  heading: number;
}

export interface LabSpec {
  roomJson: RoomFile;
  /** URL of the VRM file. */
  avatarUrl: string;
  /** Base URL of the motion service. */
  motionUrl?: string;
  seatObjectId: string;
  start: StartSpec;
}

export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;

export interface TrialSpec {
  /** Method id, see methods/index.ts. */
  method: string;
  params?: Params;
  /** Seeds the motion model for this trial. */
  seed: number;
  /** Replaces the sit prompt of the plan. */
  prompt?: string;
  /** Replaces the spec's start for this trial. */
  start?: StartSpec;
  /** False drops the knee and ankle targets the app plans for the sit (default true, as the app sends them). */
  jointTargets?: boolean;
}

export type ViewName = 'front' | 'side' | 'threeQuarter' | 'room';
