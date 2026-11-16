import type { RoomFile, RoomObject } from '../../../main/src/rooms/types.js';
import type { PlanWorld } from './scene-actions.js';

/** What a model can do with an object, in plain words, from the object's tags. */
export function objectAffordances(object: RoomObject): string[] {
  const tags = object.tags ?? {};
  const uses: string[] = [];
  if (tags.sit) uses.push('sit');
  if (tags.stand || tags.look) uses.push('go to / look at');
  if (tags.grab && object.dynamic) uses.push('pick up');
  if (tags.surface) uses.push('put things on');
  return uses;
}

/** Another avatar in the room: just its name, or with where it is ("sitting on the sofa"). */
export type OtherAvatarEntry = string | { name: string; where?: string | null };

/** Farther than this from every listed object, an avatar is not described as standing near one. */
const NEAR_LIMIT = 3;

/**
 * Where an avatar is, in words, from the object it sits on or the listed object nearest to where it
 * stands. Null when neither is known.
 */
export function describeAvatarWhere(
  room: RoomFile | null | undefined,
  where: { seatedOn?: string | null; position?: { x: number; z: number } | null },
): string | null {
  if (!room) return null;
  if (where.seatedOn) {
    const seat = room.objects.find((object) => object.id === where.seatedOn);
    return seat ? `sitting on the ${seat.name}` : null;
  }
  const position = where.position;
  if (!position) return null;
  let best: { name: string; distance: number } | null = null;
  for (const object of room.objects) {
    if (objectAffordances(object).length === 0) continue;
    const distance = Math.hypot(object.position[0] - position.x, object.position[2] - position.z);
    if (!best || distance < best.distance) best = { name: object.name, distance };
  }
  return best && best.distance <= NEAR_LIMIT ? `standing near the ${best.name}` : null;
}

/** Feet this much above the floor count as resting on something other than the floor (metres). */
const RAISED_FOOT_FLOOR = 0.03;
/** Furthest an object may be from where the feet land to be named as what they rest on (metres). */
const FOOT_SUPPORT_REACH = 1;
/** How much slack the shin gets before the feet count as dangling (metres). */
const DANGLE_MARGIN = 0.02;

/**
 * Where the feet of an avatar seated on `seatId` are, in words: "feet on the floor", "feet on the footstool" or
 * "feet dangling" (the seat is too high for the shins to reach what is in front of it). Null when the seat
 * cannot be measured.
 */
export function describeFeet(
  room: RoomFile | null | undefined,
  world: PlanWorld | null | undefined,
  seatId: string,
): string | null {
  const geometry = world?.seatGeometry?.(seatId);
  if (!room || !world || !geometry) return null;
  const scale = world.frame.scale;
  const legs = world.restLegLengths;
  if (legs) {
    const knee = geometry.seatTopY + 0.07 * scale;
    const ankle = geometry.footFloorY + legs.ankleHeight * scale;
    if (knee - ankle >= legs.shin * scale + DANGLE_MARGIN) return 'feet dangling';
  }
  if (geometry.footFloorY < RAISED_FOOT_FLOOR) return 'feet on the floor';
  const facing = (geometry.facing * Math.PI) / 180;
  const ahead = geometry.frontEdge + 0.15;
  const x = geometry.position[0] + Math.sin(facing) * ahead;
  const z = geometry.position[2] + Math.cos(facing) * ahead;
  let best: { name: string; distance: number } | null = null;
  for (const object of room.objects) {
    if (object.id === seatId || object.collider === 'none') continue;
    const distance = Math.hypot(object.position[0] - x, object.position[2] - z);
    if (distance <= FOOT_SUPPORT_REACH && (!best || distance < best.distance)) best = { name: object.name, distance };
  }
  return best ? `feet on the ${best.name}` : 'feet on a raised surface';
}

/**
 * The avatar's contact with the room in words, for the model: how it sits and what it could not do lately
 * (`failures`, already worded by the scene executor). Empty when there is nothing worth saying.
 */
export function describeBody(
  room: RoomFile | null | undefined,
  state: { posture: 'standing' | 'seated'; seat?: { objectId: string } },
  world: PlanWorld | null | undefined,
  failures: readonly string[] = [],
): string {
  const parts: string[] = [];
  const seat = state.posture === 'seated' ? state.seat : undefined;
  if (seat && room) {
    const name = room.objects.find((object) => object.id === seat.objectId)?.name;
    const feet = describeFeet(room, world, seat.objectId);
    if (name) parts.push(`You are seated on the ${name}${feet ? `, ${feet}` : ''}.`);
  }
  if (failures.length > 0) parts.push(`Just now your body ${failures.join('; and ')}.`);
  return parts.join(' ');
}

/**
 * The part of the model's instructions that describes the room and the scene tags. Empty in 2D or
 * when live motion is unavailable, so the instructions are then exactly what they were.
 */
export function buildSceneInstructions(
  room: RoomFile | null | undefined,
  motionAvailable: boolean,
  idleNote = '',
  /** Names of the other avatars standing in the room with this one. */
  others: readonly OtherAvatarEntry[] = [],
  /** How this avatar sits and what its body could not do lately (see `describeBody`). */
  body = '',
): string {
  if (!room || !motionAvailable) return '';
  const objects = room.objects
    .map((object) => ({ object, uses: objectAffordances(object) }))
    .filter((entry) => entry.uses.length > 0)
    .map(({ object, uses }) => `${object.name} (${uses.join(', ')})`);
  if (objects.length === 0) return '';
  const othersLines = others
    .map((entry) => (typeof entry === 'string' ? { name: entry.trim(), where: null } : { name: entry.name.trim(), where: entry.where?.trim() || null }))
    .filter((entry) => entry.name)
    .map((entry) => (entry.where ? `${entry.name} is ${entry.where}.` : `${entry.name} is in the room with you.`));
  const idleLine = idleNote.trim() ? `Just before this, while idle, you: ${idleNote.trim()}.` : '';
  return [
    `You are standing in a 3D room, the ${room.name}. Things in it: ${objects.join('; ')}.`,
    'To act in the room, include `{go:<object>}` (walk there), `{look:<object>}` (turn to it), `{sit:<object>}`, `{stand}`,',
    '`{come}` (back to your spot in front of the user), `{pick:<object>}` and `{put:<object>@<surface>}` (put what you hold on a surface),',
    'naming the object as listed above.',
    'Use these only when they fit the conversation. They happen one after another, in the order written, and each takes a few seconds.',
    'For example: `{go:bookshelf}{move:runs a finger along the book spines}`.',
    ...othersLines,
    idleLine,
    body.trim(),
  ]
    .filter(Boolean)
    .join(' ');
}
