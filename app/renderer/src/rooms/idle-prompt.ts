/**
 * The prompt for the "Idle thoughts" model. One builder, so the wording is tested in one place:
 * the system message says what to answer with, the user message describes the moment.
 */
import type { IdlePickContext } from '../../../main/src/rooms/types.js';
import type { RoomObject } from '../../../main/src/rooms/types.js';
import { objectAffordances } from './scene-instructions.js';
import type { IdleInput } from './idle-types.js';

export const PERSONALITY_CHARS = 300;
export const RECENT_IN_PROMPT = 5;
/** An avatar this close (metres) to an object counts as standing near it. */
export const NEAR_DISTANCE = 1.2;

export const IDLE_TAG_SYNTAX = [
  '{go:<object>} walk to an object',
  '{look:<object>} turn to look at an object',
  '{sit:<object>} sit down on a seat',
  '{stand} get up from a seat',
  '{pick:<object>} pick up a small object',
  '{put:<object>@<surface>} put what you hold on a surface',
  '{come} walk back to the middle of the room',
  '{move:<short description>} a small gesture or activity, such as {move:stretches both arms}',
  '{wait} do nothing this time',
].join('; ');

export function idleSystemPrompt(name: string): string {
  return [
    `You decide what ${name || 'the character'} does on their own in a room while nobody is talking to them.`,
    'Reply with only 1 to 3 action tags, nothing else.',
    `Tags: ${IDLE_TAG_SYNTAX}.`,
    'Name objects exactly as listed. Only use what each object allows.',
  ].join(' ');
}

/** "evening, 19:40" */
export function timeOfDay(now: Date): string {
  const hour = now.getHours();
  const part = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${part}, ${pad(hour)}:${pad(now.getMinutes())}`;
}

/** The nearest object within `NEAR_DISTANCE` of the point, among objects a person can stand next to. */
export function nearestObject(objects: readonly RoomObject[], position: readonly [number, number, number]): RoomObject | null {
  let best: { object: RoomObject; distance: number } | null = null;
  for (const object of objects) {
    if (object.collider === 'none') continue;
    const distance = Math.hypot(object.position[0] - position[0], object.position[2] - position[2]);
    if (distance <= NEAR_DISTANCE && (!best || distance < best.distance)) best = { object, distance };
  }
  return best?.object ?? null;
}

export function describeState(input: IdleInput): string {
  const { room, state } = input;
  const nameOf = (id: string) => room.objects.find((object) => object.id === id)?.name ?? id;
  const where =
    state.posture === 'seated' && state.seat
      ? `seated on the ${nameOf(state.seat.objectId)}`
      : (() => {
          const near = nearestObject(room.objects, input.position);
          return near ? `standing near the ${near.name}` : 'standing in the middle of the room';
        })();
  return state.held ? `${where}, holding the ${nameOf(state.held.objectId)}` : where;
}

function describeObject(object: RoomObject): string {
  const uses = objectAffordances(object);
  const hint = object.tags?.idle ? `; idle idea: ${object.tags.idle}` : '';
  return `- ${object.name}${uses.length ? ` (${uses.join(', ')})` : ''}${hint}`;
}

export function buildIdlePrompt(input: IdleInput): IdlePickContext {
  const { room } = input;
  const personality = input.personality.replace(/\s+/g, ' ').trim().slice(0, PERSONALITY_CHARS);
  const things = input.visible.filter((object) => objectAffordances(object).length > 0 || object.tags?.idle);
  const recent = input.recent.slice(-RECENT_IN_PROMPT);
  const lines = [
    `Character: ${input.name || 'the character'}`,
    personality ? `Personality: ${personality}` : '',
    input.habits.trim() ? `Idle habits: ${input.habits.replace(/\s+/g, ' ').trim()}` : '',
    `Room: ${room.name}${room.description ? `. ${room.description}` : ''}`,
    'Things they can see and reach:',
    ...(things.length > 0 ? things.map(describeObject) : ['- nothing in particular']),
    `Right now: ${describeState(input)}`,
    recent.length > 0 ? `What they did recently:\n${recent.map((line) => `- ${line}`).join('\n')}` : 'What they did recently: nothing yet',
    `Time: ${timeOfDay(input.now)}`,
    'Prefer variety. Use {wait} to stay as you are.',
  ];
  return { system: idleSystemPrompt(input.name), user: lines.filter(Boolean).join('\n') };
}
