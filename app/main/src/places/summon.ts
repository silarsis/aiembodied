/**
 * Calling an avatar over: Kevin spoke and the avatar he meant is not at this PC's place. The avatar walks in
 * (a move with reason 'summoned') and the turn waits until it is here.
 */
import { MOVE_DEADLINE_MS, type PlaceManager } from './place-manager.js';

type Moves = Pick<PlaceManager, 'startMove' | 'waitForArrival' | 'localPlaceId' | 'isPresent' | 'inTransit' | 'snapshot' | 'onChanged'>;

/** Waits until the avatar's current move is over (it arrived somewhere or failed). */
function waitForMoveEnd(places: Moves, avatarId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!places.inTransit(avatarId)) {
      resolve();
      return;
    }
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    const off = places.onChanged(() => {
      if (!places.inTransit(avatarId)) done();
    });
    function done(): void {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

/**
 * Brings `avatarId` to this PC's place and resolves true once it is present. Resolves true at once when it is
 * already here. False when the move could not start or the avatar did not arrive in time.
 */
export async function summon(places: Moves, avatarId: string, reason = 'summoned', timeoutMs = MOVE_DEADLINE_MS): Promise<boolean> {
  if (places.isPresent(avatarId)) return true;
  const local = places.localPlaceId();
  // It is on its way somewhere: if that is here, wait for it; otherwise let it get there first, then call it back.
  const going = places.snapshot().transit.find((entry) => entry.avatarId === avatarId);
  if (going && going.to === local) return places.waitForArrival(avatarId, timeoutMs);
  if (going) await waitForMoveEnd(places, avatarId, timeoutMs);
  if (places.isPresent(avatarId)) return true;
  const started = places.startMove(avatarId, local, reason);
  if (!started.ok) return started.reason === 'already moving' ? places.waitForArrival(avatarId, timeoutMs) : false;
  return places.waitForArrival(avatarId, timeoutMs);
}

/**
 * Who to call when nobody is at this PC's place: the avatar Kevin last talked with, else Echo, else the first
 * avatar. Null when there is no avatar at all.
 */
export function chooseSummon(partnerId: string | null, avatarIds: string[]): string | null {
  if (partnerId && avatarIds.includes(partnerId)) return partnerId;
  if (avatarIds.includes('echo')) return 'echo';
  return avatarIds[0] ?? null;
}
