/**
 * Urgent news walks to Kevin. When an avatar is about to say something urgent (an `avatar.inbox` event of high or
 * urgent priority, or a `home.alert`) and nobody used the PC at its place in the last 2 minutes while another place's
 * PC was in use, the avatar walks there first and the news is said when it has arrived (or after 10 seconds).
 * Otherwise nothing changes. Pure: the places come in from outside.
 */
import type { PlaceManager } from './place-manager.js';
import { activeWithin, type WanderView } from './wander.js';

/** "Nobody is at this PC" for urgent news: no use of it for this long. */
export const URGENT_QUIET_MS = 2 * 60_000;
/** How long the news waits for the avatar to arrive. */
export const URGENT_WAIT_MS = 10_000;

/** The place the avatar should go to, or null when it should stay where it is. */
export function urgentTarget(view: WanderView, avatarId: string, now: number = view.now ?? Date.now()): string | null {
  if (view.transit.some((entry) => entry.avatarId === avatarId)) return null;
  const at = view.locations[avatarId] ?? view.places[0]?.id;
  if (!at || activeWithin(view, at, URGENT_QUIET_MS, now)) return null;
  const options = view.places
    .filter((place) => place.id !== at && place.node !== 'offscreen' && place.online !== false && place.closed !== true && activeWithin(view, place.id, URGENT_QUIET_MS, now))
    .sort((a, b) => (view.activeAt?.[b.id] ?? 0) - (view.activeAt?.[a.id] ?? 0));
  return options[0]?.id ?? null;
}

type UrgentPlaces = Pick<PlaceManager, 'snapshot' | 'startMove' | 'waitForArrival'>;

/**
 * Moves the avatar to where someone is, when `urgentTarget` says so, and waits for it. Resolves once the news can be
 * said: right away when the avatar stays, else after it arrived or `waitMs` ran out. Never throws.
 */
export async function walkToKevin(places: UrgentPlaces, avatarId: string, waitMs = URGENT_WAIT_MS, logger?: Pick<Console, 'info' | 'warn'>): Promise<string | null> {
  try {
    const target = urgentTarget(places.snapshot(), avatarId);
    if (!target) return null;
    const started = places.startMove(avatarId, target, 'urgent news');
    if (!started.ok) {
      logger?.info('Urgent news: the avatar could not walk over', { avatarId, target, reason: started.reason });
      return null;
    }
    const arrived = await places.waitForArrival(avatarId, waitMs, target);
    logger?.info('Urgent news: the avatar walked to where someone is', { avatarId, target, arrived });
    return target;
  } catch (error) {
    logger?.warn('Urgent news: the walk failed', { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
