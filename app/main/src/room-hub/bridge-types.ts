/** The renderer's bridge to desktop rooms (Settings > Places). Types only. */
import type { Place } from '../places/place-manager.js';
import type { PairingStart, RoomHubStatus } from './room-hub.js';

export type { PairingStart, RoomHubStatus };

export interface RoomHubBridge {
  status(): Promise<RoomHubStatus>;
  /** Pushed when a desktop room connects or drops, or a code is made, used or expires. Returns the unsubscribe function. */
  onChanged(listener: (status: RoomHubStatus) => void): () => void;
  /** Makes a one-time 6-digit code, valid for 5 minutes. `placeName` names the new room. */
  startPairing(placeName: string): Promise<PairingStart>;
  cancelPairing(): Promise<void>;
  /** Forgets a desktop room. Its avatars come home. */
  revoke(deviceId: string): Promise<boolean>;
  /** Renames any place. Null when the name is empty or the place is unknown. */
  rename(placeId: string, name: string): Promise<Place | null>;
  /** Picks the room a desktop room draws: a 3D room id (`room:builtin:studio-flat`) or a background id. False when it is not a desktop room. */
  setRoom?(placeId: string, room: string): Promise<boolean>;
}
