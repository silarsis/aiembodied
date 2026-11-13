import { useEffect, useState } from 'react';
import type { PlacesBridge, PlacesSnapshot } from '../../../main/src/places/bridge-types.js';

/**
 * Follows the places snapshot: read once, then pushed on every change. Null while it is not known, or when
 * the bridge is missing (tests, a build without places), which means every avatar is on screen.
 */
export function usePlaces(bridge: PlacesBridge | undefined): PlacesSnapshot | null {
  const [snapshot, setSnapshot] = useState<PlacesSnapshot | null>(null);
  useEffect(() => {
    if (!bridge) return undefined;
    let cancelled = false;
    const off = bridge.onChanged((next) => {
      if (!cancelled) setSnapshot(next);
    });
    bridge
      .snapshot()
      .then((first) => {
        // A push that arrived while the first read was on its way is newer.
        if (!cancelled) setSnapshot((current) => current ?? first);
      })
      .catch((error: unknown) => console.warn('Could not read where the avatars are', error));
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);
  return snapshot;
}
