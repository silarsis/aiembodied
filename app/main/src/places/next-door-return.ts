/**
 * Avatars at the offscreen "next door" place have no renderer, so they have no idle life of their own. Once a minute
 * bija rolls a small die (by the restlessness setting) and, when it comes up, brings one of them back to a place where
 * someone used the PC lately. The limits are those of wandering (places/wander.ts): not moved in the last 10 minutes,
 * the place is open, someone was active there (or another avatar is), and Kevin did not just talk with it.
 *
 * The clock and the dice come in from outside so the tests are deterministic.
 */
import type { Restlessness } from '../rooms/idle-settings.js';
import type { PlaceManager } from './place-manager.js';
import { wanderRefusal } from './wander.js';

export const NEXT_DOOR_TICK_MS = 60_000;
/** The chance, each tick, that an avatar next door comes back (when it may). */
export const RETURN_CHANCE: Record<Restlessness, number> = { calm: 0.05, normal: 0.1, restless: 0.2 };

type Places = Pick<PlaceManager, 'snapshot' | 'startMove' | 'avatarsAt'>;

export interface NextDoorReturnOptions {
  places: Places;
  /** The idle restlessness setting; null when wandering is switched off. */
  restlessness: () => Restlessness | null;
  /** How long ago Kevin last spoke with the avatar; null when not lately. */
  talkedAgoMs: (avatarId: string) => number | null;
  rng?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  logger?: Pick<Console, 'info' | 'warn'>;
}

export class NextDoorReturn {
  private handle: unknown = null;

  constructor(private readonly options: NextDoorReturnOptions) {}

  start(): void {
    if (this.handle !== null) return;
    const set = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = set(() => this.tick(), NEXT_DOOR_TICK_MS);
    (this.handle as { unref?: () => void } | null)?.unref?.();
  }

  stop(): void {
    if (this.handle === null) return;
    (this.options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)))(this.handle);
    this.handle = null;
  }

  /** One roll. Returns the avatar that was sent back and where, or null. */
  tick(): { avatarId: string; placeId: string } | null {
    const level = this.options.restlessness();
    if (!level) return null;
    const { places } = this.options;
    const view = places.snapshot();
    const lively = view.places
      .filter((place) => place.node !== 'offscreen')
      .sort((a, b) => (view.activeAt?.[b.id] ?? 0) - (view.activeAt?.[a.id] ?? 0));
    const pairs: Array<{ avatarId: string; placeId: string }> = [];
    for (const nextDoor of view.places.filter((place) => place.node === 'offscreen')) {
      for (const avatarId of places.avatarsAt(nextDoor.id)) {
        const target = lively.find((place) => wanderRefusal(view, avatarId, place.id, { talkedAgoMs: this.options.talkedAgoMs(avatarId) }) === null);
        if (target) pairs.push({ avatarId, placeId: target.id });
      }
    }
    const first = pairs[0];
    if (!first) return null;
    // One roll per tick, and only when somebody could come: the dice are not wasted (and the test can count them).
    if ((this.options.rng ?? Math.random)() >= RETURN_CHANCE[level]) return null;
    const started = places.startMove(first.avatarId, first.placeId, 'wandered');
    if (!started.ok) {
      this.options.logger?.info('An avatar next door could not come back', { ...first, reason: started.reason });
      return null;
    }
    this.options.logger?.info('An avatar came back from next door', first);
    return first;
  }
}
