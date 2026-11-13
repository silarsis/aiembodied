/** The renderer's bridge to a satellite PC's own state: pairing with bija and the link. Types only. */
import type { PairInput, SatelliteStatus } from './satellite.js';

export type { PairInput, SatelliteStatus };

export interface SatelliteBridge {
  status(): Promise<SatelliteStatus>;
  /** Pushed when the pairing or the link changes. Returns the unsubscribe function. */
  onStatus(listener: (status: SatelliteStatus) => void): () => void;
  /** Pairs with bija using the 6-digit code from Settings > Places > Add a desktop room. Rejects with a sentence Kevin can read. */
  pair(input: PairInput): Promise<SatelliteStatus>;
  /** Forgets bija on this PC. */
  forget(): Promise<SatelliteStatus>;
}
