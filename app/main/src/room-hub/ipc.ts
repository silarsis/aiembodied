import { PlaceManager } from '../places/place-manager.js';
import { PlacePresence } from '../presence/place-presence.js';
import { RoomHub } from './room-hub.js';
import { PlaceDevices } from './place-devices.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

/** What the Places page and the Status panel show: each desktop room with what its PC says about its devices. */
export function roomHubStatus(hub: RoomHub, placePresence: PlacePresence) {
  const status = hub.status();
  return {
    ...status,
    devices: status.devices.map((device) => ({
      ...device,
      deviceState: placePresence.deviceState(device.placeId),
    })),
  };
}

export interface RoomHubIpcOptions {
  handle: HandleIpc;
  roomHub: () => RoomHub | null;
  requirePlaces: () => PlaceManager;
  placePresence: PlacePresence;
  placeDevices: () => PlaceDevices | null;
}

export function registerRoomHubIpc(options: RoomHubIpcOptions): void {
  const { handle, roomHub, requirePlaces, placePresence, placeDevices } = options;

  // Settings > Places: desktop rooms (pairing, who is connected, rename, revoke).
  const requireRoomHub = (): RoomHub => {
    const hub = roomHub();
    if (!hub) throw new Error('Desktop rooms are not available yet.');
    return hub;
  };
  handle('room-hub:status', () => roomHubStatus(requireRoomHub(), placePresence));
  handle('room-hub:start-pairing', (_event, placeName: unknown) =>
    requireRoomHub().startPairing(typeof placeName === 'string' ? placeName : undefined),
  );
  handle('room-hub:cancel-pairing', async () => {
    await requireRoomHub().cancelPairing();
  });
  handle('room-hub:revoke', async (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string') return false;
    const place = requireRoomHub()
      .status()
      .devices.find((device) => device.id === deviceId)?.placeId;
    const revoked = await requireRoomHub().revoke(deviceId);
    if (revoked && place) placeDevices()?.forget(place);
    return revoked;
  });
  // Which room a desktop room draws (a 3D room id or a background id).
  handle('room-hub:set-room', (_event, placeId: unknown, room: unknown) =>
    typeof placeId === 'string' && typeof room === 'string'
      ? requirePlaces().setRoom(placeId, room)
      : false,
  );
  // "Camera presence" of a place: bija's own (off unless Kevin turns it on) or a desktop room's (on unless he turns it off).
  handle('room-hub:set-camera', (_event, placeId: unknown, on: unknown) =>
    typeof placeId === 'string' && typeof on === 'boolean'
      ? requirePlaces().setCamera(placeId, on)
      : false,
  );
  // "Doorbell" of a place: with nobody there, the wake word still listens and calls an avatar over.
  handle('room-hub:set-doorbell', (_event, placeId: unknown, on: unknown) =>
    typeof placeId === 'string' && typeof on === 'boolean'
      ? requirePlaces().setDoorbell(placeId, on)
      : false,
  );
  handle('room-hub:rename', (_event, placeId: unknown, name: unknown) =>
    typeof placeId === 'string' && typeof name === 'string'
      ? requirePlaces().rename(placeId, name)
      : null,
  );
}
