/**
 * The body of reading, planned: what an avatar does with its hands, its feet and its seat for each step of a
 * pursuit at a station (take a book from the shelf, read it in an armchair, put it back).
 *
 * Everything here is pure. `resolveBodyPlan` checks a station's `body` against the room (a prop or seat the room
 * lacks is dropped, so the avatar just stands at the object, as in phase 2). The `plan*` functions take the
 * avatar's state as it is when their turn comes (they run inside the executor's `submitPlan`) and return scene
 * actions. Gestures are not planned here: a `{move:}` gesture is skipped by the executor while the avatar is
 * seated, so `station-walks.ts` plays them only when standing.
 */
import type { RoomFile, RoomObject } from '../../../main/src/rooms/types.js';
import type { StationBody } from '../../../main/src/stations/types.js';
import type { AvatarState, PlanWorld, SceneAction } from './scene-actions.js';

/** A station's body plan checked against the room. */
export interface BodyPlan {
  /** The station object (`bookshelf`). */
  objectId: string;
  /** The dynamic object to take and hold (has a grab tag), or null: nothing to hold. */
  prop: string | null;
  /** The object to sit on (has a sit tag), or null: the avatar stays on its feet. */
  seat: string | null;
  /** Where the prop goes back: the station object when it has a surface tag, else null (the nearest surface is used). */
  surfaceId: string | null;
  /** Gesture texts (without braces). */
  browse: string;
  read: string;
  note: string;
}

/** How long (ms) between repeats of the reading gesture while the avatar keeps reading and stands. */
export const READ_REPEAT_MS = 20_000;
/** The same gesture is not played again within this time (the want and choose steps would repeat it back to back). */
export const GESTURE_REPEAT_MS = 8_000;

function find(room: RoomFile, id: string | undefined): RoomObject | null {
  return id ? (room.objects.find((object) => object.id === id) ?? null) : null;
}

/** Gesture text without anything that would break a `{move:}` tag. */
function clean(text: string): string {
  return text.replace(/[{}]/g, '').trim();
}

/**
 * Checks the body of a station against the room. `fallbackActivity` is the station's own activity, used for
 * the gestures the body does not give. Null when the room has no such station object.
 */
export function resolveBodyPlan(room: RoomFile, objectId: string, body: StationBody | undefined, fallbackActivity: string): BodyPlan | null {
  const station = find(room, objectId);
  if (!station) return null;
  const prop = find(room, body?.prop);
  const seat = find(room, body?.seat);
  const usableProp = prop && prop.dynamic === true && prop.tags?.grab ? prop.id : null;
  const usableSeat = seat && seat.tags?.sit ? seat.id : null;
  return {
    objectId,
    prop: usableProp,
    // Sitting down to read needs the book too: without it the avatar stays at the shelf.
    seat: usableProp ? usableSeat : null,
    surfaceId: station.tags?.surface ? station.id : null,
    browse: clean(body?.browse || fallbackActivity),
    read: clean(body?.read || 'reads'),
    note: clean(body?.note || 'jots down notes'),
  };
}

/** Take the prop from where it lies, unless the hands are full already. */
export function planTake(plan: BodyPlan, state: AvatarState): SceneAction[] {
  if (!plan.prop || state.held) return [];
  return [{ kind: 'pick', objectId: plan.prop }];
}

/** Sit down on the seat, when the book is really in the hand (the pick may have failed) and the avatar is on its feet. */
export function planSit(plan: BodyPlan, state: AvatarState): SceneAction[] {
  if (!plan.seat || !plan.prop || state.posture === 'seated') return [];
  if (state.held?.objectId !== plan.prop) return [];
  return [{ kind: 'sit', objectId: plan.seat }];
}

/** The surface to put something down on: the station object when it has a surface tag, else the nearest object that has one. */
export function chooseSurface(world: PlanWorld, plan: BodyPlan | null): string | null {
  if (plan?.surfaceId) return plan.surfaceId;
  const from = [world.frame.origin.x, world.frame.origin.z] as const;
  let best: { id: string; distance: number } | null = null;
  for (const object of world.room.objects) {
    if (!object.tags?.surface || object.dynamic === true) continue;
    const distance = Math.hypot(object.position[0] - from[0], object.position[2] - from[1]);
    if (!best || distance < best.distance) best = { id: object.id, distance };
  }
  return best?.id ?? null;
}

/**
 * Stand up and put down whatever is in the hand (the book goes back on the shelf). `comeBack` adds `{come}`:
 * used when the session was cut short because the user started talking, so the conversation finds the avatar at home.
 */
export function planRelease(plan: BodyPlan | null, world: PlanWorld, state: AvatarState, comeBack: boolean): SceneAction[] {
  const actions: SceneAction[] = [];
  if (state.posture === 'seated') actions.push({ kind: 'stand' });
  if (state.held) {
    const surfaceId = chooseSurface(world, plan);
    if (surfaceId) actions.push({ kind: 'put', objectId: state.held.objectId, surfaceId });
  }
  if (comeBack) actions.push({ kind: 'come' });
  return actions;
}
