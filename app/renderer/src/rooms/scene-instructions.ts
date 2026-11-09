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

/**
 * The part of the model's instructions that describes the room and the scene tags. Empty in 2D or
 * when live motion is unavailable, so the instructions are then exactly what they were.
 */
export function buildSceneInstructions(room: RoomFile | null | undefined, motionAvailable: boolean): string {
  if (!room || !motionAvailable) return '';
  const objects = room.objects
    .map((object) => ({ object, uses: objectAffordances(object) }))
    .filter((entry) => entry.uses.length > 0)
    .map(({ object, uses }) => `${object.name} (${uses.join(', ')})`);
  if (objects.length === 0) return '';
  return [
    `You are standing in a 3D room, the ${room.name}. Things in it: ${objects.join('; ')}.`,
    'To act in the room, include `{go:<object>}` (walk there), `{look:<object>}` (turn to it), `{sit:<object>}`, `{stand}`,',
    '`{come}` (back to your spot in front of the user), `{pick:<object>}` and `{put:<object>@<surface>}` (put what you hold on a surface),',
    'naming the object as listed above.',
    'Use these only when they fit the conversation. They happen one after another, in the order written, and each takes a few seconds.',
    'For example: `{go:bookshelf}{move:runs a finger along the book spines}`.',
  ].join(' ');
}
