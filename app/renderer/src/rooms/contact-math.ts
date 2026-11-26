import * as THREE from 'three';

/**
 * Pure helpers for the kinematic contact solver (contact-body.ts): the smallest rotation that pushes a
 * limb out of furniture, joint limits, two-bone IK and the easing that blends corrections in and out.
 * Everything writes into caller-owned outputs so the per-frame path allocates nothing.
 */

/** Overlaps shallower than this (metres) are left alone; it stops the solver chattering on touching surfaces. */
export const CONTACT_TOLERANCE = 0.005;
/** Corrections smaller than this angle (radians) count as "no contact" for blending. */
export const MIN_CORRECTION_ANGLE = 1e-4;
/** A correction weight below this is snapped to zero so a released bone goes back to exactly its animated pose. */
export const WEIGHT_EPSILON = 0.002;

export const KNEE_MAX_FLEXION = (150 * Math.PI) / 180;
export const HINGE_MIN = 0;
export const HIP_CONE = (120 * Math.PI) / 180;
export const SHOULDER_CONE = (120 * Math.PI) / 180;
export const WRIST_CONE = (60 * Math.PI) / 180;
export const ANKLE_CONE = (60 * Math.PI) / 180;

/**
 * The most the solver may rotate a joint away from its animated local rotation (radians). The solver nudges
 * limbs, it never re-poses them; whatever a cap refuses is a miss. Applies on top of the anatomical limits.
 */
export const HIP_MAX_OFFSET = (25 * Math.PI) / 180;
export const KNEE_MAX_OFFSET = (30 * Math.PI) / 180;
export const ANKLE_MAX_OFFSET = (20 * Math.PI) / 180;
export const SHOULDER_MAX_OFFSET = (30 * Math.PI) / 180;
export const ELBOW_MAX_OFFSET = (30 * Math.PI) / 180;
export const WRIST_MAX_OFFSET = (20 * Math.PI) / 180;
/**
 * While seated on a seat, a hip may flex (thigh rising, knee up and forward) this far from its animated
 * rotation, so a thigh sloping into the cushion can clear it. Every other direction keeps HIP_MAX_OFFSET.
 */
export const HIP_FLEXION_MAX_OFFSET = (45 * Math.PI) / 180;
/** Seated head settle: neck and head together may turn this far from straight ahead (radians) before they are eased back. */
export const HEAD_YAW_LIMIT = (35 * Math.PI) / 180;
export const HEAD_PITCH_LIMIT = (25 * Math.PI) / 180;
export const HEAD_ROLL_LIMIT = (15 * Math.PI) / 180;
/** About how long the excess takes to ease away (seconds). */
export const HEAD_SETTLE_SECONDS = 0.8;
/** The target correction of a joint may grow by at most this per second (radians), so one bad frame cannot fling a limb. */
export const MAX_OFFSET_RATE = (90 * Math.PI) / 180;

const TMP_Q = new THREE.Quaternion();
const TMP_Q2 = new THREE.Quaternion();
const TMP_V = new THREE.Vector3();
const TMP_W = new THREE.Vector3();

/** Signed rotation (radians, -PI..PI) of `q` about the unit `axis`: the twist part of its swing-twist split. */
export function hingeAngle(q: THREE.Quaternion, axis: THREE.Vector3): number {
  const along = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  let angle = 2 * Math.atan2(along, q.w);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  else if (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

/**
 * Keeps only the rotation of `offset` about `axis` (a hinge cannot swing sideways). Writes to `out`;
 * `out` may be `offset`.
 */
export function projectToHinge(offset: THREE.Quaternion, axis: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromAxisAngle(axis, hingeAngle(offset, axis));
}

/**
 * Limits the hinge angle of `total` (the joint's whole local rotation) to [min, max]. The range is widened
 * to include the angle `animated` already has, so a pose the animation put past a limit is left as it is
 * rather than being pulled in. The swing part is untouched. Returns the clamped rotation in `out`.
 */
export function clampHinge(
  total: THREE.Quaternion,
  axis: THREE.Vector3,
  min: number,
  max: number,
  animatedAngle: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const angle = hingeAngle(total, axis);
  const lo = Math.min(min, animatedAngle);
  const hi = Math.max(max, animatedAngle);
  const clamped = Math.min(hi, Math.max(lo, angle));
  if (clamped === angle) return out.copy(total);
  // Rotating about the hinge axis by the difference only changes the twist angle.
  TMP_Q.setFromAxisAngle(axis, clamped - angle);
  return out.copy(total).premultiply(TMP_Q);
}

/** Limits the angle of `total` from rest (identity) to `max`, widened to `animatedAngle`; shrinks it along its own axis. */
export function clampCone(total: THREE.Quaternion, max: number, animatedAngle: number, out: THREE.Quaternion): THREE.Quaternion {
  const limit = Math.max(max, animatedAngle);
  const w = Math.min(1, Math.abs(total.w));
  const angle = 2 * Math.acos(w);
  if (angle <= limit) return out.copy(total);
  // `out` may be `total`: take a copy before overwriting it.
  TMP_Q2.copy(total);
  return out.identity().slerp(TMP_Q2, limit / angle);
}

/** Angle of a rotation from identity, 0..PI. */
export function rotationAngle(q: THREE.Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

/**
 * Two-bone IK. Puts the end of a two-segment limb (lengths `l1` from `root` to the middle joint and `l2`
 * on to the end) as close to `target` as it can reach, bending towards `pole` (a direction from the root,
 * the animated middle joint's). Writes the middle joint to `outMid` and the end to `outEnd`. Returns true
 * when the target is reachable; otherwise the limb is stretched straight towards it.
 */
export function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  l1: number,
  l2: number,
  outMid: THREE.Vector3,
  outEnd: THREE.Vector3,
): boolean {
  TMP_V.subVectors(target, root);
  const wanted = TMP_V.length();
  if (wanted < 1e-6) {
    outMid.copy(pole).normalize().multiplyScalar(l1).add(root);
    outEnd.copy(root);
    return false;
  }
  const reach = Math.min(wanted, l1 + l2 - 1e-6);
  const minReach = Math.abs(l1 - l2) + 1e-6;
  const distance = Math.max(reach, minReach);
  TMP_V.multiplyScalar(1 / wanted);
  const along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  // The bend direction is the pole with its component along the limb taken out.
  TMP_W.copy(pole).addScaledVector(TMP_V, -pole.dot(TMP_V));
  if (TMP_W.lengthSq() < 1e-10) {
    TMP_W.set(0, 0, 1).addScaledVector(TMP_V, -TMP_V.z);
    if (TMP_W.lengthSq() < 1e-10) TMP_W.set(1, 0, 0);
  }
  TMP_W.normalize();
  outMid.copy(root).addScaledVector(TMP_V, along).addScaledVector(TMP_W, height);
  outEnd.copy(root).addScaledVector(TMP_V, distance);
  return wanted <= l1 + l2 && wanted >= minReach;
}

/** Moves `current` towards `target` with an exponential ease of time constant `tau` seconds. */
export function easeTowards(current: number, target: number, deltaSeconds: number, tau: number, epsilon = WEIGHT_EPSILON): number {
  const next = current + (target - current) * (1 - Math.exp(-Math.max(0, deltaSeconds) / tau));
  return Math.abs(target - next) < epsilon ? target : next;
}

/** State of a critically damped spring. */
export interface Spring {
  value: number;
  velocity: number;
}

/**
 * Critically damped spring step towards `target`: reaches it in about `smoothTime` seconds with no
 * overshoot (the usual "smooth damp"). Snaps once both distance and speed are negligible.
 */
export function stepSpring(spring: Spring, target: number, deltaSeconds: number, smoothTime: number, epsilon = 0.0005): void {
  const dt = Math.max(0, deltaSeconds);
  if (dt === 0) return;
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = spring.value - target;
  const temp = (spring.velocity + omega * change) * dt;
  spring.velocity = (spring.velocity - omega * temp) * decay;
  spring.value = target + (change + temp) * decay;
  if (Math.abs(spring.value - target) < epsilon && Math.abs(spring.velocity) < epsilon) {
    spring.value = target;
    spring.velocity = 0;
  }
}

const TMP_SWING = new THREE.Quaternion();
const TMP_TWIST = new THREE.Quaternion();
const TMP_EULER = new THREE.Euler();

/**
 * Caps a joint offset by direction. `offset` is split about the unit `axis` into a twist (rotation about the
 * axis) and the rest. A twist in the negative direction (flexion for a leg whose hip axis is the body's
 * lateral axis, where a negative turn raises the knee) may reach `flexionMax`; a positive twist and the rest
 * (abduction, adduction, rotation about the leg) may only reach `otherMax`. Writes the result to `out` (which
 * may be `offset`) and returns true when anything was cut.
 */
export function capDirectional(
  offset: THREE.Quaternion,
  axis: THREE.Vector3,
  flexionMax: number,
  otherMax: number,
  out: THREE.Quaternion,
): boolean {
  const angle = hingeAngle(offset, axis);
  TMP_TWIST.setFromAxisAngle(axis, angle);
  TMP_SWING.copy(offset).multiply(TMP_Q2.copy(TMP_TWIST).invert());
  if (TMP_SWING.w < 0) TMP_SWING.set(-TMP_SWING.x, -TMP_SWING.y, -TMP_SWING.z, -TMP_SWING.w);
  const twistLimit = angle < 0 ? flexionMax : otherMax;
  let cut = false;
  let twist = angle;
  if (Math.abs(angle) > twistLimit) {
    twist = Math.sign(angle) * twistLimit;
    cut = true;
  }
  const swingAngle = rotationAngle(TMP_SWING);
  if (swingAngle > otherMax) {
    TMP_Q1.identity().slerp(TMP_SWING, otherMax / swingAngle);
    TMP_SWING.copy(TMP_Q1);
    cut = true;
  }
  if (!cut) return false;
  TMP_TWIST.setFromAxisAngle(axis, twist);
  out.copy(TMP_SWING).multiply(TMP_TWIST);
  return true;
}

const TMP_Q1 = new THREE.Quaternion();

/** A head turned further than this from the hips' forward is a broken pose, not a turn to limit (radians). */
export const HEAD_IMPLAUSIBLE_YAW = (90 * Math.PI) / 180;
export const HEAD_IMPLAUSIBLE_PITCH = (60 * Math.PI) / 180;

/** What headExcessCorrection saw: the measured angles (radians) and whether it took the pose for broken. */
export interface HeadAngles {
  yaw: number;
  pitch: number;
  roll: number;
  reset: boolean;
}

/**
 * The rotation that brings a head orientation (neck and head together, relative to the hips) back inside the
 * yaw, pitch and roll limits, taking only the excess off each angle. A pose past HEAD_IMPLAUSIBLE_YAW or
 * HEAD_IMPLAUSIBLE_PITCH is a broken motion frame: the target is then straight ahead, not the edge of the
 * limit. Writes the correction (in the same frame `combined` is measured in; identity when inside the limits)
 * to `out` and returns true when there is any. `seen`, when given, receives the measured angles.
 */
export function headExcessCorrection(
  combined: THREE.Quaternion,
  yawLimit: number,
  pitchLimit: number,
  rollLimit: number,
  out: THREE.Quaternion,
  seen?: HeadAngles,
): boolean {
  TMP_EULER.setFromQuaternion(combined, 'YXZ');
  const reset = Math.abs(TMP_EULER.y) > HEAD_IMPLAUSIBLE_YAW || Math.abs(TMP_EULER.x) > HEAD_IMPLAUSIBLE_PITCH;
  if (seen) {
    seen.yaw = TMP_EULER.y;
    seen.pitch = TMP_EULER.x;
    seen.roll = TMP_EULER.z;
    seen.reset = reset;
  }
  const yaw = reset ? 0 : Math.max(-yawLimit, Math.min(yawLimit, TMP_EULER.y));
  const pitch = reset ? 0 : Math.max(-pitchLimit, Math.min(pitchLimit, TMP_EULER.x));
  const roll = reset ? 0 : Math.max(-rollLimit, Math.min(rollLimit, TMP_EULER.z));
  if (yaw === TMP_EULER.y && pitch === TMP_EULER.x && roll === TMP_EULER.z) {
    out.identity();
    return false;
  }
  TMP_EULER.set(pitch, yaw, roll, 'YXZ');
  TMP_Q1.setFromEuler(TMP_EULER);
  // corrected = correction * combined
  out.copy(TMP_Q1).multiply(TMP_SWING.copy(combined).invert());
  return true;
}

/**
 * `q` turned by the fraction `t` of its angle, keeping the sign of `q` (so a w < 0 quaternion goes the long way).
 * Unlike slerp from identity it does not pick the short way itself, which would flip the direction frame to
 * frame when a correction sits near 180 degrees; the caller keeps the sign consistent instead.
 */
export function scaleRotation(q: THREE.Quaternion, t: number, out: THREE.Quaternion): THREE.Quaternion {
  const w = Math.max(-1, Math.min(1, q.w));
  const s = Math.sqrt(1 - w * w);
  if (s < 1e-9) return out.identity();
  const half = Math.acos(w) * t;
  const k = Math.sin(half) / s;
  return out.set(q.x * k, q.y * k, q.z * k, Math.cos(half));
}
