/**
 * Stations, renderer side: main says an avatar is using a tool that lives at an object in the room
 * (`station:use`), and this walks the avatar to that object and lets it act the activity there
 * ("pulls a book from the shelf and reads"). When the walk is over (or cannot happen) main is told with
 * `station:arrived`, so it can hold the spoken answer until the avatar stands at the object.
 *
 * Everything the walk needs comes in through `StationWalkDeps`, so tests can use fakes.
 */
import type { RoomFile } from '../../../main/src/rooms/types.js';
import type { StationUseEvent } from '../../../main/src/stations/types.js';
import type { SceneAction, PlanWorld } from './scene-actions.js';

/** The parts of an avatar's scene executor a station walk uses. */
export interface StationWalkExecutor {
  /** The room and the avatar as they are now; null while there is no room or body to walk with. */
  world(): PlanWorld | null;
  submit(actions: SceneAction[]): void;
  /** Runs after everything queued so far, also when the walk before it failed. */
  submitAfter(label: string, run: () => unknown): void;
}

export interface StationWalkDeps {
  /** The 3D room shown here; null in 2D. */
  room(): RoomFile | null;
  /** The avatar's executor, or null when this screen has no such avatar. */
  executorFor(avatarId: string): StationWalkExecutor | null;
  /** The avatar is on this screen (not in another place). */
  isHere(avatarId: string): boolean;
  /** Queue a `{move:}` gesture for the avatar, behind its walk. */
  gesture(text: string, avatarId: string): void;
  /** Tell main the avatar is at the object, or cannot go. */
  arrived(useId: string): void;
}

/** Handles one `station:use` event. Never throws: a station that cannot be walked to just answers "arrived". */
export function handleStationUse(event: StationUseEvent, deps: StationWalkDeps): void {
  // A pursuit moves on to its next step: the avatar acts it out where it stands (no walking, no answer to main).
  if (event.phase === 'activity') {
    if (deps.room()?.id === event.roomId && deps.isHere(event.avatarId) && deps.executorFor(event.avatarId)?.world()) {
      deps.gesture(`{move:${event.activity.replace(/[{}]/g, '')}}`, event.avatarId);
    }
    return;
  }
  // Nothing special at the end: the idle director takes over later and the avatar is not sent back.
  if (event.phase !== 'start') return;
  try {
    const room = deps.room();
    const executor = deps.executorFor(event.avatarId);
    const canWalk =
      room !== null &&
      room.id === event.roomId &&
      room.objects.some((object) => object.id === event.objectId) &&
      deps.isHere(event.avatarId) &&
      executor !== null &&
      executor.world() !== null;
    if (!canWalk || !executor) {
      deps.arrived(event.useId);
      return;
    }
    executor.submit([{ kind: 'go', objectId: event.objectId }]);
    executor.submitAfter(`reach the ${event.objectId}`, () => deps.arrived(event.useId));
    // Queued behind the walk, so the avatar acts it out at the object.
    deps.gesture(`{move:${event.activity}}`, event.avatarId);
  } catch (error) {
    console.warn('[stations] could not start the walk', error);
    deps.arrived(event.useId);
  }
}
