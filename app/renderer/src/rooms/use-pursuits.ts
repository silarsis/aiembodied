import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PursuitOffer, PursuitsBridge } from '../../../main/src/shared/pursuits/types.js';
import type { AgentsBridge } from '../../../main/src/shared/agent-time/bridge-types.js';
import type { IdlePursuit } from './idle-types.js';

/** How often the list of stations that can be read at is read again (tools connect and stations change while the app runs). */
export const OFFERS_REFRESH_MS = 60_000;

/** The stations of one room that an avatar may use, as the idle director offers them. */
export function offersFor(
  offers: readonly PursuitOffer[],
  roomId: string | null,
  avatarId: string,
): IdlePursuit[] {
  if (!roomId) return [];
  return offers
    .filter(
      (offer) =>
        offer.roomId === roomId &&
        (offer.characters === 'all' || offer.characters.includes(avatarId)),
    )
    .map((offer) => ({
      stationId: offer.stationId,
      objectId: offer.objectId,
      objectName: offer.objectName,
    }));
}

/**
 * Keeps what the idle director needs to let a character read on its own: which stations can be read at, and
 * which avatars are reading now (so none is offered a second session). Reading is run by main.
 */
export function usePursuits(
  api: PursuitsBridge | undefined,
  roomId: string | null,
  agentsApi?: AgentsBridge,
) {
  const offers = useRef<PursuitOffer[]>([]);
  const reading = useRef(new Set<string>());
  // Agents asleep (agent time) are kept apart from readers: they are treated as busy, so the idle director skips them.
  const asleep = useRef(new Set<string>());

  useEffect(() => {
    if (!agentsApi) return undefined;
    let cancelled = false;
    agentsApi
      .asleep()
      .then((ids) => {
        if (!cancelled) asleep.current = new Set(ids);
      })
      .catch((error: unknown) => console.warn('[agents] could not read who is asleep', error));
    const unsubscribe = agentsApi.onChanged((ids) => {
      asleep.current = new Set(ids);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [agentsApi]);

  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    const load = (): void => {
      api
        .offers()
        .then((list) => {
          if (!cancelled) offers.current = list;
        })
        .catch((error: unknown) => console.warn('[pursuits] could not read the stations', error));
    };
    load();
    api
      .running()
      .then((ids) => {
        if (!cancelled) reading.current = new Set(ids);
      })
      .catch((error: unknown) => console.warn('[pursuits] could not read who is reading', error));
    const unsubscribe = api.onChanged((ids) => {
      reading.current = new Set(ids);
    });
    const timer = setInterval(load, OFFERS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
    };
    // A different room may hold other stations.
  }, [api, roomId]);

  const pursuitsFor = useCallback(
    (avatarId: string) => offersFor(offers.current, roomId, avatarId),
    [roomId],
  );
  const pursuing = useCallback(
    (avatarId: string) => reading.current.has(avatarId) || asleep.current.has(avatarId),
    [],
  );
  const startPursuit = useCallback(
    async (avatarId: string, stationId: string) => {
      if (!api) return false;
      // Counted at once, so the avatar is not offered another before main's "changed" arrives.
      reading.current.add(avatarId);
      try {
        const result = await api.start(avatarId, stationId);
        if (!result.ok) reading.current.delete(avatarId);
        return result.ok;
      } catch (error) {
        reading.current.delete(avatarId);
        throw error;
      }
    },
    [api],
  );
  return useMemo(
    () => ({ pursuitsFor, pursuing, startPursuit }),
    [pursuitsFor, pursuing, startPursuit],
  );
}
