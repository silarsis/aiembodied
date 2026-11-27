/**
 * Plain-array maths for the sit lab: rotation angles, swing/twist, segment distances and small helpers.
 * Quaternions are [x, y, z, w]; angles are degrees unless a name says otherwise.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const DEG = 180 / Math.PI;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** 0 at `x <= 0`, 1 at `x >= 1`, eased between. */
export function smoothstep(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quatNormalize(q: Quat): Quat {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return length < 1e-12
    ? [0, 0, 0, 1]
    : [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function quatInverse(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Rotation of `radians` about the unit axis `axis`. */
function quatFromAxisAngle(axis: Vec3, radians: number): Quat {
  const half = radians / 2;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/** The rotation vector (axis times angle, radians) of a rotation, taking the short way round. */
function quatToRotationVector(q: Quat): Vec3 {
  const sign = q[3] < 0 ? -1 : 1;
  const x = sign * q[0];
  const y = sign * q[1];
  const z = sign * q[2];
  const w = sign * q[3];
  const sine = Math.hypot(x, y, z);
  if (sine < 1e-12) return [0, 0, 0];
  const scale = (2 * Math.atan2(sine, w)) / sine;
  return [x * scale, y * scale, z * scale];
}

export function rotationVectorToQuat(v: Vec3): Quat {
  const angle = Math.hypot(v[0], v[1], v[2]);
  if (angle < 1e-12) return [0, 0, 0, 1];
  return quatFromAxisAngle([v[0] / angle, v[1] / angle, v[2] / angle], angle);
}

/** Angle of the rotation that takes `a` to `b`, 0..180 degrees. */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot)) * DEG;
}

/** The rotation with its turn about the vertical (Y) axis taken off the outside: q = Ry(yaw) * rest, returns rest. */
function removeYaw(q: Quat): Quat {
  const yaw = 2 * Math.atan2(q[1], q[3]);
  return quatNormalize(quatMultiply(quatFromAxisAngle([0, 1, 0], -yaw), q));
}

/** Angle between two rotations once each has had its yaw taken off (the hips' own turn is not shape). */
export function quatAngleIgnoringYawDeg(a: Quat, b: Quat): number {
  return quatAngleDeg(removeYaw(a), removeYaw(b));
}

/**
 * Splits `q` into twist about the axis `twistAxis` (0 = X, 1 = Y, 2 = Z) and the swing that is left, as
 * q = swing * twist (the order the app's joint limits use). `twistDeg` is signed, `swing` is a rotation vector in radians.
 */
export function swingTwist(q: Quat, twistAxis: 0 | 1 | 2): { twistDeg: number; swing: Vec3 } {
  const flip = q[3] < 0 ? -1 : 1;
  const w = flip * q[3];
  const component = flip * q[twistAxis];
  const half = Math.atan2(component, w);
  const twist: Quat = [0, 0, 0, Math.cos(half)];
  twist[twistAxis] = Math.sin(half);
  const swing = quatMultiply([flip * q[0], flip * q[1], flip * q[2], w], quatInverse(twist));
  return { twistDeg: 2 * half * DEG, swing: quatToRotationVector(swing) };
}

export function normalizeVec(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length < 1e-12 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}

export const vecSub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vecAdd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vecScale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const vecDot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vecLength = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Smallest distance between segment p0-p1 and segment q0-q1 (Ericson, Real-Time Collision Detection 5.1.9). */
export function segmentDistance(p0: Vec3, p1: Vec3, q0: Vec3, q1: Vec3): number {
  const d1 = vecSub(p1, p0);
  const d2 = vecSub(q1, q0);
  const r = vecSub(p0, q0);
  const a = vecDot(d1, d1);
  const e = vecDot(d2, d2);
  const f = vecDot(d2, r);
  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) return vecLength(r);
  if (a <= 1e-12) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = vecDot(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = vecDot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  return vecLength(vecSub(vecAdd(p0, vecScale(d1, s)), vecAdd(q0, vecScale(d2, t))));
}
