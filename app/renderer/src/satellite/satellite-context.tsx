import { createContext, useContext } from 'react';
import type { SatelliteBridge, SatelliteStatus } from '../../../main/src/satellite/bridge-types.js';

/** Present only on a satellite PC (a second desktop that draws one room of bija's world). Null in the full app. */
export interface SatelliteContextValue {
  status: SatelliteStatus;
  bridge: SatelliteBridge;
}

export const SatelliteContext = createContext<SatelliteContextValue | null>(null);

/** The satellite's state, or null in the full app. `useSatellite() !== null` is the one "am I a satellite" flag. */
export function useSatellite(): SatelliteContextValue | null {
  return useContext(SatelliteContext);
}
