import type { AvatarMotionEndPose } from '../avatar/types.js';

/** The avatar's root on the floor in world space. `yaw` is radians; facing is (sin yaw, cos yaw). */
export interface RootPose {
  x: number;
  z: number;
  yaw: number;
}

/**
 * Where a motion stream started: the root pose when it began, and the world metres per avatar
 * metre (the avatar scene's scale). The motion service works in the avatar's own metres, with
 * the origin under the hips, facing +Z, so every world point is translated, rotated by -yaw and
 * divided by `scale` on the way out, and the other way round on the way back.
 */
export interface MotionFrame {
  origin: RootPose;
  scale: number;
}

export function wrapRadians(angle: number): number {
  const wrapped = (((angle + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return wrapped - Math.PI;
}

export const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;

/** World yaw of the direction from one floor point to another. */
export function yawToward(from: readonly [number, number, number], to: readonly [number, number, number]): number {
  return Math.atan2(to[0] - from[0], to[2] - from[2]);
}

export function worldToMotion(frame: MotionFrame, x: number, z: number): [number, number] {
  const { origin, scale } = frame;
  const dx = x - origin.x;
  const dz = z - origin.z;
  const cos = Math.cos(origin.yaw);
  const sin = Math.sin(origin.yaw);
  return [(dx * cos - dz * sin) / scale, (dx * sin + dz * cos) / scale];
}

export function motionToWorld(frame: MotionFrame, mx: number, mz: number): [number, number] {
  const { origin, scale } = frame;
  const cos = Math.cos(origin.yaw);
  const sin = Math.sin(origin.yaw);
  return [origin.x + scale * (mx * cos + mz * sin), origin.z + scale * (-mx * sin + mz * cos)];
}

export function worldYawToMotion(frame: MotionFrame, yaw: number): number {
  return wrapRadians(yaw - frame.origin.yaw);
}

export function motionYawToWorld(frame: MotionFrame, heading: number): number {
  return wrapRadians(frame.origin.yaw + heading);
}

/** World height in metres to the avatar's own metres. */
export function heightToMotion(frame: MotionFrame, y: number): number {
  return y / frame.scale;
}

/**
 * The root transform to bake once a stream has finished playing: the pelvis position and heading of
 * its last frame, back in the world. The hips then stay at the local origin and the standing pose
 * takes over, so nothing visibly moves.
 */
export function bakedRootPose(frame: MotionFrame, endPose: Pick<AvatarMotionEndPose, 'root' | 'heading'>): RootPose {
  const [x, z] = motionToWorld(frame, endPose.root[0], endPose.root[1]);
  return { x, z, yaw: motionYawToWorld(frame, endPose.heading) };
}

/** World position of a point given in the motion frame (x, height above the floor, z). */
export function motionPointToWorld(frame: MotionFrame, p: readonly [number, number, number]): [number, number, number] {
  const [x, z] = motionToWorld(frame, p[0], p[2]);
  return [x, p[1] * frame.scale, z];
}
