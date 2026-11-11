/**
 * Plans scene actions ({go:X}, {sit:X}, {pick:X}, ...) into motion stream requests. Everything here
 * is pure: the world (room, navmesh, current positions) comes in through `PlanWorld`, and the
 * result says what to ask the motion service, which events to fire while it plays and where the
 * avatar ends up. The executor in scene-executor.ts runs the plans.
 */
import type { RoomFile, RoomObject, Vec3 } from '../../../main/src/rooms/types.js';
import type { AvatarMotionPhase, AvatarMotionPath, AvatarMotionTarget } from '../avatar/types.js';
import type { SceneTag } from '../avatar/animation-tags.js';
import { degToRad } from './room-geometry.js';
import type { AvatarOccupancy } from './room-occupancy.js';
import { worldTag } from './room-tags.js';
import { heightToMotion, worldToMotion, worldYawToMotion, yawToward, type MotionFrame } from './scene-frames.js';

export type Hand = 'left' | 'right';

export type SceneAction =
  | { kind: 'go'; objectId: string }
  /** Walk to a world point; used to get near things for pick and put. */
  | { kind: 'goto'; position: Vec3; faceToward?: Vec3 }
  | { kind: 'come' }
  | { kind: 'look'; objectId: string }
  /** Turn on the spot to face a world point (the camera, when the user starts talking). Never stands up. */
  | { kind: 'lookAtPoint'; position: Vec3; label?: string }
  | { kind: 'sit'; objectId: string }
  | { kind: 'stand' }
  | { kind: 'pick'; objectId: string }
  | { kind: 'put'; objectId: string; surfaceId: string };

export interface SeatState {
  objectId: string;
  /** The motion service session to continue from when standing up. */
  session: string;
  /** The motion frame of the sit stream; it is kept while seated because the hips are in it. */
  frame: MotionFrame;
  /** Where the avatar stood before sitting (world), and where it stands up to. */
  approach: Vec3;
  /** World yaw of the seat's facing. */
  facing: number;
}

export interface HeldState {
  objectId: string;
  hand: Hand;
}

export interface AvatarState {
  posture: 'standing' | 'seated';
  seat?: SeatState;
  held: HeldState | null;
}

export const INITIAL_STATE: AvatarState = { posture: 'standing', held: null };

/** What a plan needs to know about the world right now. */
export interface PlanWorld {
  room: RoomFile;
  hasNavigation: boolean;
  findPath(from: Vec3, to: Vec3): Vec3[] | null;
  closestWalkable(p: Vec3): Vec3;
  /** Current world position of an object's floor-contact origin (props may have moved). */
  objectPosition(id: string): Vec3 | null;
  /** The motion frame a fresh stream would use: origin = the avatar's root now. */
  frame: MotionFrame;
  /** Standing pelvis height in avatar metres (the rest skeleton's hips height). */
  restHipsHeight: number;
  /** Width over height of the room view, for judging what the camera can see. */
  cameraAspect?: number;
  /** Other avatars in the room: where they stand now and where they are heading. Set only with 2+ avatars. */
  others?: Array<{ id: string; x: number; z: number; goal?: { x: number; z: number } }>;
  /** This avatar's claims on spots, seats, objects and the walking turn. Set only with 2+ avatars. */
  occupancy?: AvatarOccupancy;
}

export interface StreamEvent {
  /** Seconds into the stream. */
  t: number;
  kind: 'attach' | 'detach';
  objectId: string;
  hand: Hand;
  /** For a detach: where the object may be put down. */
  surface?: SurfaceSpec;
}

export interface SurfaceSpec {
  objectId: string;
  /** World height of the top. */
  y: number;
  /** Clamp a world floor point onto the top (inset from the edge). */
  clamp(x: number, z: number): [number, number];
}

export interface StreamRequestPlan {
  prompt: string;
  duration: number;
  phases?: AvatarMotionPhase[];
  path?: AvatarMotionPath;
  targets?: AvatarMotionTarget[];
  continueFrom?: string;
}

export interface PlannedStream {
  label: string;
  request: StreamRequestPlan;
  /** The frame the stream's coordinates are in (and the root is baked against). */
  frame: MotionFrame;
  /** Used for the bake when the service reports no end pose. */
  expectedEnd: { root: [number, number]; heading: number };
  events: StreamEvent[];
  /** The avatar's posture after it plays. `seat` carries no session yet. */
  outcome: { posture: 'standing' } | { posture: 'seated'; seat: Omit<SeatState, 'session'> };
  /** `undefined`: unchanged. */
  held?: HeldState | null;
}

export type ActionPlan =
  | { type: 'skip'; reason: string }
  | { type: 'insert'; actions: SceneAction[] }
  | { type: 'stream'; stream: PlannedStream };

export const WALK_PROMPT = 'a person walks calmly';
export const LOOK_PROMPT = 'a person turns to look at something';
export const SIT_PROMPT = 'a person turns around and sits down on a chair';
export const STAND_PROMPT = 'a person stands up from the chair';
export const REACH_PROMPT = 'a person reaches out and picks something up from a table';
export const REACH_FLOOR_PROMPT = 'a person bends down and picks something up from the floor';
export const PLACE_PROMPT = 'a person reaches out and puts something down on a table';

export const CHUNK_SECONDS = 2;
export const MAX_DURATION = 30;
const WALK_START_S = 0.3;
const WALK_SPEED = 1.0;
const CORNER_RADIUS = 0.6;
const ARRIVE_HEADING_DELAY = 0.5;
const LOOK_TOLERANCE = (20 * Math.PI) / 180;
const FACE_TOLERANCE = (25 * Math.PI) / 180;
const MIN_WALK = 0.25;
/** Turn on the spot before walking when the path starts further than this from straight ahead. */
const TURN_FIRST_ANGLE = (60 * Math.PI) / 180;
/** How far along the path its starting direction is measured. */
const TURN_LOOKAHEAD = 0.4;
/** Seconds the walk waits after the turn has finished. */
const TURN_SETTLE_S = 0.2;
const SIT_APPROACH = 0.45;
const SEAT_HEIGHT_OFFSET = 0.08;
const REACH_DISTANCE = 0.7;
const FRONT_OF_FACE = 0.5;
const SURFACE_INSET = 0.15;
const REACH_T = 1.5;
const REACH_UNTIL = 1.8;
const GRAB_EVENT_T = 1.7;
const REACH_DURATION = 3;
const LOW_OBJECT = 0.45;

// -- Names ------------------------------------------------------------------------------------

function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(?:the|a|an|my|your|that|this|some)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singular(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && /(?:ses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function singularPhrase(value: string): string {
  const words = value.split(' ');
  const last = words.pop() ?? '';
  return [...words, singular(last)].join(' ');
}

/**
 * Finds the room object a tag argument means: by id or name, ignoring case, articles and a simple
 * plural ("the mugs"). A bare noun such as "table" also matches when exactly one object's name ends
 * with it. Returns null when nothing or more than one object fits.
 */
export function resolveObjectRef(room: RoomFile, ref: string): RoomObject | null {
  const wanted = singularPhrase(normaliseName(ref));
  if (!wanted) return null;
  const exact = room.objects.filter(
    (object) =>
      singularPhrase(normaliseName(object.id)) === wanted || singularPhrase(normaliseName(object.name)) === wanted,
  );
  if (exact.length > 0) return exact.length === 1 ? (exact[0] ?? null) : null;
  const loose = room.objects.filter((object) => {
    const name = singularPhrase(normaliseName(object.name));
    return name.endsWith(` ${wanted}`) || name.startsWith(`${wanted} `);
  });
  return loose.length === 1 ? (loose[0] ?? null) : null;
}

/** Turns a parsed tag into an action, or null (with a warning) when the room has no such object. */
export function tagToAction(room: RoomFile, tag: SceneTag): SceneAction | null {
  const find = (ref: string): RoomObject | null => {
    const object = resolveObjectRef(room, ref);
    if (!object) console.warn(`[scene-actions] no object "${ref}" in ${room.name}`);
    return object;
  };
  switch (tag.type) {
    case 'stand':
    case 'come':
      return tag.type === 'stand' ? { kind: 'stand' } : { kind: 'come' };
    case 'go':
    case 'sit':
    case 'look':
    case 'pick': {
      const object = find(tag.object);
      return object ? { kind: tag.type, objectId: object.id } : null;
    }
    case 'put': {
      const object = find(tag.object);
      const surface = find(tag.surface);
      return object && surface ? { kind: 'put', objectId: object.id, surfaceId: surface.id } : null;
    }
  }
}

// -- Geometry ---------------------------------------------------------------------------------

function objectById(room: RoomFile, id: string): RoomObject | undefined {
  return room.objects.find((object) => object.id === id);
}

/** Local axes of an object's footprint in the world: [x axis, z axis] as (x, z) pairs. */
function footprintAxes(object: RoomObject): [[number, number], [number, number]] {
  const a = degToRad(object.rotationY ?? 0);
  return [
    [Math.cos(a), -Math.sin(a)],
    [Math.sin(a), Math.cos(a)],
  ];
}

/**
 * The closest walkable point in front of the object's face that looks towards the room centre,
 * about half a metre out.
 */
export function frontOfFace(world: PlanWorld, object: RoomObject): Vec3 {
  const [ax, az] = footprintAxes(object);
  const halves: [number, number] = [object.size[0] / 2, object.size[2] / 2];
  let best: { normal: [number, number]; centre: [number, number]; score: number } | null = null;
  for (const [axis, half] of [
    [ax, halves[0]],
    [az, halves[1]],
  ] as const) {
    for (const sign of [1, -1]) {
      const normal: [number, number] = [axis[0] * sign, axis[1] * sign];
      const centre: [number, number] = [object.position[0] + normal[0] * half, object.position[2] + normal[1] * half];
      // How directly the face looks at the room centre (origin).
      const score = -centre[0] * normal[0] - centre[1] * normal[1];
      if (!best || score > best.score) best = { normal, centre, score };
    }
  }
  if (!best) return world.closestWalkable([object.position[0], 0, object.position[2]]);
  const face = best;
  const candidate: Vec3 = [
    face.centre[0] + face.normal[0] * FRONT_OF_FACE,
    0,
    face.centre[1] + face.normal[1] * FRONT_OF_FACE,
  ];
  return world.closestWalkable(candidate);
}

/** The point on the object's footprint closest to `from`, pulled `inset` metres in from the edge. */
export function nearestFootprintPoint(object: RoomObject, from: Vec3, inset: number): [number, number] {
  const [ax, az] = footprintAxes(object);
  const dx = from[0] - object.position[0];
  const dz = from[2] - object.position[2];
  const lx = dx * ax[0] + dz * ax[1];
  const lz = dx * az[0] + dz * az[1];
  const limit = (half: number) => Math.max(0, half - inset);
  const cx = Math.max(-limit(object.size[0] / 2), Math.min(limit(object.size[0] / 2), lx));
  const cz = Math.max(-limit(object.size[2] / 2), Math.min(limit(object.size[2] / 2), lz));
  return [
    object.position[0] + cx * ax[0] + cz * az[0],
    object.position[2] + cx * ax[1] + cz * az[1],
  ];
}

function polylineLength(points: Array<[number, number]>): number {
  let total = 0;
  let previous = points[0];
  for (const point of points.slice(1)) {
    if (previous) total += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return total;
}

function horizontal(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function rootWorld(world: PlanWorld): Vec3 {
  return [world.frame.origin.x, 0, world.frame.origin.z];
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Start the walk at the avatar itself, then follow the navmesh path in the motion frame. */
function pathInMotionFrame(world: PlanWorld, path: Vec3[]): Array<[number, number]> {
  const points = path.map((p) => worldToMotion(world.frame, p[0], p[2]));
  points[0] = [0, 0];
  return points;
}

/** Heading (motion frame) of the path's start: toward the point `TURN_LOOKAHEAD` metres along it. */
export function pathStartHeading(points: Array<[number, number]>): number | null {
  let travelled = 0;
  let previous = points[0];
  if (!previous) return null;
  for (const point of points.slice(1)) {
    const leg = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    travelled += leg;
    if (travelled >= TURN_LOOKAHEAD || point === points[points.length - 1]) {
      const origin = points[0] ?? [0, 0];
      if (Math.hypot(point[0] - origin[0], point[1] - origin[1]) < 1e-6) return null;
      return Math.atan2(point[0] - origin[0], point[1] - origin[1]);
    }
    previous = point;
  }
  return null;
}

/**
 * When the path starts well off to the side or behind, the avatar turns on the spot to face along
 * it first, then walks, instead of setting off sideways or backwards. Returns when the walk starts
 * and the turn target (none when the path starts roughly ahead).
 */
export function walkStart(world: PlanWorld, points: Array<[number, number]>): { startS: number; targets: AvatarMotionTarget[] } {
  const heading = pathStartHeading(points);
  if (heading === null || Math.abs(heading) <= TURN_FIRST_ANGLE) return { startS: WALK_START_S, targets: [] };
  const turnS = roundMs(0.5 + (0.6 * Math.abs(heading)) / Math.PI);
  return {
    startS: roundMs(turnS + TURN_SETTLE_S),
    targets: [{ t: turnS, root: [0, 0], height: world.restHipsHeight, heading: roundMs(heading) }],
  };
}

// -- Plans ------------------------------------------------------------------------------------

function skip(reason: string): ActionPlan {
  return { type: 'skip', reason };
}

/** Another avatar's standing spot this close to a path segment makes the walk step around it. */
const SIDE_STEP_CLEARANCE = 0.45;
/** How far from the other avatar's spot the side-step waypoint is put. */
const SIDE_STEP_OFFSET = 0.6;

function distanceToSegment(px: number, pz: number, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[2]) * dz) / lengthSq));
  return Math.hypot(px - (a[0] + t * dx), pz - (a[2] + t * dz));
}

/**
 * One pass over the path: where a segment passes within 0.45 m of another avatar's standing spot (the
 * goal's own neighbourhood does not count), a waypoint is inserted beside the spot, left of the
 * segment first, then right, whichever is walkable and clears the spot. When neither is, the
 * segment is left as it is.
 */
export function sideStepPath(world: PlanWorld, path: Vec3[]): Vec3[] {
  const others = world.others;
  if (!world.occupancy || !others || others.length === 0 || path.length < 2) return path;
  const goal = path[path.length - 1];
  if (!goal) return path;
  const result: Vec3[] = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    result.push(a);
    const inserts: Array<{ along: number; point: Vec3 }> = [];
    for (const other of others) {
      if (Math.hypot(other.x - goal[0], other.z - goal[2]) < SIDE_STEP_CLEARANCE) continue;
      if (distanceToSegment(other.x, other.z, a, b) >= SIDE_STEP_CLEARANCE) continue;
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const length = Math.hypot(dx, dz);
      if (length < 1e-6) continue;
      const leftX = -dz / length;
      const leftZ = dx / length;
      for (const side of [1, -1]) {
        const wanted: Vec3 = [other.x + side * leftX * SIDE_STEP_OFFSET, 0, other.z + side * leftZ * SIDE_STEP_OFFSET];
        const snapped = world.closestWalkable(wanted);
        const moved = Math.hypot(snapped[0] - wanted[0], snapped[2] - wanted[2]);
        const clears = Math.hypot(snapped[0] - other.x, snapped[2] - other.z) >= SIDE_STEP_CLEARANCE;
        if (moved > 0.2 || !clears) continue;
        inserts.push({ along: (other.x - a[0]) * dx / length + (other.z - a[2]) * dz / length, point: [snapped[0], a[1], snapped[2]] });
        break;
      }
    }
    inserts.sort((first, second) => first.along - second.along);
    for (const insert of inserts) result.push(insert.point);
  }
  const last = path[path.length - 1];
  if (last) result.push(last);
  return result;
}

/**
 * The goal of a walk, moved to a free spot when another avatar stands or is heading there. Null when
 * there is no free spot near it. Without occupancy (one avatar) the goal is returned as it is.
 */
function freeGoal(world: PlanWorld, target: Vec3): Vec3 | null {
  if (!world.occupancy) return target;
  const free = world.occupancy.freeSpotNear({ x: target[0], z: target[2] }, (p) => {
    const snapped = world.closestWalkable([p.x, 0, p.z]);
    return { x: snapped[0], z: snapped[2] };
  });
  return free ? [free.x, target[1], free.z] : null;
}

const OCCUPIED_SPOT = 'someone is standing there';

function walkPlan(
  world: PlanWorld,
  target: Vec3,
  faceYaw: number | null,
  label: string,
  prompt = WALK_PROMPT,
): ActionPlan {
  if (!world.hasNavigation) return skip('navigation is unavailable in this room');
  const goal = freeGoal(world, target);
  if (!goal) return skip(OCCUPIED_SPOT);
  const found = world.findPath(rootWorld(world), goal);
  if (!found) return skip(`no walkable path to ${label}`);
  const path = sideStepPath(world, found);
  const points = pathInMotionFrame(world, path);
  const length = polylineLength(points);
  const headingOf = (yaw: number) => worldYawToMotion(world.frame, yaw);

  if (length < MIN_WALK) {
    if (faceYaw === null || Math.abs(headingOf(faceYaw)) < LOOK_TOLERANCE) return skip(`already at ${label}`);
    return turnPlan(world, faceYaw, label);
  }

  const start = walkStart(world, points);
  const arrival = start.startS + length / WALK_SPEED;
  const duration = roundMs(arrival + 1.5);
  if (duration > MAX_DURATION) return skip(`${label} is too far to walk in one go`);
  const end = points[points.length - 1] ?? [0, 0];
  const lastLeg = points[points.length - 2] ?? [0, 0];
  const heading = faceYaw === null ? Math.atan2(end[0] - lastLeg[0], end[1] - lastLeg[1]) : headingOf(faceYaw);
  world.occupancy?.claimSpot({ x: goal[0], z: goal[2] });
  const targets: AvatarMotionTarget[] = [
    ...start.targets,
    ...(faceYaw === null
      ? []
      : [{ t: roundMs(arrival + ARRIVE_HEADING_DELAY), root: end, height: world.restHipsHeight, heading }]),
  ];
  return {
    type: 'stream',
    stream: {
      label,
      request: {
        prompt,
        duration,
        path: { points, cornerRadius: CORNER_RADIUS, speed: WALK_SPEED, startS: start.startS, mode: 'dense' },
        ...(targets.length > 0 ? { targets } : {}),
      },
      frame: world.frame,
      expectedEnd: { root: end, heading },
      events: [],
      outcome: { posture: 'standing' },
    },
  };
}

function turnPlan(world: PlanWorld, faceYaw: number, label: string): ActionPlan {
  const heading = worldYawToMotion(world.frame, faceYaw);
  if (Math.abs(heading) < LOOK_TOLERANCE) return skip(`already facing ${label}`);
  return {
    type: 'stream',
    stream: {
      label,
      request: {
        prompt: LOOK_PROMPT,
        duration: 2.5,
        targets: [{ t: 1.5, until: 2.5, root: [0, 0], height: world.restHipsHeight, heading }],
      },
      frame: world.frame,
      expectedEnd: { root: [0, 0], heading },
      events: [],
      outcome: { posture: 'standing' },
    },
  };
}

/** The point an object is looked at: its look tag, else the middle of its box. */
function lookPoint(room: RoomFile, object: RoomObject, position: Vec3): Vec3 {
  const tagged = worldTag(room, object.id, 'look');
  if (tagged) return [tagged.position[0] + (position[0] - object.position[0]), tagged.position[1], tagged.position[2] + (position[2] - object.position[2])];
  return [position[0], position[1] + object.size[1] / 2, position[2]];
}

function planGo(world: PlanWorld, object: RoomObject): ActionPlan {
  const position = world.objectPosition(object.id) ?? object.position;
  const stand = worldTag(world.room, object.id, 'stand');
  const target = stand ? ([stand.position[0], 0, stand.position[2]] as Vec3) : frontOfFace(world, object);
  const look = lookPoint(world.room, object, position);
  return walkPlan(world, target, yawToward(target, look), object.name);
}

function planCome(world: PlanWorld): ActionPlan {
  const { position, facing } = world.room.home;
  return walkPlan(world, [position[0], 0, position[2]], degToRad(facing), 'its home spot');
}

function planLook(world: PlanWorld, object: RoomObject): ActionPlan {
  const position = world.objectPosition(object.id) ?? object.position;
  const point = lookPoint(world.room, object, position);
  return turnPlan(world, yawToward(rootWorld(world), point), object.name);
}

function planSit(world: PlanWorld, object: RoomObject): ActionPlan {
  const sit = worldTag(world.room, object.id, 'sit');
  if (!sit) return skip(`${object.name} cannot be sat on`);
  const { frame } = world;
  const facing = degToRad(sit.facing ?? 0);
  const seat: Vec3 = [sit.position[0], sit.position[1], sit.position[2]];
  const ideal: Vec3 = [seat[0] + SIT_APPROACH * Math.sin(facing), 0, seat[2] + SIT_APPROACH * Math.cos(facing)];

  let approach: Vec3 = rootWorld(world);
  let points: Array<[number, number]> | null = null;
  if (horizontal(approach, ideal) >= MIN_WALK) {
    if (!world.hasNavigation) return skip('navigation is unavailable in this room');
    const goal = freeGoal(world, ideal);
    if (!goal) return skip(OCCUPIED_SPOT);
    const found = world.findPath(approach, goal);
    if (!found) return skip(`no walkable path to ${object.name}`);
    const path = sideStepPath(world, found);
    const converted = pathInMotionFrame(world, path);
    if (polylineLength(converted) >= MIN_WALK) {
      points = converted;
      approach = path[path.length - 1] ?? approach;
    }
  }

  const start = points ? walkStart(world, points) : null;
  const arrival = points && start ? start.startS + polylineLength(points) / WALK_SPEED : 0;
  const phaseStart = points ? Math.ceil(arrival / CHUNK_SECONDS - 1e-9) * CHUNK_SECONDS : 0;
  const duration = roundMs(phaseStart + 4);
  if (duration > MAX_DURATION) return skip(`${object.name} is too far to walk to in one go`);
  const occupancy = world.occupancy;
  if (occupancy && !occupancy.claim('seat', object.id)) {
    const holder = occupancy.holder('seat', object.id);
    return skip(`${holder ? occupancy.nameOf(holder) : 'Someone'} is sitting on the ${object.name}`);
  }
  if (points) occupancy?.claimSpot({ x: approach[0], z: approach[2] });
  const root = worldToMotion(frame, seat[0], seat[2]);
  const heading = worldYawToMotion(frame, facing);
  const target: AvatarMotionTarget = {
    t: roundMs(phaseStart + 2),
    until: roundMs(duration - 0.1),
    root,
    height: heightToMotion(frame, seat[1] + SEAT_HEIGHT_OFFSET),
    heading,
    revealS: phaseStart,
  };
  return {
    type: 'stream',
    stream: {
      label: `sit on ${object.name}`,
      request: {
        prompt: points ? WALK_PROMPT : SIT_PROMPT,
        duration,
        ...(points
          ? {
              path: { points, cornerRadius: CORNER_RADIUS, speed: WALK_SPEED, startS: start?.startS ?? WALK_START_S, mode: 'dense' as const },
              phases: [{ prompt: SIT_PROMPT, startS: phaseStart }],
            }
          : {}),
        targets: [...(start?.targets ?? []), target],
      },
      frame,
      expectedEnd: { root, heading },
      events: [],
      outcome: { posture: 'seated', seat: { objectId: object.id, frame, approach, facing } },
    },
  };
}

function planStand(world: PlanWorld, state: AvatarState): ActionPlan {
  const seat = state.seat;
  if (state.posture !== 'seated' || !seat) return skip('already standing');
  const root = worldToMotion(seat.frame, seat.approach[0], seat.approach[2]);
  const heading = worldYawToMotion(seat.frame, seat.facing);
  return {
    type: 'stream',
    stream: {
      label: 'stand up',
      request: {
        prompt: STAND_PROMPT,
        duration: 3,
        continueFrom: seat.session,
        targets: [{ t: 2, until: 2.5, root, height: world.restHipsHeight, heading }],
      },
      frame: seat.frame,
      expectedEnd: { root, heading },
      events: [],
      outcome: { posture: 'standing' },
    },
  };
}

/** The grab point of an object in the world, following the prop if it has moved. */
export function grabPoint(world: PlanWorld, object: RoomObject): Vec3 | null {
  const tag = worldTag(world.room, object.id, 'grab');
  if (!tag) return null;
  const now = world.objectPosition(object.id) ?? object.position;
  return [
    tag.position[0] + now[0] - object.position[0],
    tag.position[1] + now[1] - object.position[1],
    tag.position[2] + now[2] - object.position[2],
  ];
}

function reachStream(
  world: PlanWorld,
  point: Vec3,
  hand: Hand,
  prompt: string,
  events: StreamEvent[],
  held: HeldState | null,
  label: string,
): PlannedStream {
  const { frame } = world;
  const [mx, mz] = worldToMotion(frame, point[0], point[2]);
  const toward = worldYawToMotion(frame, yawToward(rootWorld(world), point));
  // Face what is being reached for when it is well off to the side; otherwise stay as is.
  const heading = horizontal(rootWorld(world), point) > 0.15 && Math.abs(toward) > FACE_TOLERANCE ? toward : 0;
  return {
    label,
    request: {
      prompt,
      duration: REACH_DURATION,
      targets: [
        {
          t: REACH_T,
          until: REACH_UNTIL,
          hand,
          position: [mx, heightToMotion(frame, point[1]), mz],
          root: [0, 0],
          height: world.restHipsHeight,
          heading,
        },
      ],
    },
    frame,
    expectedEnd: { root: [0, 0], heading },
    events,
    outcome: { posture: 'standing' },
    held,
  };
}

/** The hand on the side of the body the point is on (the character's left is +X in the motion frame). */
export function nearerHand(frame: MotionFrame, point: Vec3): Hand {
  return worldToMotion(frame, point[0], point[2])[0] > 0 ? 'left' : 'right';
}

function planPick(world: PlanWorld, state: AvatarState, object: RoomObject): ActionPlan {
  if (!object.dynamic || !object.tags?.grab) return skip(`${object.name} cannot be picked up`);
  if (state.held) {
    return skip(state.held.objectId === object.id ? `already holding ${object.name}` : 'hands are full');
  }
  const point = grabPoint(world, object);
  if (!point) return skip(`${object.name} cannot be picked up`);
  if (horizontal(rootWorld(world), point) > REACH_DISTANCE) {
    return { type: 'insert', actions: [{ kind: 'goto', position: world.closestWalkable(point), faceToward: point }] };
  }
  const occupancy = world.occupancy;
  if (occupancy && !occupancy.claim('object', object.id)) {
    const holder = occupancy.holder('object', object.id);
    return skip(`${holder ? occupancy.nameOf(holder) : 'Someone'} has it`);
  }
  const hand = nearerHand(world.frame, point);
  const low = point[1] < LOW_OBJECT;
  return {
    type: 'stream',
    stream: reachStream(
      world,
      point,
      hand,
      low ? REACH_FLOOR_PROMPT : REACH_PROMPT,
      [{ t: GRAB_EVENT_T, kind: 'attach', objectId: object.id, hand }],
      { objectId: object.id, hand },
      `pick up ${object.name}`,
    ),
  };
}

export function surfaceSpec(surface: RoomObject): SurfaceSpec | null {
  const tag = surface.tags?.surface;
  if (!tag) return null;
  return {
    objectId: surface.id,
    y: surface.position[1] + tag.height,
    clamp: (x, z) => nearestFootprintPoint(surface, [x, 0, z], SURFACE_INSET),
  };
}

function planPut(world: PlanWorld, state: AvatarState, object: RoomObject, surface: RoomObject): ActionPlan {
  const held = state.held;
  if (!held || held.objectId !== object.id) return skip(`not holding ${object.name}`);
  const spec = surfaceSpec(surface);
  if (!spec) return skip(`nothing can be put on ${surface.name}`);
  const [px, pz] = nearestFootprintPoint(surface, rootWorld(world), SURFACE_INSET);
  const target: Vec3 = [px, spec.y, pz];
  if (horizontal(rootWorld(world), target) > REACH_DISTANCE) {
    const stand = worldTag(world.room, surface.id, 'stand');
    const near = stand ? ([stand.position[0], 0, stand.position[2]] as Vec3) : world.closestWalkable(target);
    return { type: 'insert', actions: [{ kind: 'goto', position: near, faceToward: target }] };
  }
  // The hand carries the object a little above the top; the bottom of the object lands on it.
  const grab = worldTag(world.room, object.id, 'grab');
  const lift = grab ? grab.position[1] - object.position[1] : 0.1;
  const wrist: Vec3 = [px, spec.y + lift + 0.04, pz];
  return {
    type: 'stream',
    stream: reachStream(
      world,
      wrist,
      held.hand,
      PLACE_PROMPT,
      [{ t: GRAB_EVENT_T, kind: 'detach', objectId: object.id, hand: held.hand, surface: spec }],
      null,
      `put ${object.name} on ${surface.name}`,
    ),
  };
}

function planLookAtPoint(world: PlanWorld, action: Extract<SceneAction, { kind: 'lookAtPoint' }>): ActionPlan {
  return turnPlan(world, yawToward(rootWorld(world), action.position), action.label ?? 'the camera');
}

function planGoto(world: PlanWorld, action: Extract<SceneAction, { kind: 'goto' }>): ActionPlan {
  const target: Vec3 = [action.position[0], 0, action.position[2]];
  const face = action.faceToward ? yawToward(target, action.faceToward) : null;
  return walkPlan(world, target, face, 'a spot nearby');
}

/** Walking, looking, reaching and the like start from a standing avatar. */
const NEEDS_STANDING = new Set<SceneAction['kind']>(['go', 'goto', 'come', 'look', 'pick', 'put']);

export function planAction(world: PlanWorld, state: AvatarState, action: SceneAction): ActionPlan {
  if (action.kind === 'stand') return planStand(world, state);
  if (action.kind === 'lookAtPoint') return state.posture === 'seated' ? skip('seated') : planLookAtPoint(world, action);
  if (state.posture === 'seated' && (NEEDS_STANDING.has(action.kind) || action.kind === 'sit')) {
    if (action.kind === 'sit' && state.seat?.objectId === action.objectId) return skip('already sitting there');
    return { type: 'insert', actions: [{ kind: 'stand' }] };
  }
  switch (action.kind) {
    case 'come':
      return planCome(world);
    case 'goto':
      return planGoto(world, action);
    case 'go':
    case 'look':
    case 'sit':
    case 'pick': {
      const object = objectById(world.room, action.objectId);
      if (!object) return skip(`no object ${action.objectId}`);
      if (action.kind === 'go') return planGo(world, object);
      if (action.kind === 'look') return planLook(world, object);
      if (action.kind === 'sit') return planSit(world, object);
      return planPick(world, state, object);
    }
    case 'put': {
      const object = objectById(world.room, action.objectId);
      const surface = objectById(world.room, action.surfaceId);
      if (!object || !surface) return skip('unknown object');
      return planPut(world, state, object, surface);
    }
  }
}
