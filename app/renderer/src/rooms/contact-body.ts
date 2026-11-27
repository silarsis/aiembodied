import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PenetrationHit } from './room-physics.js';
import { BUTTOCKS_BELOW_HIPS } from './seat-fit.js';
import {
  ANKLE_CONE,
  ANKLE_MAX_OFFSET,
  ELBOW_MAX_OFFSET,
  HIP_MAX_OFFSET,
  HIP_FLEXION_MAX_OFFSET,
  HEAD_PITCH_LIMIT,
  HEAD_ROLL_LIMIT,
  HEAD_SETTLE_SECONDS,
  HEAD_YAW_LIMIT,
  capDirectional,
  headExcessCorrection,
  scaleRotation,
  type HeadAngles,
  KNEE_MAX_OFFSET,
  MAX_OFFSET_RATE,
  SHOULDER_MAX_OFFSET,
  WRIST_MAX_OFFSET,
  CONTACT_TOLERANCE,
  HINGE_MIN,
  HIP_CONE,
  KNEE_MAX_FLEXION,
  MIN_CORRECTION_ANGLE,
  SHOULDER_CONE,
  WEIGHT_EPSILON,
  WRIST_CONE,
  clampCone,
  clampHinge,
  easeTowards,
  hingeAngle,
  projectToHinge,
  rotationAngle,
  smallestRotation,
  solveTwoBone,
  stepSpring,
  type Spring,
} from './contact-math.js';

/**
 * Kinematic contact solver for one avatar. The animation (streamed ARDY motion) knows nothing about
 * furniture, so a seated avatar's thighs and shins sink into the cushion. After the animation, grip and
 * seat fit, and before the VRM copies its normalised bones to the raw ones, this measures body capsules
 * against the room's exact colliders, lifts the pelvis a little and rotates limb joints by the smallest
 * rotation that pushes each limb out. It is deterministic (no motors, no simulation state beyond easing).
 * Open-space motion is untouched: with no contact the corrections are exactly identity.
 */

/** The pelvis height the capsule radii below are specified for (metres). */
export const REFERENCE_HIPS_HEIGHT = 0.95;
/** Capsule radii in metres for a 0.95 m-hips avatar; scaled by hips height and root scale. Tune here. */
export const CAPSULE_RADII = {
  // The same distance seat fit puts between the hips bone and the seat, so a fitted pelvis only touches its seat.
  pelvis: BUTTOCKS_BELOW_HIPS,
  chest: 0.13,
  thigh: 0.075,
  shin: 0.05,
  foot: 0.04,
  upperArm: 0.045,
  forearm: 0.04,
  hand: 0.035,
} as const;
/** The pelvis is never lifted more than this (metres, absolute). */
export const MAX_PELVIS_LIFT = 0.08;
/** Smoothing time of the pelvis lift spring (seconds). */
export const PELVIS_LIFT_SMOOTH_TIME = 0.12;
/** Solver passes over all limbs per frame. */
export const SOLVER_ITERATIONS = 4;
/** Time constant of a correction ramping in while its limb is in contact (seconds). */
export const CORRECTION_IN_TAU = 0.05;
/** Time constant of a correction easing out once the contact is gone (seconds). */
export const CORRECTION_OUT_TAU = 0.2;
/** Feet sunk below the surface under them by more than this (metres at reference scale) are planted on it. */
export const FOOT_PLANT_THRESHOLD = 0.01;
/** A foot counts as grounded when its animated ankle is within this height range above the surface under it (metres at reference scale): a standing ankle sits about 0.08 m up. */
export const GROUNDED_MIN_HEIGHT = -0.01;
export const GROUNDED_MAX_HEIGHT = 0.11;
/** The plant ray starts this far above the ankle (metres at reference scale), so a table over the foot is not hit. */
export const PLANT_RAY_LIFT = 0.15;
/** A limb end this far from where the animation put it counts as missing its pose (metres). */
export const MISS_DISTANCE = 0.05;
/** ...for at least this long (seconds). */
export const MISS_SECONDS = 0.25;
/** Fallback segment lengths (reference scale metres) when a toes or middle finger bone is missing. */
const FOOT_LENGTH = 0.12;
/** A push whose horizontal part points this close (radians) to straight out from the body midline would abduct a leg: refused. */
const ABDUCTION_ANGLE = Math.PI / 4;
const HAND_LENGTH = 0.08;
/** Time constant of the seated head settle easing in (about HEAD_SETTLE_SECONDS to 95%) and, quicker, out (seconds). */
const HEAD_SETTLE_IN_TAU = HEAD_SETTLE_SECONDS / 3;
const HEAD_SETTLE_OUT_TAU = 0.1;

export interface BoneSource {
  getNormalizedBoneNode(name: string): THREE.Object3D | null | undefined;
}

/** What the solver needs from physics: the Phase 1 queries. */
export interface ContactPhysics {
  penetration(
    shape: RAPIER.Shape,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
    exclude?: string | readonly string[],
  ): PenetrationHit | null;
  surfaceAt(x: number, z: number, fromY: number, objectId?: string): number | null;
}

export type LimbEnd =
  'leftFoot' | 'rightFoot' | 'leftKnee' | 'rightKnee' | 'leftHand' | 'rightHand';

export interface ContactMiss {
  end: LimbEnd;
  /** The object in the way (the last one that pushed this limb), or null for the shell or when unknown. */
  objectId: string | null;
  /** Metres between where the animation put the end and where the solver left it. */
  distance: number;
  /** How long it has been over MISS_DISTANCE (seconds). */
  seconds: number;
}

type Side = 'left' | 'right';
type JointKind = 'hinge' | 'cone';

interface Joint {
  bone: THREE.Object3D;
  kind: JointKind;
  /** Hinge axis in the bone's local space; its positive rotation is flexion. */
  axis: THREE.Vector3;
  /** Hinge: maximum flexion. Cone: maximum angle from rest. Radians. */
  limit: number;
  /** The most the correction may rotate this joint from its animated rotation (radians). */
  cap: number;
  /** The rotation the animation gave the bone this frame. */
  anim: THREE.Quaternion;
  /** The last rotation written, to tell a bone the mixer rewrote from one it left alone. */
  written: THREE.Quaternion;
  hasWritten: boolean;
  /** This frame's full correction, in the parent's frame (applied before the animated rotation). */
  offset: THREE.Quaternion;
  /** The correction being blended in or out, and how much of it applies (0..1). */
  target: THREE.Quaternion;
  weight: number;
}

interface Segment {
  /** Joint index within the limb, or -1 for the pelvis and chest. */
  joint: number;
  start: THREE.Object3D;
  end: THREE.Object3D | null;
  radius: number;
  isFoot: boolean;
  isHand: boolean;
  limb: Limb | null;
  /** Estimated length when there is no end bone. */
  fallbackLength: number;
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  shape: RAPIER.Capsule | null;
  halfHeight: number;
  shapeRadius: number;
  contact: boolean;
  /** The deepest overlap that made `contact` true this frame (kept for the motion trace only). */
  hit: PenetrationHit | null;
  /** Name for the motion trace, set when the segment is built into a limb. */
  name: string;
}

interface Limb {
  side: Side;
  isLeg: boolean;
  joints: Joint[];
  segments: Segment[];
  /** Object that pushed this limb this frame (null when none or the shell). */
  blocker: string | null;
  hit: boolean;
  /** A hit this frame was refused (cap, abduction rule): the limb could not get clear. */
  refused: boolean;
  /** Leg only: the animated ankle's height above the surface under it when the foot was grounded, else null. Measured before the pelvis lift. */
  groundHeight: number | null;
  /** Where that animated ankle was (world, before the lift; the lift only moves y). */
  groundAt: THREE.Vector3;
}

interface EndTrack {
  end: LimbEnd;
  limb: Limb;
  joint: number;
  animated: THREE.Vector3;
  distance: number;
  seconds: number;
  reported: boolean;
  blocker: string | null;
  /** The end is away from its animated place or its limb's correction was refused this frame. */
  missing: boolean;
}

/** A neck or head bone the head settle adds a correction to. */
interface HeadBone {
  bone: THREE.Object3D;
  anim: THREE.Quaternion;
  written: THREE.Quaternion;
  hasWritten: boolean;
}

function newHeadBone(bone: THREE.Object3D): HeadBone {
  return {
    bone,
    anim: new THREE.Quaternion().copy(bone.quaternion),
    written: new THREE.Quaternion(),
    hasWritten: false,
  };
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const NEG_Y_AXIS = new THREE.Vector3(0, -1, 0);
const IDENTITY = new THREE.Quaternion();
const TMP_DIR = new THREE.Vector3();
const TMP_N = new THREE.Vector3();
const TMP_POINT = new THREE.Vector3();
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_C = new THREE.Vector3();
const TMP_D = new THREE.Vector3();
const TMP_E = new THREE.Vector3();
const TMP_F = new THREE.Vector3();
const TMP_G = new THREE.Vector3();
const TMP_POS = new THREE.Vector3();
const TMP_SCALE = new THREE.Vector3();
const TMP_QW = new THREE.Quaternion();
const TMP_PW = new THREE.Quaternion();
const TMP_QL = new THREE.Quaternion();
const TMP_Q1 = new THREE.Quaternion();
const TMP_Q2 = new THREE.Quaternion();
const TMP_Q3 = new THREE.Quaternion();
const TMP_Q4 = new THREE.Quaternion();
const TMP_CENTER = new THREE.Vector3();
const TMP_ROT = new THREE.Quaternion();

const shapes = new Map<string, RAPIER.Capsule>();
/** One Rapier capsule per (half height, radius) rounded to the millimetre, shared by every avatar. */
function capsuleShape(halfHeight: number, radius: number): RAPIER.Capsule {
  const key = `${Math.round(halfHeight * 1000)}:${Math.round(radius * 1000)}`;
  let shape = shapes.get(key);
  if (!shape) {
    shape = new RAPIER.Capsule(
      Math.round(halfHeight * 1000) / 1000,
      Math.round(radius * 1000) / 1000,
    );
    shapes.set(key, shape);
  }
  return shape;
}

function positionOf(object: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  return out.setFromMatrixPosition(object.matrixWorld);
}

function worldQuaternionOf(object: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  object.matrixWorld.decompose(TMP_POS, out, TMP_SCALE);
  return out;
}

/** An element that must exist (the chains are built with fixed lengths); throws rather than carrying on with undefined. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`contact-body: no element ${index}`);
  return item;
}

const WIRE_SEGMENTS = 12;
/** Line vertices per capsule wireframe: two rings and four side lines. */
const WIRE_VERTICES = (WIRE_SEGMENTS * 2 + 4) * 2;

export class ContactBody {
  private readonly hips: THREE.Object3D | null;
  private readonly pelvis: Segment | null;
  private readonly chest: Segment | null;
  private readonly limbs: Limb[] = [];
  private readonly ends: EndTrack[] = [];
  private readonly lift: Spring = { value: 0, velocity: 0 };
  /** The lift the last frame asked for (metres), for the motion trace. */
  private liftTarget = 0;
  private readonly listeners = new Set<(miss: ContactMiss) => void>();
  private debugLines: THREE.LineSegments | null = null;
  private debugCapacity = 0;
  /** World size of the avatar relative to the reference (hips height ratio times root scale). */
  private factor = 1;
  /** The object the avatar is seated on, if any (resting contacts with it belong to the pelvis lift). */
  private seatId: string | null = null;
  private readonly neck: HeadBone | null;
  private readonly head: HeadBone | null;
  /** How much of the head settle correction applies (0..1). */
  private headWeight = 0;
  /** The correction wanted this frame (neck and head together, in the chest's frame), for the motion trace. Its sign carries over to the next frame. */
  private readonly headCorrection = new THREE.Quaternion();
  /** The hips-relative head angles of the animated pose (degrees) and whether it was taken for broken, for the motion trace. */
  private headAnimDeg: [number, number, number] = [0, 0, 0];
  private headReset = false;
  private readonly headSeen: HeadAngles = { yaw: 0, pitch: 0, roll: 0, reset: false };
  /** Horizontal unit vector along the body's left-right axis (from the hips). */
  private readonly lateral = new THREE.Vector3(1, 0, 0);

  constructor(humanoid: BoneSource) {
    const bone = (name: string) => humanoid.getNormalizedBoneNode(name) ?? null;
    this.hips = bone('hips');
    const neckBone = bone('neck');
    const headBone = bone('head');
    this.neck = neckBone ? newHeadBone(neckBone) : null;
    this.head = headBone ? newHeadBone(headBone) : null;
    this.pelvis = this.hips
      ? this.bodySegment(this.hips, bone('spine'), CAPSULE_RADII.pelvis)
      : null;
    if (this.pelvis) this.pelvis.name = 'pelvis';
    const chestBone = bone('chest') ?? bone('spine');
    this.chest = chestBone
      ? this.bodySegment(chestBone, bone('neck') ?? bone('head'), CAPSULE_RADII.chest)
      : null;
    if (this.chest) this.chest.name = 'chest';
    for (const side of ['left', 'right'] as const) {
      this.addLimb(humanoid, side, true);
      this.addLimb(humanoid, side, false);
    }
    const labels: Array<[LimbEnd, boolean, Side, number]> = [
      ['leftFoot', true, 'left', 2],
      ['rightFoot', true, 'right', 2],
      ['leftKnee', true, 'left', 1],
      ['rightKnee', true, 'right', 1],
      ['leftHand', false, 'left', 2],
      ['rightHand', false, 'right', 2],
    ];
    for (const [end, isLeg, side, joint] of labels) {
      const limb = this.limbs.find(
        (candidate) => candidate.isLeg === isLeg && candidate.side === side,
      );
      if (limb) {
        this.ends.push({
          end,
          limb,
          joint,
          animated: new THREE.Vector3(),
          distance: 0,
          seconds: 0,
          reported: false,
          blocker: null,
          missing: false,
        });
      }
    }
  }

  /** The pelvis lift currently added to the avatar root's y (metres). */
  get pelvisLift(): number {
    return this.lift.value;
  }

  /** Forgets the lift without moving the root, for when the root has been put somewhere else. */
  resetLift(): void {
    this.lift.value = 0;
    this.lift.velocity = 0;
  }

  /**
   * Gives the bones back to the animation: restores the animated rotation of every bone this solver wrote
   * (and the mixer has not rewritten since), drops all corrections and the lift. For when the avatar leaves
   * the room, since bones nothing else keys would keep the collision-adjusted pose.
   */
  release(): void {
    this.restoreAnimated();
    this.restoreHead();
    this.headWeight = 0;
    this.headCorrection.identity();
    for (const limb of this.limbs) {
      for (const joint of limb.joints) {
        joint.weight = 0;
        joint.target.identity();
        joint.offset.identity();
      }
    }
    for (const track of this.ends) {
      track.distance = 0;
      track.seconds = 0;
      track.missing = false;
      track.reported = false;
    }
    this.resetLift();
  }

  /** The limb ends that have been further than MISS_DISTANCE from their animated place for MISS_SECONDS. */
  misses(): ContactMiss[] {
    const result: ContactMiss[] = [];
    for (const track of this.ends) {
      if (track.missing && track.seconds >= MISS_SECONDS) result.push(this.missOf(track));
    }
    return result;
  }

  /** True while any capsule touches something or the pelvis is lifted: the motion trace samples then. */
  isInContact(): boolean {
    if (this.lift.value !== 0 || this.liftTarget !== 0 || this.headWeight > 0) return true;
    if (this.pelvis?.contact || this.chest?.contact) return true;
    return this.limbs.some((limb) => limb.segments.some((segment) => segment.contact));
  }

  /**
   * A plain-data picture of the solver for the motion trace (see motion-trace.ts): pelvis lift, the segments
   * touching something, the joints currently corrected and whether the cap held them, and the misses. Only
   * called while tracing, so it may allocate.
   */
  traceSnapshot(): Record<string, unknown> {
    const deg = (radians: number) => Math.round(((radians * 180) / Math.PI) * 100) / 100;
    const r3 = (value: number) => Math.round(value * 1000) / 1000;
    const segments: Array<Record<string, unknown>> = [];
    const all: Segment[] = [];
    if (this.pelvis) all.push(this.pelvis);
    if (this.chest) all.push(this.chest);
    for (const limb of this.limbs) all.push(...limb.segments);
    for (const segment of all) {
      if (!segment.contact) continue;
      const hit = segment.hit;
      segments.push({
        name: segment.name,
        contact: true,
        objectId: hit?.objectId ?? null,
        depth: hit ? r3(hit.depth) : null,
        normal: hit ? [r3(hit.normal.x), r3(hit.normal.y), r3(hit.normal.z)] : null,
      });
    }
    const joints: Array<Record<string, unknown>> = [];
    const jointNames = ['hip', 'knee', 'ankle'];
    const armNames = ['shoulder', 'elbow', 'wrist'];
    for (const limb of this.limbs) {
      limb.joints.forEach((joint, i) => {
        const offset = rotationAngle(joint.target);
        if (offset <= MIN_CORRECTION_ANGLE && joint.weight === 0) return;
        joints.push({
          name: `${limb.side}${limb.isLeg ? nth(jointNames, i) : nth(armNames, i)}`,
          offsetDeg: deg(offset),
          weight: r3(joint.weight),
          appliedDeg: deg(offset * joint.weight),
          capDeg: deg(joint.cap),
          capped: limb.refused && rotationAngle(joint.offset) >= joint.cap - 1e-4,
        });
      });
    }
    return {
      pelvisLift: { target: r3(this.liftTarget), applied: r3(this.lift.value) },
      headSettle: {
        weight: r3(this.headWeight),
        animYawPitchRollDeg: this.headAnimDeg,
        // The old key, for logs read by older tooling.
        excessYawPitchRollDeg: this.headAnimDeg,
        reset: this.headReset,
      },
      segments,
      joints,
      misses: this.misses().map((miss) => ({
        end: miss.end,
        objectId: miss.objectId,
        distance: r3(miss.distance),
        seconds: r3(miss.seconds),
      })),
    };
  }

  /** Where a limb end is now and where the animation put it this frame (world metres); null without that bone. */
  endPositions(
    end: LimbEnd,
  ): { actual: [number, number, number]; animated: [number, number, number] } | null {
    const track = this.ends.find((candidate) => candidate.end === end);
    if (!track) return null;
    const actual = positionOf(nth(track.limb.joints, track.joint).bone, TMP_A);
    return {
      actual: [actual.x, actual.y, actual.z],
      animated: [track.animated.x, track.animated.y, track.animated.z],
    };
  }

  /** Calls `listener` when a limb end starts to miss (once per miss). Returns the unsubscribe function. */
  onMissStart(listener: (miss: ContactMiss) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Solves one frame. Call after the animation mixer, pose blending, grip and seat fit and before the VRM's
   * own update. A bone that anything since our last write (mixer, pose blend) rewrote is taken as the new
   * animated pose; one still holding our write gets its animated rotation back first.
   * `physics` null (no physics in this room) still restores the animated pose. `debugParent` non-null draws
   * the body capsules into it. `seatId` is the object the avatar sits on (or null/undefined). `headSettle` is true while
   * seated with no stream playing: the head is then eased back inside the seated head limits.
   */
  update(
    rig: { scene: THREE.Object3D; restHipsHeight: number },
    physics: ContactPhysics | null,
    deltaSeconds: number,
    exclude: readonly string[],
    debugParent: THREE.Object3D | null,
    seatId: string | null = null,
    headSettle = false,
  ): void {
    const hips = this.hips;
    if (!hips) return;
    const dt = Math.max(0, deltaSeconds);
    const rest = rig.restHipsHeight > 0 ? rig.restHipsHeight : REFERENCE_HIPS_HEIGHT;
    const factor = (rest / REFERENCE_HIPS_HEIGHT) * (rig.scene.scale.x || 1);

    this.factor = factor;
    this.seatId = seatId;
    this.restoreAnimated();
    this.restoreHead();
    hips.updateWorldMatrix(true, true);
    this.measureLateral();
    this.measureShapes(factor);

    for (const limb of this.limbs) {
      limb.blocker = null;
      limb.hit = false;
      limb.refused = false;
      for (const segment of limb.segments) segment.contact = false;
      for (const joint of limb.joints) joint.offset.identity();
    }
    if (this.pelvis) this.pelvis.contact = false;
    if (this.chest) this.chest.contact = false;

    this.measureGrounded(physics);
    this.liftPelvis(rig.scene, physics, exclude, dt);
    for (const track of this.ends)
      positionOf(nth(track.limb.joints, track.joint).bone, track.animated);

    if (physics) {
      for (let pass = 0; pass < SOLVER_ITERATIONS; pass += 1) {
        // Planting every pass: pushing a thigh out of the cushion lifts the foot, and the foot must go back down.
        for (const limb of this.limbs) if (limb.isLeg) this.plantFoot(limb, physics, exclude);
        let any = false;
        for (const limb of this.limbs)
          any = this.solveLimb(limb, physics, exclude, pass === 0) || any;
        if (!any) break;
      }
      // Grounded feet get the last word: the legs may end up a hair into furniture rather than a foot floating.
      for (const limb of this.limbs)
        if (limb.isLeg && limb.groundHeight !== null) this.plantFoot(limb, physics, exclude);
    }

    this.writeBlended(dt);
    hips.updateWorldMatrix(false, true);
    this.settleHead(dt, headSettle);
    this.trackMisses(dt);

    if (debugParent) this.drawDebug(debugParent, physics, exclude);
    else this.clearDebug();
  }

  dispose(): void {
    this.clearDebug();
    if (this.debugLines) {
      this.debugLines.geometry.dispose();
      (this.debugLines.material as THREE.Material).dispose();
      this.debugLines = null;
    }
    this.listeners.clear();
  }

  // ---- construction ---------------------------------------------------------------------------

  private newSegment(
    joint: number,
    start: THREE.Object3D,
    end: THREE.Object3D | null,
    radius: number,
    fallbackLength = 0,
  ): Segment {
    return {
      joint,
      start,
      end,
      radius,
      isFoot: false,
      isHand: false,
      limb: null,
      fallbackLength,
      p0: new THREE.Vector3(),
      p1: new THREE.Vector3(),
      shape: null,
      halfHeight: -1,
      shapeRadius: -1,
      contact: false,
      hit: null,
      name: '',
    };
  }

  private bodySegment(
    start: THREE.Object3D,
    end: THREE.Object3D | null,
    radius: number,
  ): Segment | null {
    return end ? this.newSegment(-1, start, end, radius) : null;
  }

  private addLimb(humanoid: BoneSource, side: Side, isLeg: boolean): void {
    const names = isLeg
      ? [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`]
      : [`${side}UpperArm`, `${side}LowerArm`, `${side}Hand`];
    const found = names.map((name) => humanoid.getNormalizedBoneNode(name));
    const bones = found.filter((bone): bone is THREE.Object3D => !!bone);
    if (bones.length !== names.length) return;
    // The hinge axes assume the normalised rest pose: legs down, arms out along +/-X, model facing +Z.
    const hingeAxis = isLeg ? X_AXIS : side === 'left' ? NEG_Y_AXIS : Y_AXIS;
    const kinds: Array<[JointKind, number, number]> = isLeg
      ? [
          ['cone', HIP_CONE, HIP_MAX_OFFSET],
          ['hinge', KNEE_MAX_FLEXION, KNEE_MAX_OFFSET],
          ['cone', ANKLE_CONE, ANKLE_MAX_OFFSET],
        ]
      : [
          ['cone', SHOULDER_CONE, SHOULDER_MAX_OFFSET],
          ['hinge', KNEE_MAX_FLEXION, ELBOW_MAX_OFFSET],
          ['cone', WRIST_CONE, WRIST_MAX_OFFSET],
        ];
    const joints = bones.map((bone, i): Joint => ({
      bone,
      kind: nth(kinds, i)[0],
      axis: nth(kinds, i)[0] === 'hinge' ? hingeAxis.clone() : new THREE.Vector3(),
      limit: nth(kinds, i)[1],
      cap: nth(kinds, i)[2],
      anim: new THREE.Quaternion().copy(bone.quaternion),
      written: new THREE.Quaternion(),
      hasWritten: false,
      offset: new THREE.Quaternion(),
      target: new THREE.Quaternion(),
      weight: 0,
    }));
    const radii = isLeg
      ? [CAPSULE_RADII.thigh, CAPSULE_RADII.shin, CAPSULE_RADII.foot]
      : [CAPSULE_RADII.upperArm, CAPSULE_RADII.forearm, CAPSULE_RADII.hand];
    const toes = isLeg
      ? humanoid.getNormalizedBoneNode(`${side}Toes`)
      : humanoid.getNormalizedBoneNode(`${side}MiddleProximal`);
    const segments = [
      this.newSegment(0, nth(bones, 0), nth(bones, 1), nth(radii, 0)),
      this.newSegment(1, nth(bones, 1), nth(bones, 2), nth(radii, 1)),
      this.newSegment(
        2,
        nth(bones, 2),
        toes ?? null,
        nth(radii, 2),
        isLeg ? FOOT_LENGTH : HAND_LENGTH,
      ),
    ];
    const segmentNames = isLeg ? ['Thigh', 'Shin', 'Foot'] : ['UpperArm', 'Forearm', 'Hand'];
    segments.forEach((segment, i) => {
      segment.name = `${side}${nth(segmentNames, i)}`;
    });
    nth(segments, 2).isFoot = isLeg;
    nth(segments, 2).isHand = !isLeg;
    const limb: Limb = {
      side,
      isLeg,
      joints,
      segments,
      blocker: null,
      hit: false,
      refused: false,
      groundHeight: null,
      groundAt: new THREE.Vector3(),
    };
    for (const segment of segments) segment.limb = limb;
    this.limbs.push(limb);
  }

  // ---- per frame ------------------------------------------------------------------------------

  /** Puts back the animated rotation of every bone this solver wrote last frame and the mixer did not rewrite. */
  private restoreAnimated(): void {
    for (const limb of this.limbs) {
      for (const joint of limb.joints) {
        // A bone the mixer rewrote holds the new animated pose; one it left alone still holds our last write.
        if (!(joint.hasWritten && joint.bone.quaternion.equals(joint.written)))
          joint.anim.copy(joint.bone.quaternion);
        else joint.bone.quaternion.copy(joint.anim);
        joint.hasWritten = false;
      }
    }
  }

  /** Puts back the animated rotation of the neck and head if they still hold our last write; otherwise takes what was written as animated. */
  private restoreHead(): void {
    for (const part of [this.neck, this.head]) {
      if (!part) continue;
      if (!(part.hasWritten && part.bone.quaternion.equals(part.written)))
        part.anim.copy(part.bone.quaternion);
      else part.bone.quaternion.copy(part.anim);
      part.hasWritten = false;
    }
  }

  /**
   * Seated head settle. While `active` (seated, no stream playing) the head's turn from the hips (spine and
   * chest twist count, so a twisted chest cannot hide a head that looks spun round) is held inside the
   * yaw/pitch/roll limits: the excess is added back as a correction that eases in over about
   * HEAD_SETTLE_SECONDS, split between neck and head. A pose far outside any human range is a broken frame
   * and is eased back to straight ahead. It eases out quickly once inactive.
   */
  private settleHead(dt: number, active: boolean): void {
    const { neck, head } = this;
    if (!head || !this.hips) return;
    // World rotations of the animated pose: neck and head were restored to it, and nothing here writes the spine or chest.
    const first = neck ?? head;
    const hipsW = worldQuaternionOf(this.hips, TMP_QW);
    const headW = worldQuaternionOf(head.bone, TMP_PW);
    const parentW = worldQuaternionOf(first.bone, TMP_QL).multiply(
      TMP_Q2.copy(first.anim).invert(),
    );
    // Head orientation relative to the hips, and the correction needed in the hips' frame.
    const inverseHips = TMP_Q1.copy(hipsW).invert();
    const combined = TMP_Q3.copy(inverseHips).multiply(headW);
    const excess = headExcessCorrection(
      combined,
      HEAD_YAW_LIMIT,
      HEAD_PITCH_LIMIT,
      HEAD_ROLL_LIMIT,
      TMP_Q4,
      this.headSeen,
    );
    // Move it into the frame the neck is corrected in (its parent, the chest): parent^-1 * hips * c * hips^-1 * parent.
    const toParent = inverseHips.multiply(parentW);
    TMP_Q4.premultiply(TMP_Q2.copy(toParent).invert()).multiply(toParent);
    // Same sign as last frame's, so a correction near 180 degrees does not flip direction between frames.
    if (!excess) TMP_Q4.identity();
    else if (TMP_Q4.dot(this.headCorrection) < 0)
      TMP_Q4.set(-TMP_Q4.x, -TMP_Q4.y, -TMP_Q4.z, -TMP_Q4.w);
    this.headCorrection.copy(TMP_Q4);
    const wanted = active && excess;
    this.headWeight = wanted
      ? easeTowards(this.headWeight, 1, dt, HEAD_SETTLE_IN_TAU)
      : easeTowards(this.headWeight, 0, dt, HEAD_SETTLE_OUT_TAU);
    const toDeg = (r: number) => Math.round(((r * 180) / Math.PI) * 10) / 10;
    this.headAnimDeg = excess
      ? [toDeg(this.headSeen.yaw), toDeg(this.headSeen.pitch), toDeg(this.headSeen.roll)]
      : [0, 0, 0];
    this.headReset = excess && this.headSeen.reset;
    if (this.headWeight === 0 || !excess) {
      if (!excess) this.headWeight = 0;
      return;
    }
    // Half the correction on the neck (in the chest's frame), the rest on the head (in the corrected neck's frame).
    const share = scaleRotation(this.headCorrection, this.headWeight, TMP_Q2);
    const neckShare = neck ? scaleRotation(share, 0.5, TMP_QW) : TMP_QW.identity();
    const rest = TMP_PW.copy(neckShare).invert().premultiply(share); // share * neckShare^-1
    if (neck) {
      neck.bone.quaternion.copy(neckShare).multiply(neck.anim);
      neck.written.copy(neck.bone.quaternion);
      neck.hasWritten = true;
    }
    // The head turn is expressed in the neck's new frame: neck'^-1 * rest * neck'.
    const neckNow = neck ? neck.bone.quaternion : IDENTITY;
    TMP_QL.copy(neckNow).invert().multiply(rest).multiply(neckNow);
    head.bone.quaternion.copy(TMP_QL).multiply(head.anim);
    head.written.copy(head.bone.quaternion);
    head.hasWritten = true;
    (neck ?? head).bone.updateWorldMatrix(false, true);
  }

  /** The body's left-right axis, flattened to the horizontal plane. */
  private measureLateral(): void {
    if (!this.hips) return;
    worldQuaternionOf(this.hips, TMP_QW);
    this.lateral.set(1, 0, 0).applyQuaternion(TMP_QW);
    this.lateral.y = 0;
    if (this.lateral.lengthSq() < 1e-6) this.lateral.set(1, 0, 0);
    this.lateral.normalize();
  }

  /** Fits each segment's shape to its current length and radius (lengths only change when the avatar is rescaled). */
  private measureShapes(factor: number): void {
    const fit = (segment: Segment) => {
      positionOf(segment.start, segment.p0);
      this.endOf(segment, segment.p1);
      const halfHeight = segment.p0.distanceTo(segment.p1) / 2;
      const radius = segment.radius * factor;
      if (
        !segment.shape ||
        Math.abs(halfHeight - segment.halfHeight) > 0.0005 ||
        Math.abs(radius - segment.shapeRadius) > 0.0005
      ) {
        segment.shape = capsuleShape(halfHeight, radius);
        segment.halfHeight = halfHeight;
        segment.shapeRadius = radius;
      }
    };
    if (this.pelvis) fit(this.pelvis);
    if (this.chest) fit(this.chest);
    for (const limb of this.limbs) for (const segment of limb.segments) fit(segment);
  }

  /** World position of a segment's far end: its end bone, or an estimate when the model has none. */
  private endOf(segment: Segment, out: THREE.Vector3): THREE.Vector3 {
    if (segment.end) return positionOf(segment.end, out);
    positionOf(segment.start, out);
    if (segment.isFoot) {
      worldQuaternionOf(segment.start, TMP_QW);
      TMP_DIR.set(0, 0, 1).applyQuaternion(TMP_QW);
    } else {
      // A hand continues the forearm.
      TMP_DIR.set(0, 0, 0);
      const elbow = segment.limb?.joints[1]?.bone;
      if (elbow) TMP_DIR.copy(out).sub(positionOf(elbow, TMP_POINT)).normalize();
    }
    return out.addScaledVector(TMP_DIR, segment.fallbackLength * this.factor);
  }

  private pose(segment: Segment): void {
    positionOf(segment.start, segment.p0);
    this.endOf(segment, segment.p1);
  }

  /** Deepest overlap of a segment's capsule, with the whole capsule shifted down by `dy`. */
  private probe(
    segment: Segment,
    physics: ContactPhysics,
    exclude: readonly string[],
    dy = 0,
  ): PenetrationHit | null {
    if (!segment.shape) return null;
    TMP_DIR.subVectors(segment.p1, segment.p0);
    const length = TMP_DIR.length();
    if (length < 1e-6) return null;
    TMP_DIR.multiplyScalar(1 / length);
    TMP_CENTER.addVectors(segment.p0, segment.p1).multiplyScalar(0.5);
    TMP_CENTER.y -= dy;
    TMP_ROT.setFromUnitVectors(Y_AXIS, TMP_DIR);
    return physics.penetration(segment.shape, TMP_CENTER, TMP_ROT, exclude);
  }

  /**
   * Raises the root so the pelvis and thighs rest on whatever they sank into from above (other than the seat being sat on). The capsules are
   * measured as if the current lift were not applied, so the target does not depend on the lift itself and
   * falls back to zero once the contact is gone.
   */
  private liftPelvis(
    scene: THREE.Object3D,
    physics: ContactPhysics | null,
    exclude: readonly string[],
    dt: number,
  ): void {
    let target = 0;
    if (physics) {
      const dy = this.lift.value;
      const consider = (segment: Segment | null | undefined) => {
        if (!segment) return;
        this.pose(segment);
        const hit = this.probe(segment, physics, exclude, dy);
        // The floor is the motion model's business (standing, floor sits); only furniture lifts the pelvis.
        if (hit && hit.objectId !== null && hit.normal.y > 0.5) {
          segment.contact = true;
          segment.hit = hit;
          // Seat fit is the only authority on hip height on the seat being sat on: the pelvis and thighs
          // resting in it never drive the lift (the thighs are cleared by the hips instead).
          if (hit.objectId === this.seatId) return;
          target = Math.max(target, hit.depth * hit.normal.y);
        }
      };
      consider(this.pelvis);
      for (const limb of this.limbs) if (limb.isLeg) consider(limb.segments[0]);
      target = Math.min(MAX_PELVIS_LIFT, Math.max(0, target));
    }
    this.liftTarget = target;
    const before = this.lift.value;
    stepSpring(this.lift, target, dt, PELVIS_LIFT_SMOOTH_TIME);
    const delta = this.lift.value - before;
    if (delta !== 0) {
      scene.position.y += delta;
      this.hips?.updateWorldMatrix(true, true);
    }
  }

  /** Notes which feet the animation has on the ground, before the lift moves the body. */
  private measureGrounded(physics: ContactPhysics | null): void {
    for (const limb of this.limbs) {
      if (!limb.isLeg) continue;
      limb.groundHeight = null;
      const ankle = limb.joints[2]?.bone;
      if (!physics || !ankle) continue;
      positionOf(ankle, TMP_C);
      // The lift of earlier frames is still on the root; the animated ankle is without it.
      TMP_C.y -= this.lift.value;
      const surface = physics.surfaceAt(TMP_C.x, TMP_C.z, TMP_C.y + PLANT_RAY_LIFT * this.factor);
      if (surface === null) continue;
      const height = TMP_C.y - surface;
      if (
        height >= GROUNDED_MIN_HEIGHT * this.factor &&
        height <= GROUNDED_MAX_HEIGHT * this.factor
      ) {
        limb.groundHeight = height;
        limb.groundAt.copy(TMP_C);
      }
    }
  }

  /**
   * Foot planting with two-bone IK. A foot the animation had on the ground goes back to where it was; any
   * other ankle that is below the surface under it is put on the surface.
   */
  private plantFoot(limb: Limb, physics: ContactPhysics, exclude: readonly string[]): void {
    const [hip, knee, ankle] = limb.joints as [Joint, Joint, Joint];
    const footRadius = CAPSULE_RADII.foot * this.factor;
    positionOf(hip.bone, TMP_A);
    positionOf(knee.bone, TMP_B);
    positionOf(ankle.bone, TMP_C);
    const threshold = FOOT_PLANT_THRESHOLD * this.factor;
    if (limb.groundHeight !== null) {
      // The ground under it has not moved, so the animated ankle position is the target, whatever the lift
      // and the pushes on the legs did to it.
      if (TMP_C.distanceTo(limb.groundAt) <= threshold) return;
      TMP_D.copy(limb.groundAt);
    } else {
      const surface = physics.surfaceAt(TMP_C.x, TMP_C.z, TMP_C.y + PLANT_RAY_LIFT * this.factor);
      if (surface === null || TMP_C.y >= surface - threshold) return;
      TMP_D.set(TMP_C.x, surface + footRadius, TMP_C.z);
    }
    // The knee keeps bending the way the animation bent it.
    TMP_E.subVectors(TMP_B, TMP_A);
    solveTwoBone(
      TMP_A,
      TMP_D,
      TMP_E,
      TMP_A.distanceTo(TMP_B),
      TMP_B.distanceTo(TMP_C),
      TMP_F,
      TMP_G,
    );
    // Seated: a foot is not worth a thigh in the cushion. Where the pin would swing the thigh into the seat,
    // the thigh keeps its clearance and the foot floats (recorded as a miss).
    if (this.seatId !== null && this.thighWouldSink(limb, physics, exclude, TMP_A, TMP_F)) {
      limb.refused = true;
      return;
    }
    // Swing the thigh so the knee goes to its new place, then the shin so the ankle reaches the target.
    TMP_DIR.subVectors(TMP_B, TMP_A).normalize();
    TMP_N.subVectors(TMP_F, TMP_A).normalize();
    TMP_QW.setFromUnitVectors(TMP_DIR, TMP_N);
    this.rotateJoint(limb, 0, TMP_QW, 0, null, null, false);
    positionOf(knee.bone, TMP_B);
    positionOf(ankle.bone, TMP_C);
    TMP_DIR.subVectors(TMP_C, TMP_B).normalize();
    TMP_N.subVectors(TMP_G, TMP_B).normalize();
    TMP_QW.setFromUnitVectors(TMP_DIR, TMP_N);
    this.rotateJoint(limb, 1, TMP_QW, 0, null, null, false);
  }

  /** True when a thigh from `hip` to `knee` (same length and radius as the real one) would sink into the seat being sat on. */
  private thighWouldSink(
    limb: Limb,
    physics: ContactPhysics,
    exclude: readonly string[],
    hip: THREE.Vector3,
    knee: THREE.Vector3,
  ): boolean {
    const thigh = limb.segments[0];
    if (!thigh?.shape) return false;
    TMP_N.subVectors(knee, hip);
    const length = TMP_N.length();
    if (length < 1e-6) return false;
    TMP_N.multiplyScalar(1 / length);
    TMP_POINT.addVectors(hip, knee).multiplyScalar(0.5);
    TMP_ROT.setFromUnitVectors(Y_AXIS, TMP_N);
    const hit = physics.penetration(thigh.shape, TMP_POINT, TMP_ROT, exclude);
    return !!hit && hit.objectId === this.seatId && hit.depth > CONTACT_TOLERANCE;
  }

  /** One pass over a limb's segments; true when any needed a correction. */
  private solveLimb(
    limb: Limb,
    physics: ContactPhysics,
    exclude: readonly string[],
    first: boolean,
  ): boolean {
    let any = false;
    for (const segment of limb.segments) {
      this.pose(segment);
      const hit = this.probe(segment, physics, exclude);
      if (!hit || hit.depth <= CONTACT_TOLERANCE) continue;
      // A foot standing on the floor is the normal case; only a foot sunk deeper than its radius counts.
      if (segment.isFoot && hit.objectId === null && hit.depth <= segment.shapeRadius) continue;
      // The rounded hip end of a thigh sitting on its seat is the buttocks resting, which rotating the hip
      // cannot change (seat fit places the pelvis): leave it, or the hip would be driven to its cap for nothing.
      if (
        limb.isLeg &&
        segment.joint === 0 &&
        this.seatId !== null &&
        hit.objectId === this.seatId
      ) {
        TMP_DIR.subVectors(segment.p1, segment.p0).normalize();
        TMP_B.set(hit.point.x, hit.point.y, hit.point.z).sub(segment.p0);
        if (TMP_B.dot(TMP_DIR) < segment.shapeRadius) continue;
      }
      if (first) {
        segment.contact = true;
        segment.hit = hit;
      }
      any = true;
      limb.hit = true;
      limb.blocker = hit.objectId;
      TMP_DIR.subVectors(segment.p1, segment.p0);
      const length = TMP_DIR.length();
      TMP_DIR.multiplyScalar(1 / Math.max(length, 1e-6));
      TMP_N.set(hit.normal.x, hit.normal.y, hit.normal.z);
      TMP_POINT.set(hit.point.x, hit.point.y, hit.point.z);
      if (limb.isLeg && this.pushesOutward(limb, TMP_N)) {
        // Legs are never pushed out over an armrest: the contact stays, and counts as a miss.
        limb.refused = true;
        continue;
      }
      // Rotating about the start joint moves a point `reach` along the segment; aim at the contact itself.
      const along = TMP_B.subVectors(TMP_POINT, segment.p0).dot(TMP_DIR) / Math.max(length, 1e-6);
      const reach = Math.min(1, Math.max(0.25, along)) * length;
      const angle = smallestRotation(TMP_DIR, TMP_N, hit.depth, reach, TMP_QW);
      if (angle === 0) {
        // The push is along the bone: rotating this joint cannot help, so ask the joint above.
        if (segment.joint > 0) this.pushUp(limb, segment.joint, hit.depth);
        continue;
      }
      this.rotateJoint(limb, segment.joint, TMP_QW, hit.depth, TMP_N, TMP_POINT, true);
    }
    return any;
  }

  /** True when the horizontal part of `normal` points away from the body midline, within ABDUCTION_ANGLE, on the side of this leg. */
  private pushesOutward(limb: Limb, normal: THREE.Vector3): boolean {
    const hips = this.hips;
    const hip = limb.joints[0]?.bone;
    if (!hips || !hip) return false;
    const side =
      TMP_A.subVectors(positionOf(hip, TMP_A), positionOf(hips, TMP_B)).dot(this.lateral) >= 0
        ? 1
        : -1;
    const along = normal.dot(this.lateral) * side;
    const horizontal = Math.hypot(normal.x, normal.z);
    if (horizontal < 0.3) return false; // mostly vertical: a lift, not an abduction
    return along / horizontal > Math.cos(ABDUCTION_ANGLE);
  }

  private pushUp(limb: Limb, joint: number, depth: number): void {
    const parent = nth(limb.joints, joint - 1);
    TMP_DIR.subVectors(
      positionOf(nth(limb.joints, joint).bone, TMP_A),
      positionOf(parent.bone, TMP_B),
    ).normalize();
    // Any perpendicular lets the parent swing the whole limb clear.
    // A leg swings forward or back about the body's lateral axis, never sideways.
    TMP_N.crossVectors(TMP_DIR, limb.isLeg ? this.lateral : Y_AXIS);
    if (TMP_N.lengthSq() < 1e-6) TMP_N.crossVectors(TMP_DIR, X_AXIS);
    TMP_N.normalize();
    if (limb.isLeg && TMP_N.y < 0) TMP_N.negate();
    const length = TMP_A.distanceTo(TMP_B);
    const angle = smallestRotation(TMP_DIR, TMP_N, depth, length, TMP_QW);
    if (angle > 0) this.rotateJoint(limb, joint - 1, TMP_QW, 0, null, null, false);
  }

  /**
   * Rotates joint `index` of a limb by the world rotation `qWorld` about its position, within its limits.
   * With `push`, whatever part of the requested move the limits refused is passed to the joint above, aimed
   * at the same contact.
   */
  private rotateJoint(
    limb: Limb,
    index: number,
    qWorld: THREE.Quaternion,
    depth: number,
    normal: THREE.Vector3 | null,
    point: THREE.Vector3 | null,
    push: boolean,
  ): void {
    const joint = nth(limb.joints, index);
    const bone = joint.bone;
    const parent = bone.parent;
    const requested = rotationAngle(qWorld);
    // The same turn in the parent's frame.
    if (parent) worldQuaternionOf(parent, TMP_PW);
    else TMP_PW.identity();
    TMP_QL.copy(TMP_PW).invert().multiply(qWorld).multiply(TMP_PW);
    if (joint.kind === 'hinge') projectToHinge(TMP_QL, joint.axis, TMP_QL);

    const old = TMP_Q1.copy(joint.offset);
    const next = TMP_Q2.copy(TMP_QL).multiply(joint.offset);
    // Limits apply to the whole local rotation, animation included.
    const total = TMP_QL.copy(next).multiply(joint.anim);
    if (joint.kind === 'hinge') {
      clampHinge(
        total,
        joint.axis,
        HINGE_MIN,
        joint.limit,
        hingeAngle(joint.anim, joint.axis),
        total,
      );
    } else {
      clampCone(total, joint.limit, rotationAngle(joint.anim), total);
    }
    joint.offset.copy(total).multiply(TMP_PW.copy(joint.anim).invert());
    // The solver nudges, it never re-poses: whatever the cap refuses is a miss, not pushed up the chain.
    let capped: boolean;
    if (limb.isLeg && index === 0 && this.seatId !== null) {
      // Seated: the hip may flex (knee up) further than it may move any other way. Negative about the
      // lateral axis (X in the hips' frame) raises the knee.
      capped = capDirectional(
        joint.offset,
        X_AXIS,
        HIP_FLEXION_MAX_OFFSET,
        joint.cap,
        joint.offset,
      );
    } else {
      const offsetAngle = rotationAngle(joint.offset);
      capped = offsetAngle > joint.cap;
      if (capped) {
        TMP_QL.copy(joint.offset);
        joint.offset.identity().slerp(TMP_QL, joint.cap / offsetAngle);
      }
    }
    if (capped) limb.refused = true;
    bone.quaternion.copy(joint.offset).multiply(joint.anim);
    bone.updateWorldMatrix(false, true);

    if (capped || !push || index === 0 || !normal || !point || requested < 1e-6) return;
    const achieved = rotationAngle(TMP_PW.copy(old).invert().multiply(joint.offset));
    const remaining = depth * (1 - Math.min(1, achieved / requested));
    if (remaining < CONTACT_TOLERANCE * 0.5) return;
    // The limit stopped the move: swing the joint above instead, aimed at the same contact.
    const above = nth(limb.joints, index - 1);
    TMP_DIR.subVectors(point, positionOf(above.bone, TMP_A));
    const reach = TMP_DIR.length();
    if (reach < 1e-4) return;
    TMP_DIR.multiplyScalar(1 / reach);
    const turn = smallestRotation(TMP_DIR, normal, remaining, reach, TMP_QW);
    if (turn > 0) this.rotateJoint(limb, index - 1, TMP_QW, remaining, normal, point, true);
  }

  /** Blends each bone's correction in or out by its weight and writes the result over the animated rotation. */
  private writeBlended(dt: number): void {
    for (const limb of this.limbs) {
      for (const joint of limb.joints) {
        const touched = rotationAngle(joint.offset) > MIN_CORRECTION_ANGLE;
        if (touched) {
          // The target may grow only so fast; a single bad frame cannot fling the limb.
          const previous = rotationAngle(joint.target);
          const wanted = rotationAngle(joint.offset);
          const allowed = previous + MAX_OFFSET_RATE * dt;
          joint.target.copy(joint.offset);
          if (joint.target.w < 0)
            joint.target.set(-joint.target.x, -joint.target.y, -joint.target.z, -joint.target.w);
          if (wanted > allowed) {
            TMP_Q1.copy(joint.target);
            joint.target.copy(IDENTITY).slerp(TMP_Q1, allowed / wanted);
          }
          joint.weight = easeTowards(joint.weight, 1, dt, CORRECTION_IN_TAU);
        } else {
          joint.weight = easeTowards(joint.weight, 0, dt, CORRECTION_OUT_TAU, WEIGHT_EPSILON);
        }
        if (joint.weight === 0 && !touched) {
          // Never in contact, or fully released: exactly the animated pose.
          joint.target.identity();
          joint.bone.quaternion.copy(joint.anim);
          continue;
        }
        joint.bone.quaternion.copy(IDENTITY).slerp(joint.target, joint.weight).multiply(joint.anim);
        joint.written.copy(joint.bone.quaternion);
        joint.hasWritten = true;
      }
    }
  }

  private trackMisses(dt: number): void {
    for (const track of this.ends) {
      const bone = nth(track.limb.joints, track.joint).bone;
      track.distance = positionOf(bone, TMP_A).distanceTo(track.animated);
      if (track.limb.hit) track.blocker = track.limb.blocker;
      track.missing = track.distance > MISS_DISTANCE || track.limb.refused;
      if (track.missing) {
        track.seconds += dt;
        if (track.seconds >= MISS_SECONDS && !track.reported) {
          track.reported = true;
          if (this.listeners.size > 0) {
            const miss = this.missOf(track);
            for (const listener of this.listeners) listener(miss);
          }
        }
      } else {
        track.seconds = 0;
        track.reported = false;
        track.blocker = null;
      }
    }
  }

  private missOf(track: EndTrack): ContactMiss {
    return {
      end: track.end,
      objectId: track.blocker,
      distance: track.distance,
      seconds: track.seconds,
    };
  }

  // ---- debug ----------------------------------------------------------------------------------

  private clearDebug(): void {
    this.debugLines?.removeFromParent();
  }

  /** Wireframe capsules: red while a capsule overlaps something, green otherwise. */
  private drawDebug(
    parent: THREE.Object3D,
    physics: ContactPhysics | null,
    exclude: readonly string[],
  ): void {
    const all: Segment[] = [];
    if (this.pelvis) all.push(this.pelvis);
    if (this.chest) all.push(this.chest);
    for (const limb of this.limbs) all.push(...limb.segments);
    if (!this.debugLines || this.debugCapacity < all.length) {
      this.debugLines?.geometry.dispose();
      this.debugCapacity = all.length;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(all.length * WIRE_VERTICES * 3), 3),
      );
      geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(all.length * WIRE_VERTICES * 3), 3),
      );
      const material =
        this.debugLines?.material ??
        new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
      this.debugLines = new THREE.LineSegments(geometry, material);
      this.debugLines.name = 'debug:body-capsules';
      this.debugLines.frustumCulled = false;
      this.debugLines.renderOrder = 1000;
    }
    const lines = this.debugLines;
    if (lines.parent !== parent) parent.add(lines);
    const positions = (lines.geometry.getAttribute('position') as THREE.BufferAttribute)
      .array as Float32Array;
    const colors = (lines.geometry.getAttribute('color') as THREE.BufferAttribute)
      .array as Float32Array;
    all.forEach((segment, index) => {
      this.pose(segment);
      let contact = segment.contact;
      if (!contact && segment === this.chest && physics) {
        const hit = this.probe(segment, physics, exclude);
        contact = !!hit && hit.depth > CONTACT_TOLERANCE;
      }
      writeCapsuleWire(
        positions,
        colors,
        index * WIRE_VERTICES * 3,
        segment.p0,
        segment.p1,
        segment.shapeRadius,
        contact,
      );
    });
    lines.geometry.setDrawRange(0, all.length * WIRE_VERTICES);
    (lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (lines.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Writes a capsule's wireframe (two end rings and four side lines) as line-segment vertices at `at`. */
function writeCapsuleWire(
  positions: Float32Array,
  colors: Float32Array,
  at: number,
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  radius: number,
  contact: boolean,
): void {
  TMP_DIR.subVectors(p1, p0);
  if (TMP_DIR.lengthSq() < 1e-12) TMP_DIR.set(0, 1, 0);
  TMP_DIR.normalize();
  TMP_A.crossVectors(TMP_DIR, Math.abs(TMP_DIR.y) < 0.9 ? Y_AXIS : X_AXIS).normalize();
  TMP_B.crossVectors(TMP_DIR, TMP_A);
  let cursor = at;
  const vertex = (x: number, y: number, z: number) => {
    positions[cursor] = x;
    positions[cursor + 1] = y;
    positions[cursor + 2] = z;
    colors[cursor] = contact ? 1 : 0;
    colors[cursor + 1] = contact ? 0 : 1;
    colors[cursor + 2] = 0;
    cursor += 3;
  };
  const ring = (centre: THREE.Vector3, i: number) => {
    const angle = (i / WIRE_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(angle) * radius;
    const s = Math.sin(angle) * radius;
    return [
      centre.x + TMP_A.x * c + TMP_B.x * s,
      centre.y + TMP_A.y * c + TMP_B.y * s,
      centre.z + TMP_A.z * c + TMP_B.z * s,
    ] as const;
  };
  for (const centre of [p0, p1]) {
    for (let i = 0; i < WIRE_SEGMENTS; i += 1) {
      const a = ring(centre, i);
      const b = ring(centre, i + 1);
      vertex(a[0], a[1], a[2]);
      vertex(b[0], b[1], b[2]);
    }
  }
  for (let i = 0; i < 4; i += 1) {
    const a = ring(p0, i * (WIRE_SEGMENTS / 4));
    const b = ring(p1, i * (WIRE_SEGMENTS / 4));
    vertex(a[0], a[1], a[2]);
    vertex(b[0], b[1], b[2]);
  }
}
