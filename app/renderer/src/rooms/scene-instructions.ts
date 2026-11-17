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

/** What the chat model hears about this avatar and the room, besides the room itself. */
export interface SceneContext {
  /** What the avatar did while idle just before this, in words. */
  idleNote?: string;
  /** The other avatars in the room with this one. */
  others?: readonly OtherAvatarEntry[];
  /** How this avatar sits and what its body could not do lately (see `describeBody`). */
  body?: string;
  /** Where the avatar is when standing, e.g. "standing near the bookshelf" (see `describeAvatarWhere`). */
  where?: string | null;
  /** The name of what the avatar holds, if anything. */
  held?: string | null;
}

/** The first object in the room that allows `use`, for the worked examples. */
function firstWith(room: RoomFile, use: string): RoomObject | undefined {
  return room.objects.find((object) => objectAffordances(object).includes(use));
}

/** One worked example per kind of request, using this room's own objects, so the model sees the mapping. */
function sceneExamples(room: RoomFile): string[] {
  const examples: string[] = [];
  const seat = firstWith(room, 'sit');
  if (seat) {
    const said = /\bsofa\b/i.test(seat.name) ? 'couch' : seat.name;
    examples.push(`"Go sit on the ${said}" -> "Sure, getting comfy. {sit:${seat.name}}"`);
  }
  const small = firstWith(room, 'pick up');
  if (small) examples.push(`"Can you grab the ${small.name}?" -> "Here it is. {pick:${small.name}}{come}"`);
  examples.push('"How was your day?" -> an answer with no room tags, since nothing asked you to move.');
  return examples;
}

/**
 * The part of the model's instructions that describes the room and how to move in it, in the shape the
 * idle model gets (a list of things and what each allows, and where the avatar is now), but for a chat
 * turn: move only when asked or when the reply plainly needs it. Empty in 2D. Without the motion service
 * it only says the body cannot move, so the model does not promise to.
 */
export function buildSceneInstructions(
  room: RoomFile | null | undefined,
  motionAvailable: boolean,
  context: SceneContext = {},
): string {
  if (!room) return '';
  const objects = room.objects
    .map((object) => ({ object, uses: objectAffordances(object) }))
    .filter((entry) => entry.uses.length > 0)
    .map(({ object, uses }) => `- ${object.name} (${uses.join(', ')})`);
  if (objects.length === 0) return '';
  if (!motionAvailable) {
    return `You are in a 3D room, the ${room.name}, but your body cannot move right now (live motion is not running), so do not offer or promise to walk, sit or pick things up.`;
  }
  const others = (context.others ?? [])
    .map((entry) => (typeof entry === 'string' ? { name: entry.trim(), where: null } : { name: entry.name.trim(), where: entry.where?.trim() || null }))
    .filter((entry) => entry.name)
    .map((entry) => (entry.where ? `${entry.name} is ${entry.where}.` : `${entry.name} is in the room with you.`));
  const body = context.body?.trim() ?? '';
  const seated = body.startsWith('You are seated');
  const where = context.where?.trim();
  const held = context.held?.trim();
  const now = [
    seated ? '' : `You are ${where || 'standing in the room'}.`,
    body,
    held ? `You are holding the ${held}.` : '',
  ].filter(Boolean).join(' ');
  const idleNote = context.idleNote?.trim();
  return [
    `Your room: you have a body in a 3D room, the ${room.name}, and can move around it.`,
    'Things in it and what you can do with them:',
    ...objects,
    `Right now: ${now}`,
    ...others,
    idleNote ? `Just before this, while idle, you: ${idleNote}.` : '',
    'Moving: when the user asks you to go somewhere, sit, stand up, look at, fetch, pick up or put down something, do it in the same reply',
    'by writing room tags next to your words. Also move when your reply plainly needs it. Otherwise stay where you are; do not move just to fill a reply.',
    'Room tags: {go:object} walk to it; {look:object} turn to it; {sit:object} walk to a seat and sit; {stand} get up;',
    '{pick:object} pick up something small; {put:object@surface} put what you hold on a surface; {come} come back to your spot in front of the user.',
    'Name objects as listed above, even when the user calls them something else. Tags run one after another, a few seconds each.',
    'Tags are silent: they are taken out before your words are spoken, so they do not count as markup. Moving is done with these tags, never with a tool call.',
    'Examples:',
    ...sceneExamples(room).map((line) => `- ${line}`),
  ]
    .filter(Boolean)
    .join('\n');
}
