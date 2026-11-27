/**
 * Where a sit should end, as data derived from the seat's geometry: the support surface and the pelvis height
 * that rests on it, the knee line past the front edge, the floor zone for the feet and the contacts the body may
 * have. Methods read this and know nothing about the seat's shape (sofa, armchair, stool).
 */
import { CAPSULE_RADII } from '../rooms/contact-body.js';
import type { PlanWorld, RestLegLengths } from '../rooms/scene-actions.js';
import { hipsAboveSeat, REFERENCE_HIPS_HEIGHT } from '../rooms/seat-fit.js';
import { degToRad } from '../rooms/scene-frames.js';
import type { Vec3 } from './pose-math.js';

export interface Destination {
  seatId: string;
  /** The sit tag in the world (its y is the tag's height, which is only a guess). */
  sitPoint: Vec3;
  /** World yaw of the seat's facing, radians. */
  facing: number;
  /** Unit vectors on the floor plane (x, z): along the facing, and to the avatar's left when seated. */
  forward: [number, number];
  left: [number, number];
  /** Height of the support surface under the sit point. */
  surfaceY: number;
  /** Hips height whose buttocks rest on the surface. */
  pelvisY: number;
  /** Metres from the sit point forward to where the seat ends. */
  frontEdge: number;
  /** Floor height in front of the seat. */
  footFloorY: number;
  /** World size of the avatar over the reference 0.95 m-hips avatar: scales capsule radii and body offsets. */
  bodyFactor: number;
  /** World scale of the avatar root. */
  scale: number;
  /** Objects the body may touch while seated. */
  allowedContacts: readonly string[];
}

export function destinationFor(world: PlanWorld, seatId: string): Destination {
  const geometry = world.seatGeometry?.(seatId);
  if (!geometry) throw new Error(`${seatId} has no measurable seat (it needs a sit tag).`);
  const { scale } = world.frame;
  const facing = degToRad(geometry.facing);
  const [sx, sy, sz] = geometry.position;
  const surfaceY = world.seatSurfaceY?.(seatId, sx, sz) ?? geometry.seatTopY;
  return {
    seatId,
    sitPoint: [sx, sy, sz],
    facing,
    forward: [Math.sin(facing), Math.cos(facing)],
    left: [Math.cos(facing), -Math.sin(facing)],
    surfaceY,
    pelvisY: surfaceY + hipsAboveSeat(world.restHipsHeight, scale),
    frontEdge: geometry.frontEdge,
    footFloorY: geometry.footFloorY,
    bodyFactor: (world.restHipsHeight / REFERENCE_HIPS_HEIGHT) * scale,
    scale,
    allowedContacts: [seatId],
  };
}

export interface LegPoints {
  leftKnee: Vec3;
  rightKnee: Vec3;
  leftAnkle: Vec3;
  rightAnkle: Vec3;
}

export interface LegSpec {
  /** Metres the knees go past the seat's front edge. */
  kneeOverhang: number;
  /** Metres the ankles go in front of the knees beyond a straight shin (which only just reaches the floor). */
  footForward: number;
}

/**
 * The knee and ankle positions a seated body should have: knees one thigh radius above the surface, a hip width
 * apart and past the front edge (but within the thigh's reach of the pelvis); ankles on the floor in front of them.
 */
export function legPoints(
  dest: Destination,
  legs: RestLegLengths,
  hipHalfSpacing: number,
  spec: LegSpec,
): LegPoints {
  const thigh = legs.thigh * dest.scale;
  const shin = legs.shin * dest.scale;
  const kneeY = dest.surfaceY + CAPSULE_RADII.thigh * dest.bodyFactor;
  const reach = Math.sqrt(Math.max(thigh * thigh - (kneeY - dest.pelvisY) ** 2, 0));
  const ahead = Math.min(dest.frontEdge + spec.kneeOverhang, reach);
  const ankleFloor = dest.footFloorY + legs.ankleHeight * dest.scale;
  const drop = kneeY - ankleFloor;
  const reachesFloor = drop > 0 && drop < shin;
  const straightStep = reachesFloor ? Math.sqrt(shin * shin - drop * drop) : 0;
  const step = straightStep + spec.footForward;
  const ankleY = reachesFloor ? ankleFloor : kneeY - shin;
  const point = (side: 1 | -1, along: number, y: number): Vec3 => [
    dest.sitPoint[0] + dest.forward[0] * along + dest.left[0] * side * hipHalfSpacing,
    y,
    dest.sitPoint[2] + dest.forward[1] * along + dest.left[1] * side * hipHalfSpacing,
  ];
  return {
    leftKnee: point(1, ahead, kneeY),
    rightKnee: point(-1, ahead, kneeY),
    leftAnkle: point(1, ahead + step, ankleY),
    rightAnkle: point(-1, ahead + step, ankleY),
  };
}

/** Distance along the seat's facing from the sit point (negative behind it), for a world point. */
export function alongSeat(dest: Destination, p: Vec3): number {
  return (p[0] - dest.sitPoint[0]) * dest.forward[0] + (p[2] - dest.sitPoint[2]) * dest.forward[1];
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}
