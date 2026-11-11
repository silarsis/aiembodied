import type { RoomFile, RoomObject } from '../../../main/src/rooms/types.js';

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
  ]
    .filter(Boolean)
    .join(' ');
}
