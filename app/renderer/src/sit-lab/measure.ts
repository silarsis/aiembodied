/**
 * What is measured of the body on one frame: penetration into furniture, into itself, the gap between buttocks and
 * seat, the soles' height and where the feet are. Penetration uses the contact solver's own body capsules.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { PenetrationHit } from '../rooms/room-physics.js';
import type { RestLegLengths } from '../rooms/scene-actions.js';
import { seatedContactY } from '../rooms/seat-fit.js';
import { alongSeat, horizontalDistance, type Destination } from './destination.js';
import type { LabRig } from './lab-rig.js';
import {
  normalizeVec,
  segmentDistance,
  vecAdd,
  vecDot,
  vecScale,
  vecSub,
  type Quat,
  type Vec3,
} from './pose-math.js';

export interface Capsule {
  name: string;
  p0: Vec3;
  p1: Vec3;
  radius: number;
}

/** What the room's colliders answer; `RoomPhysics` satisfies it. */
export interface Colliders {
  penetration(
    shape: RAPIER.Shape,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
  ): PenetrationHit | null;
}

export interface FrameMeasure {
  /** Deepest body capsule inside furniture or a wall (metres, 0 when clear). */
  furniturePen: number;
  /** Deepest overlap of two body parts beyond what the avatar's rest pose already has (metres, see `selfPenetration`). */
  selfPen: number;
  /** The pair behind `selfPen`, like `leftThigh/rightThigh`; null when nothing overlaps. */
  selfPenPair: string | null;
  /** Buttocks height minus the seat surface under them: positive floats, negative sinks. */
  seatGap: number;
  hips: Vec3;
  /** Horizontal distance from the pelvis to the sit point. */
  pelvisToSit: number;
  /** Height of the lowest point of each foot above the floor in front of the seat: [left, right]. */
  sole: [number, number];
  /** How far in front of the sit point each ankle is, along the seat's facing: [left, right]. */
  ankleAlong: [number, number];
  /** Ankle bones in the world: [left, right]. */
  feet: [Vec3, Vec3];
}

const shapes = new Map<string, RAPIER.Capsule>();
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

/** Rotation taking +Y to the unit vector `to`. */
function fromYTo(to: Vec3): Quat {
  const [x, y, z] = to;
  // The axis is Y x to = (z, 0, -x); the half-angle form is stable except when `to` is straight down.
  if (y < -0.999999) return [1, 0, 0, 0];
  const w = 1 + y;
  const length = Math.hypot(z, -x, w);
  return [z / length, 0, -x / length, w / length];
}

/** A body capsule counts as clear of furniture below this depth (metres). */
export const FURNITURE_CLEAR = 0.004;

/**
 * Depth a capsule is inside furniture or walls. The floor is not counted (the motion model owns the floor), and
 * the rounded hip end of a thigh lying on the seat is not either: that is the buttocks, which `seatGap` measures.
 */
export function furnitureDepth(colliders: Colliders, capsule: Capsule, seatId: string): number {
  const axis = vecSub(capsule.p1, capsule.p0);
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (length < 1e-6) return 0;
  const direction = normalizeVec(axis);
  const centre = vecScale(vecAdd(capsule.p0, capsule.p1), 0.5);
  const q = fromYTo(direction);
  const hit = colliders.penetration(
    capsuleShape(length / 2, capsule.radius),
    { x: centre[0], y: centre[1], z: centre[2] },
    { x: q[0], y: q[1], z: q[2], w: q[3] },
  );
  if (!hit) return 0;
  if (hit.objectId === null && hit.normal.y > 0.5) return 0;
  if (hit.objectId === seatId && /Thigh$/.test(capsule.name)) {
    const along = vecDot(vecSub([hit.point.x, hit.point.y, hit.point.z], capsule.p0), direction);
    if (along < capsule.radius) return 0;
  }
  return hit.depth;
}

const ARM_PARTS = ['UpperArm', 'Forearm', 'Hand'];
const LEG_PARTS = ['Thigh', 'Shin', 'Foot'];

/** Pairs of body parts that must stay apart: arms against torso and legs, one leg against the other. */
function selfPairs(names: readonly string[]): Array<[string, string]> {
  const present = new Set(names);
  const pairs: Array<[string, string]> = [];
  const add = (a: string, b: string) => {
    if (present.has(a) && present.has(b)) pairs.push([a, b]);
  };
  for (const side of ['left', 'right']) {
    for (const arm of ARM_PARTS) {
      // The upper arm hangs from the shoulder beside the chest; only the parts beyond it can sink into it.
      if (arm !== 'UpperArm') add(`${side}${arm}`, 'chest');
      add(`${side}${arm}`, 'pelvis');
      for (const legSide of ['left', 'right']) {
        for (const leg of LEG_PARTS) add(`${side}${arm}`, `${legSide}${leg}`);
      }
    }
  }
  for (const a of LEG_PARTS) for (const b of LEG_PARTS) add(`left${a}`, `right${b}`);
  return pairs;
}

/** Overlap in excess of rest below this (metres) is pose noise, not a penetration, and is reported as none. */
const SELF_PEN_NOISE = 0.001;

/** The overlap of each pair that must stay apart in the avatar's own rest pose, by pair key (see `restSelfOverlaps`). */
export type RestOverlaps = ReadonlyMap<string, number>;

function pairKey(a: string, b: string): string {
  return `${a}/${b}`;
}

function overlapOf(first: Capsule, second: Capsule): number {
  return first.radius + second.radius - segmentDistance(first.p0, first.p1, second.p0, second.p1);
}

function checkedPairs(
  capsules: readonly Capsule[],
): Array<{ key: string; first: Capsule; second: Capsule }> {
  const byName = new Map(capsules.map((c) => [c.name, c]));
  const found: Array<{ key: string; first: Capsule; second: Capsule }> = [];
  for (const [a, b] of selfPairs([...byName.keys()])) {
    const first = byName.get(a);
    const second = byName.get(b);
    if (first && second) found.push({ key: pairKey(a, b), first, second });
  }
  return found;
}

/**
 * How much each checked pair overlaps with the avatar standing at rest. The thigh capsules of the two legs share
 * the hips and overlap there in every pose, so only overlap beyond this counts as a self penetration. Compute it
 * once, when the avatar loads.
 */
export function restSelfOverlaps(capsules: readonly Capsule[]): RestOverlaps {
  return new Map(
    checkedPairs(capsules).map(({ key, first, second }) => [
      key,
      Math.max(0, overlapOf(first, second)),
    ]),
  );
}

/**
 * Deepest overlap among the parts that must not touch (metres, 0 when none), in excess of the pair's rest overlap.
 * A hand against a thigh or the pelvis counts only once the hand's own axis is inside that part: resting a hand
 * on the lap is natural contact, not a penetration.
 */
function selfPenetration(
  capsules: readonly Capsule[],
  rest: RestOverlaps,
): { depth: number; pair: string | null } {
  let deepest = SELF_PEN_NOISE;
  let pair: string | null = null;
  for (const { key, first, second } of checkedPairs(capsules)) {
    const hand = /Hand$/.test(first.name) ? first : null;
    const lap = /Thigh$|^pelvis$/.test(second.name);
    const handAllowance = hand && lap ? hand.radius : 0;
    const depth = overlapOf(first, second) - (rest.get(key) ?? 0) - handAllowance;
    if (depth > deepest) {
      deepest = depth;
      pair = key;
    }
  }
  return pair === null ? { depth: 0, pair } : { depth: deepest, pair };
}

export interface MeasureWorld {
  colliders: Colliders | null;
  /** Height of the seat surface at world (x, z), or null off the seat. */
  surfaceAt(x: number, z: number): number | null;
}

export class FrameMeasurer {
  constructor(
    private readonly rig: LabRig,
    private readonly dest: Destination,
    private readonly world: MeasureWorld,
    private readonly legs: RestLegLengths | null,
    private readonly restOverlaps: RestOverlaps,
  ) {}

  /** The self penetration of a set of body capsules against this avatar's rest overlaps. */
  selfPenetration(capsules: readonly Capsule[]): { depth: number; pair: string | null } {
    return selfPenetration(capsules, this.restOverlaps);
  }

  measure(): FrameMeasure {
    const { rig, dest } = this;
    rig.updateWorld();
    const capsules = rig.capsules();
    let furniturePen = 0;
    if (this.world.colliders) {
      for (const capsule of capsules) {
        furniturePen = Math.max(
          furniturePen,
          furnitureDepth(this.world.colliders, capsule, dest.seatId),
        );
      }
    }
    const hips = rig.world('hips');
    const surface = this.world.surfaceAt(hips[0], hips[2]) ?? dest.surfaceY;
    const ankleHeight = (this.legs?.ankleHeight ?? 0) * dest.scale;
    const selfPen = this.selfPenetration(capsules);
    const leftAnkle = rig.world('leftFoot');
    const rightAnkle = rig.world('rightFoot');
    return {
      furniturePen,
      selfPen: selfPen.depth,
      selfPenPair: selfPen.pair,
      seatGap: seatedContactY(hips[1], rig.restHipsHeight, dest.scale) - surface,
      hips,
      pelvisToSit: horizontalDistance(hips, dest.sitPoint),
      sole: [
        leftAnkle[1] - ankleHeight - dest.footFloorY,
        rightAnkle[1] - ankleHeight - dest.footFloorY,
      ],
      ankleAlong: [alongSeat(dest, leftAnkle), alongSeat(dest, rightAnkle)],
      feet: [leftAnkle, rightAnkle],
    };
  }
}
