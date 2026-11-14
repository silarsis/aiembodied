/**
 * The doorbell: the wake word heard while nobody is at a place. Instead of starting a turn, it calls an avatar over
 * (the recent partner, else Echo, else the first one), the same call as the talk key. The turn starts once the avatar
 * has arrived.
 *
 * - On bija the wake word keeps listening with nobody here only while the place's doorbell setting is on
 *   (`wakeShouldListen`); with it off the microphone is released until an avatar arrives.
 * - A satellite runs its own wake word worker and sends `wake.heard`; bija calls `createDoorbell(...).onWake` for
 *   that place. Audio never leaves the satellite: only the model name and the score do.
 *
 * Pure: the places, the clock-free summon and the delivery come in from outside.
 */
import { doorbellOn } from './doorbell-setting.js';
import type { PlaceManager } from './place-manager.js';
import { chooseSummon, summon } from './summon.js';

type SummonPlaces = Parameters<typeof summon>[0] & Pick<PlaceManager, 'avatarsAt' | 'get'>;

/** Whether the wake word should hold the microphone at a place: an avatar is there to hear, or the doorbell is on. */
export function wakeShouldListen(places: Pick<PlaceManager, 'get' | 'avatarsAt'>, placeId: string): boolean {
  return places.avatarsAt(placeId).length > 0 || doorbellOn(places.get(placeId));
}

export interface DoorbellOptions {
  places: SummonPlaces;
  /** The place the wake word was heard at. */
  placeId: string;
  /** The avatar Kevin last talked with, if recent. */
  partner: () => string | null;
  avatarIds: () => string[];
  logger?: Pick<Console, 'info' | 'warn'>;
}

export type DoorbellOutcome = 'here' | 'arrived' | 'failed' | 'busy' | 'off';

/** One doorbell for a place. A ring while an avatar is on its way is ignored. */
export function createDoorbell(options: DoorbellOptions): { onWake(onHeard?: () => void): Promise<DoorbellOutcome> } {
  let ringing = false;
  return {
    /** `onHeard` runs when somebody is here to hear the wake word: at once, or when the avatar that was called has arrived. */
    async onWake(onHeard) {
      const { places, placeId } = options;
      if (places.avatarsAt(placeId).length > 0) {
        onHeard?.();
        return 'here';
      }
      // Nobody is here: only a doorbell that is switched on calls someone.
      if (!doorbellOn(places.get(placeId))) return 'off';
      if (ringing) return 'busy';
      const callId = chooseSummon(options.partner(), options.avatarIds());
      if (!callId) return 'failed';
      ringing = true;
      try {
        const came = await summon(places, callId, 'summoned');
        if (!came) {
          options.logger?.warn('The doorbell rang but nobody came', { placeId, avatarId: callId });
          return 'failed';
        }
        options.logger?.info('The doorbell called an avatar over', { placeId, avatarId: callId });
        onHeard?.();
        return 'arrived';
      } finally {
        ringing = false;
      }
    },
  };
}
