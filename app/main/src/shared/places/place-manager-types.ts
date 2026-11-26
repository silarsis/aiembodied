// Types only: shared/ holds what the main process and the renderer both need.
import type { PlaceKind } from './place-kind.js';


export interface Place {
  id: string;
  name: string;
  /** 'local' is the screen of this PC, 'offscreen' a place nobody draws, anything else is the device id of the PC that draws it. */
  node: 'local' | 'offscreen' | string;
  /** Only on desktop rooms (a device id as `node`): whether that PC is connected. Absent means always online. */
  online?: boolean;
  /**
   * Only on desktop rooms: the room that PC draws. A 3D room id (`room:builtin:studio-flat`, `room:<id>`) or a
   * 2D background id. The local place shows whatever the stage is set to, so it has none.
   */
  room?: string;
  /** Only on device places, saved only when it is not a desktop: a phone or a browser (place-kind.ts). Absent means a desktop. */
  kind?: PlaceKind;
  /**
   * "Camera presence" for this place, saved only when Kevin changed it. Absent means the default: on for a desktop
   * room, off for this PC, a phone and a browser (see camera-setting.ts).
   */
  camera?: boolean;
  /**
   * "Doorbell" for this place, saved only when changed. Absent means the default: on for this PC, off for a desktop
   * room (see doorbell-setting.ts).
   */
  doorbell?: boolean;
  /** Only in snapshots: Kevin closed this desktop room (the kill switch), so it takes nobody. */
  closed?: boolean;
}


export interface PlacesSnapshot {
  places: Place[];
  /** The place of every avatar in the registry (its last place while it is in transit). */
  locations: Record<string, string>;
  transit: Array<{ avatarId: string; from: string; to: string }>;
  localPlaceId: string;
  /** bija's clock when the snapshot was made. The times below are on this clock, so a reader's own clock does not matter. */
  now?: number;
  /** When each avatar last arrived somewhere (since bija started). Absent for one that has not moved. */
  movedAt?: Record<string, number>;
  /** When someone last used the PC of each place (`powerMonitor` idle time under 60 s). Absent for a place never heard from. */
  activeAt?: Record<string, number>;
}
