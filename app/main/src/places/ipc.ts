import { FloorController } from '../floor/index.js';
import { PlaceManager } from './place-manager.js';
import { callToPlace } from './summon.js';
import { wanderRefusal } from '../shared/places/wander.js';
import { AvatarRegistry } from '../avatars/avatar-registry.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface PlacesIpcOptions {
  handle: HandleIpc;
  requirePlaces: () => PlaceManager;
  talkedAgoMs: (avatarId: string) => number | null;
  placeOf: (event: unknown) => string;
  floorFor: (placeId: string) => FloorController | null;
  avatarRegistry: () => AvatarRegistry | null;
}

export function registerPlacesIpc(options: PlacesIpcOptions): void {
  const { handle, requirePlaces, talkedAgoMs, placeOf, floorFor, avatarRegistry } = options;

  // Places: who is where. The renderer follows the snapshot, asks avatars to walk to another place and confirms arrivals.
  handle('places:snapshot', () => requirePlaces().snapshot());
  handle('places:move', (_event, avatarId: unknown, placeRef: unknown, reason: unknown) => {
    const places = requirePlaces();
    if (
      typeof avatarId !== 'string' ||
      !avatarId ||
      typeof placeRef !== 'string' ||
      !placeRef.trim()
    ) {
      return { ok: false, reason: 'invalid request' };
    }
    const place = places.resolvePlace(placeRef);
    if (!place) return { ok: false, reason: 'unknown place' };
    // An idle avatar that walked to the door to wander is checked again with fresh facts (it took a few seconds to get there).
    if (reason === 'wandered') {
      const refusal = wanderRefusal(places.snapshot(), avatarId, place.id, {
        talkedAgoMs: talkedAgoMs(avatarId),
      });
      if (refusal) return { ok: false, reason: refusal };
    }
    const result = places.startMove(
      avatarId,
      place.id,
      reason === 'called' ? 'called' : reason === 'wandered' ? 'wandered' : 'chose to',
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  });
  // The idle director asks before it lets an avatar walk to another place on its own (shared/places/wander.ts has the rules).
  handle('places:can-wander', (_event, avatarId: unknown, placeRef: unknown, speaking: unknown) => {
    if (
      typeof avatarId !== 'string' ||
      !avatarId ||
      typeof placeRef !== 'string' ||
      !placeRef.trim()
    )
      return { ok: false, reason: 'invalid request' };
    const refusal = wanderRefusal(requirePlaces().snapshot(), avatarId, placeRef, {
      speaking: speaking === true,
      talkedAgoMs: talkedAgoMs(avatarId),
    });
    return refusal ? { ok: false, reason: refusal } : { ok: true };
  });
  handle('places:arrived', (_event, avatarId: unknown) => {
    if (typeof avatarId === 'string' && avatarId) requirePlaces().arrived(avatarId);
  });
  // The talk key with nobody in the room: call someone over (the recent partner, else Echo, else the first avatar).
  // The same rule for bija's own window and for a desktop room; the answer says who is coming.
  handle('places:summon', (event) => {
    const placeId = placeOf(event);
    return callToPlace(
      requirePlaces(),
      placeId,
      floorFor(placeId)?.recentPartner() ?? null,
      (avatarRegistry()?.list() ?? []).map((profile) => ({ id: profile.id, name: profile.name })),
    );
  });
}
