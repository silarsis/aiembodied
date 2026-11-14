/** The renderer's bridge to a satellite PC's own state: pairing with bija and the link. Types only. */
import type { PairInput, SatelliteStatus, TurnTiming } from './satellite.js';
import type { DeviceGateState } from './device-gate.js';

export type { PairInput, SatelliteStatus, TurnTiming, DeviceGateState };

export interface SatelliteBridge {
  status(): Promise<SatelliteStatus>;
  /** Pushed when the pairing or the link changes. Returns the unsubscribe function. */
  onStatus(listener: (status: SatelliteStatus) => void): () => void;
  /** Pairs with bija using the 6-digit code from Settings > Places > Add a desktop room. Rejects with a sentence Kevin can read. */
  pair(input: PairInput): Promise<SatelliteStatus>;
  /** Forgets bija on this PC. */
  forget(): Promise<SatelliteStatus>;
  /** How long the last spoken turn took on this PC. The main process writes it to the log. */
  reportTurn?(timing: TurnTiming): Promise<void>;
}

/**
 * The privacy gate of a satellite PC, as the page sees it. The gate itself lives in the main process; the page
 * only follows it. When the gate closes the page stops every capture track at once and says so with `captureStopped`.
 */
export interface DeviceGateBridge {
  get(): Promise<DeviceGateState>;
  /** Pushed on every change. Returns the unsubscribe function. */
  onChanged(listener: (state: DeviceGateState) => void): () => void;
  captureStopped(): Promise<void>;
  /** Kevin closes or opens the room (the kill switch). Closing sends the avatars home. */
  setOpen(open: boolean): Promise<DeviceGateState>;
}
