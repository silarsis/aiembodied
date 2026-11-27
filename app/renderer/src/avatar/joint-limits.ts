import * as THREE from 'three';

/**
 * Anatomical joint limits for a VRM's normalized humanoid bones. Whatever wrote the pose (a clip, a pose
 * blend, the room contact solver), no bone leaves the final frame with a rotation a person could not make.
 *
 * Normalized bones have identity rotation at rest, so a bone's local quaternion is its rotation from rest in
 * its parent's frame. Each limit splits that rotation into a twist about the bone's own axis and a swing of
 * that axis, and keeps the twist angle and the swing's two components inside a range (degrees below).
 */

type Axis = 0 | 1 | 2;
interface Range {
  readonly min: number;
  readonly max: number;
}
interface JointSpec {
  readonly twistAxis: Axis;
  readonly twist: Range;
  readonly swingU: Axis;
  readonly u: Range;
  readonly swingV: Axis;
  readonly v: Range;
}

const X: Axis = 0;
const Y: Axis = 1;
const Z: Axis = 2;

const sym = (limit: number): Range => ({ min: -limit, max: limit });
const range = (min: number, max: number): Range => ({ min, max });

/** Twist about Y, swing about X (pitch) and Z (roll): spine, neck, head and legs. */
const alongY = (twist: Range, u: Range, v: Range): JointSpec => ({
  twistAxis: Y,
  twist,
  swingU: X,
  u,
  swingV: Z,
  v,
});
/** Twist about Z (forward), swing about X and Y: feet and toes. */
const alongZ = (twist: Range, u: Range, v: Range): JointSpec => ({
  twistAxis: Z,
  twist,
  swingU: X,
  u,
  swingV: Y,
  v,
});
/** Twist about X (out along the arm), swing about Y and Z. */
const alongX = (twist: Range, u: Range, v: Range): JointSpec => ({
  twistAxis: X,
  twist,
  swingU: Y,
  u,
  swingV: Z,
  v,
});

/**
 * Limits in degrees, by humanoid bone name. Hips (the body's own orientation), eyes, jaw and fingers are
 * not limited. Ranges are in the VRM 1 basis (facing +Z); a VRM 0 model gets them mirrored. The head's 40 degrees plus the neck's 50 keep it within about 125 degrees of yaw from the hips.
 * Hip flexion (knee up) is negative about X and knee flexion (shin back) positive. Arm ranges are generous
 * on the swing side because retargeted clips put the arm's swing axes in less certain places than the twist.
 * The forearm's Z range is wide because the authored base poses (anger) swing it about 106 degrees.
 * An elbow bends about -Y on the left and +Y on the right, the arm raises forward the same way.
 */
const LIMITS: Readonly<Record<string, JointSpec>> = {
  spine: alongY(sym(10), sym(45), sym(25)),
  chest: alongY(sym(15), sym(40), sym(20)),
  upperChest: alongY(sym(10), sym(30), sym(15)),
  neck: alongY(sym(50), sym(40), sym(30)),
  head: alongY(sym(40), sym(40), sym(25)),

  leftUpperLeg: alongY(sym(45), range(-135, 40), sym(55)),
  rightUpperLeg: alongY(sym(45), range(-135, 40), sym(55)),
  leftLowerLeg: alongY(sym(40), range(-10, 160), sym(25)),
  rightLowerLeg: alongY(sym(40), range(-10, 160), sym(25)),
  leftFoot: alongZ(sym(35), sym(60), sym(35)),
  rightFoot: alongZ(sym(35), sym(60), sym(35)),
  leftToes: alongZ(sym(15), sym(60), sym(15)),
  rightToes: alongZ(sym(15), sym(60), sym(15)),

  leftShoulder: alongX(sym(20), sym(30), sym(35)),
  rightShoulder: alongX(sym(20), sym(30), sym(35)),
  leftUpperArm: alongX(sym(100), range(-150, 70), sym(175)),
  rightUpperArm: alongX(sym(100), range(-70, 150), sym(175)),
  leftLowerArm: alongX(sym(120), range(-160, 10), sym(120)),
  rightLowerArm: alongX(sym(120), range(-10, 160), sym(120)),
  leftHand: alongX(sym(45), sym(80), sym(80)),
  rightHand: alongX(sym(45), sym(80), sym(80)),
};

const DEG = Math.PI / 180;
/** Past this twist the sign is ambiguous (+179 and -179 degrees are two degrees apart), so the last side wins. */
const AMBIGUOUS_TWIST = 150 * DEG;
/** A swing of 180 degrees has no axis; capping just short keeps the axis-angle form well defined. */
const MAX_SWING = 175 * DEG;

interface LimitedBone {
  readonly bone: THREE.Object3D;
  readonly spec: JointSpec;
  /** Sign of the twist last seen; 0 until the bone has had one. */
  side: number;
  /** The rotation the bone held before the clamp, and the clamped one we wrote over it. */
  readonly before: THREE.Quaternion;
  readonly written: THREE.Quaternion;
  hasWritten: boolean;
}

const swing = new THREE.Quaternion();
const twist = new THREE.Quaternion();
const vec = [0, 0, 0];
const twistVec = [0, 0, 0];

const clampTo = (value: number, r: Range): number =>
  Math.min(r.max * DEG, Math.max(r.min * DEG, value));

/** A range about X or Z seen in a VRM 0 normalized basis, which faces -Z: those two axes point the other way. */
const mirrorRange = (r: Range, axis: Axis): Range => (axis === Y ? r : range(-r.max, -r.min));

const mirrorSpec = (spec: JointSpec): JointSpec => ({
  ...spec,
  twist: mirrorRange(spec.twist, spec.twistAxis),
  u: mirrorRange(spec.u, spec.swingU),
  v: mirrorRange(spec.v, spec.swingV),
});

export class JointLimits {
  private readonly bones: LimitedBone[] = [];

  /** `vrm0` is true for a VRM 0.x model, whose normalized bones keep that format's mirrored axes. */
  constructor(
    humanoid: { getNormalizedBoneNode(name: string): THREE.Object3D | null | undefined },
    vrm0: boolean,
  ) {
    for (const [name, spec] of Object.entries(LIMITS)) {
      const bone = humanoid.getNormalizedBoneNode(name);
      if (!bone) continue;
      this.bones.push({
        bone,
        spec: vrm0 ? mirrorSpec(spec) : spec,
        side: 0,
        before: new THREE.Quaternion(),
        written: new THREE.Quaternion(),
        hasWritten: false,
      });
    }
  }

  /**
   * Puts back the rotation of every bone clamped last frame, unless something else has rewritten it since.
   * Writers that tell "the mixer rewrote this bone" by comparing with their own last write would otherwise
   * take our clamped value for a new animated pose. Call before anything else touches the bones.
   */
  restore(): void {
    for (const limited of this.bones) {
      if (limited.hasWritten && limited.bone.quaternion.equals(limited.written)) {
        limited.bone.quaternion.copy(limited.before);
      }
      limited.hasWritten = false;
    }
  }

  /** Clamps every limited bone. A bone already inside its ranges is not written. Call last, before `vrm.update`. */
  apply(): void {
    for (const limited of this.bones) this.clamp(limited);
  }

  private clamp(limited: LimitedBone): void {
    const { bone, spec } = limited;
    const q = bone.quaternion;
    const flip = q.w < 0 ? -1 : 1;
    const w = flip * q.w;
    vec[0] = flip * q.x;
    vec[1] = flip * q.y;
    vec[2] = flip * q.z;

    // Twist about the bone's own axis: the part of the rotation's vector along that axis.
    const half = Math.atan2(vec[spec.twistAxis] ?? 0, w);
    let twistAngle = 2 * half;
    twistVec[0] = 0;
    twistVec[1] = 0;
    twistVec[2] = 0;
    twistVec[spec.twistAxis] = Math.sin(half);
    twist.set(twistVec[0] ?? 0, twistVec[1] ?? 0, twistVec[2] ?? 0, Math.cos(half));

    // q = swing * twist, so swing = q * twist^-1.
    swing.set(vec[0] ?? 0, vec[1] ?? 0, vec[2] ?? 0, w).multiply(twist.invert());
    if (swing.w < 0) swing.set(-swing.x, -swing.y, -swing.z, -swing.w);
    const sine = Math.hypot(swing.x, swing.y, swing.z);
    const scale = sine > 1e-9 ? (2 * Math.atan2(sine, swing.w)) / sine : 2;
    vec[0] = swing.x * scale;
    vec[1] = swing.y * scale;
    vec[2] = swing.z * scale;

    if (
      Math.abs(twistAngle) > AMBIGUOUS_TWIST &&
      limited.side !== 0 &&
      twistAngle * limited.side < 0
    ) {
      twistAngle += limited.side * 2 * Math.PI;
    }
    if (Math.abs(twistAngle) > 1e-3) limited.side = Math.sign(twistAngle);

    const clampedTwist = clampTo(twistAngle, spec.twist);
    let u = clampTo(vec[spec.swingU] ?? 0, spec.u);
    let v = clampTo(vec[spec.swingV] ?? 0, spec.v);
    const magnitude = Math.hypot(u, v);
    if (magnitude > MAX_SWING) {
      u *= MAX_SWING / magnitude;
      v *= MAX_SWING / magnitude;
    }

    const EPS = 1e-9;
    if (
      Math.abs(clampedTwist - twistAngle) < EPS &&
      Math.abs(u - (vec[spec.swingU] ?? 0)) < EPS &&
      Math.abs(v - (vec[spec.swingV] ?? 0)) < EPS
    ) {
      return;
    }

    // Rebuild swing' * twist' from the clamped values.
    vec[0] = 0;
    vec[1] = 0;
    vec[2] = 0;
    vec[spec.swingU] = u;
    vec[spec.swingV] = v;
    const angle = Math.hypot(u, v);
    const k = angle > 1e-9 ? Math.sin(angle / 2) / angle : 0.5;
    swing.set((vec[0] ?? 0) * k, (vec[1] ?? 0) * k, (vec[2] ?? 0) * k, Math.cos(angle / 2));
    twistVec[0] = 0;
    twistVec[1] = 0;
    twistVec[2] = 0;
    twistVec[spec.twistAxis] = Math.sin(clampedTwist / 2);
    twist.set(twistVec[0] ?? 0, twistVec[1] ?? 0, twistVec[2] ?? 0, Math.cos(clampedTwist / 2));
    swing.multiply(twist);
    if (swing.w < 0) swing.set(-swing.x, -swing.y, -swing.z, -swing.w);

    limited.before.copy(q);
    limited.written.copy(swing);
    limited.hasWritten = true;
    q.copy(swing);
  }
}
