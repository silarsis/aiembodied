/**
 * Stations, renderer side: main says an avatar is using a tool that lives at an object in the room
 * (`station:use`), and this walks the avatar to that object and lets it act the activity there
 * ("pulls a book from the shelf and reads"). When the walk is over (or cannot happen) main is told with
 * `station:arrived`, so it can hold the spoken answer until the avatar stands at the object.
 *
 * Everything the walk needs comes in through `StationWalkDeps`, so tests can use fakes.
 */
import type { RoomFile } from '../../../main/src/shared/rooms/types.js';
import type { StationUseEvent } from '../../../main/src/shared/stations/types.js';
import type { SceneAction, PlanWorld, AvatarState } from './scene-actions.js';
import type { PlanBuilder } from './scene-executor.js';
import {
  GESTURE_REPEAT_MS,
  READ_REPEAT_MS,
  planRelease,
  planSit,
  planTake,
  resolveBodyPlan,
  type BodyPlan,
} from './station-body.js';

/** The parts of an avatar's scene executor a station walk uses. */
export interface StationWalkExecutor {
  /** The room and the avatar as they are now; null while there is no room or body to walk with. */
  world(): PlanWorld | null;
  submit(actions: SceneAction[]): void;
  /** Runs after everything queued so far, also when the walk before it failed. */
  submitAfter(label: string, run: () => unknown): void;
  /** Queues a decision made when its turn comes, from the avatar's state by then (the body of reading uses it). */
  submitPlan?(label: string, build: PlanBuilder): void;
  /** Posture and held object now. */
  getState?(): AvatarState;
}

export interface StationWalkDeps {
  /** The 3D room shown here; null in 2D. */
  room(): RoomFile | null;
  /** The avatar's executor, or null when this screen has no such avatar. */
  executorFor(avatarId: string): StationWalkExecutor | null;
  /** The avatar is on this screen (not in another place). */
  isHere(avatarId: string): boolean;
  /**
   * Queue a `{move:}` gesture for the avatar, behind its walk. A station gesture may repeat an earlier one
   * (reading again), so the caller must not drop it as a repeat.
   */
  gesture(text: string, avatarId: string): void;
  /** Tell main the avatar is at the object, or cannot go. */
  arrived(useId: string): void;
}

/** What the body is doing for an avatar's pursuit: the repeat timer of the reading gesture, and the last gesture played. */
interface BodySession {
  timer: ReturnType<typeof setInterval> | null;
  lastGesture: { text: string; at: number } | null;
}

/** Per avatar. Cleared when the pursuit's `end` event arrives. */
const sessions = new Map<string, BodySession>();

/** Forget every body session and stop its timer (tests; a room change). */
export function resetStationBodies(): void {
  for (const session of sessions.values()) if (session.timer) clearInterval(session.timer);
  sessions.clear();
}

function sessionOf(avatarId: string): BodySession {
  let session = sessions.get(avatarId);
  if (!session) {
    session = { timer: null, lastGesture: null };
    sessions.set(avatarId, session);
  }
  return session;
}

function stopReading(avatarId: string): void {
  const session = sessions.get(avatarId);
  if (session?.timer) clearInterval(session.timer);
  if (session) session.timer = null;
}

/**
 * Plays a gesture where the avatar stands, once its queue has reached it. Skipped while seated (the executor would
 * skip a gesture then, with a warning: sitting and holding the book is the reading) and, unless `force`, when the
 * same gesture was played a moment ago.
 */
function playGesture(
  executor: StationWalkExecutor,
  deps: StationWalkDeps,
  avatarId: string,
  text: string,
  force = false,
): void {
  executor.submitAfter(`gesture ${text}`, () => {
    if (executor.getState?.().posture === 'seated') return;
    const session = sessionOf(avatarId);
    const now = Date.now();
    if (
      !force &&
      session.lastGesture &&
      session.lastGesture.text === text &&
      now - session.lastGesture.at < GESTURE_REPEAT_MS
    )
      return;
    session.lastGesture = { text, at: now };
    deps.gesture(`{move:${text}}`, avatarId);
  });
}

/** A pursuit's step, acted with the body plan: take the book and read it seated, or just gestures when the room lacks the means. */
function pursuitActivity(
  event: StationUseEvent,
  plan: BodyPlan,
  executor: StationWalkExecutor,
  deps: StationWalkDeps,
): void {
  const avatarId = event.avatarId;
  stopReading(avatarId);
  if (event.step === 'consume') {
    // Take the book, then sit down with it (decided when the turn comes: a failed pick means no sitting).
    if (executor.submitPlan) {
      executor.submitPlan('take the book', (_world, state) => planTake(plan, state));
      executor.submitPlan('sit down to read', (_world, state) => planSit(plan, state));
    }
    playGesture(executor, deps, avatarId, plan.read, true);
    // Keep reading while the step lasts. Seated, the gesture is left out (see playGesture).
    sessionOf(avatarId).timer = setInterval(
      () => playGesture(executor, deps, avatarId, plan.read, true),
      READ_REPEAT_MS,
    );
    return;
  }
  if (event.step === 'note') {
    playGesture(executor, deps, avatarId, plan.note);
    return;
  }
  // Looking for the next thing to read (want, act, choose) or thinking (next). A seated avatar stays seated and
  // keeps the book: standing up, putting it back and fetching another would be a lot of walking for each item.
  const browsing = event.step === 'want' || event.step === 'act' || event.step === 'choose';
  playGesture(executor, deps, avatarId, browsing ? plan.browse : clean(event.activity));
}

function clean(text: string): string {
  return text.replace(/[{}]/g, '');
}

/** Handles one `station:use` event. Never throws: a station that cannot be walked to just answers "arrived". */
export function handleStationUse(event: StationUseEvent, deps: StationWalkDeps): void {
  // The body plan applies to a pursuit's events that carry one, in the room the station is in.
  const room = deps.room();
  const plan =
    event.source === 'pursuit' && event.body && room?.id === event.roomId
      ? resolveBodyPlan(room, event.objectId, event.body, event.activity)
      : null;

  // A pursuit moves on to its next step: the avatar acts it out where it stands (no walking, no answer to main).
  if (event.phase === 'activity') {
    const executor = deps.executorFor(event.avatarId);
    if (room?.id === event.roomId && deps.isHere(event.avatarId) && executor?.world()) {
      if (plan) pursuitActivity(event, plan, executor, deps);
      else deps.gesture(`{move:${clean(event.activity)}}`, event.avatarId);
    }
    return;
  }
  if (event.phase === 'end') {
    stopReading(event.avatarId);
    sessions.delete(event.avatarId);
    // A pursuit is over: stand up and put the book back on the shelf. When it was cut short (Kevin started talking)
    // the avatar then comes back to its spot, where the conversation finds it. A tool call changes nothing here.
    const executor = deps.executorFor(event.avatarId);
    if (plan && executor?.submitPlan && room?.id === event.roomId && deps.isHere(event.avatarId)) {
      executor.submitPlan('put the book back', (world, state) =>
        planRelease(plan, world, state, event.ok === false),
      );
    }
    return;
  }
  try {
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
    if (plan) {
      // A pursuit: look over the shelf; the steps that follow bring the gestures.
      sessions.delete(event.avatarId);
      executor.submit([{ kind: 'look', objectId: event.objectId }]);
    } else {
      // Queued behind the walk, so the avatar acts it out at the object.
      deps.gesture(`{move:${event.activity}}`, event.avatarId);
    }
  } catch (error) {
    console.warn('[stations] could not start the walk', error);
    deps.arrived(event.useId);
  }
}
