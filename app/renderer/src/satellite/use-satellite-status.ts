import { useEffect, useState } from 'react';
import type { SatelliteBridge, SatelliteStatus } from '../../../main/src/satellite/bridge-types.js';

/** Follows the satellite's pairing and link: read once, then pushed on every change. Null until the first answer. */
export function useSatelliteStatus(bridge: SatelliteBridge | undefined): SatelliteStatus | null {
  const [status, setStatus] = useState<SatelliteStatus | null>(null);
  useEffect(() => {
    if (!bridge) return undefined;
    let cancelled = false;
    const off = bridge.onStatus((next) => {
      if (!cancelled) setStatus(next);
    });
    bridge
      .status()
      .then((first) => {
        // A push that arrived while the first read was on its way is newer.
        if (!cancelled) setStatus((current) => current ?? first);
      })
      .catch((error: unknown) => console.warn('Could not read the satellite status', error));
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);
  return status;
}
