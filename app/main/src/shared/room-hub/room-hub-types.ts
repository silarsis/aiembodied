// Types only: shared/ holds what the main process and the renderer both need.
import type { PlaceDeviceState } from '../presence/place-presence-types.js';
import type { DeviceKind } from './room-devices-types.js';


export interface RoomHubDeviceStatus {
  id: string;
  name: string;
  /** Shown on the Places page: a desktop, a phone or a browser. */
  kind?: DeviceKind;
  placeId: string;
  online: boolean;
  lastSeen: number;
  tailscaleNode: string | null;
  /** What the PC last said about its mic, camera, speakers, lock, kill switch and full-screen apps. Added by main.ts. */
  deviceState?: PlaceDeviceState | null;
}


export interface RoomHubStatus {
  running: boolean;
  port: number | null;
  /** Addresses the server listens on. */
  addresses: string[];
  /** Set (on Windows) when the hub started listening for the first time on this PC; the Places page shows it. */
  firewallNote?: string | null;
  pairing: { code: string; expiresAt: number; placeName: string | null } | null;
  devices: RoomHubDeviceStatus[];
}


export interface PairingStart {
  code: string;
  expiresAt: number;
  /** Where to point the other PC (`http://<host>:<port>`). */
  urls: string[];
}
