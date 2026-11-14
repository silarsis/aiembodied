import { useEffect, useState } from 'react';
import type { RoomHubBridge, RoomHubStatus } from '../../../main/src/room-hub/bridge-types.js';
import type { PlaceDeviceState } from '../../../main/src/presence/place-presence.js';

/** What a desktop room's PC says about its mic and camera, in words ("Mic live, camera off"). */
export function deviceSummary(state: PlaceDeviceState | null | undefined): string {
  if (!state) return 'Devices: not reported yet';
  const word = (level: string) => (level === 'doorbell' ? 'doorbell only' : level);
  const why = state.closed ? ' · room closed' : state.locked ? ' · screen locked' : state.fullscreen ? ' · full-screen app' : '';
  return `Mic ${word(state.mic)}, camera ${word(state.camera)}${why}`;
}

/** bija's Status panel: one line per desktop room with its mic and camera. Nothing when no room is paired. */
export function RoomDevicesStatus({ roomHub, active }: { roomHub: RoomHubBridge | undefined; active: boolean }) {
  const [status, setStatus] = useState<RoomHubStatus | null>(null);
  useEffect(() => {
    if (!roomHub || !active) return undefined;
    let cancelled = false;
    const off = roomHub.onChanged((next) => {
      if (!cancelled) setStatus(next);
    });
    roomHub
      .status()
      .then((first) => {
        if (!cancelled) setStatus((current) => current ?? first);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off();
    };
  }, [roomHub, active]);
  if (!status || status.devices.length === 0) return null;
  return (
    <section className="statusRooms" aria-label="Desktop rooms" data-testid="room-devices-status">
      <h4>Desktop rooms</h4>
      <ul>
        {status.devices.map((device) => (
          <li key={device.id} data-testid={`room-devices-${device.placeId}`}>
            <strong>{device.name}</strong>: {device.online ? deviceSummary(device.deviceState) : 'offline'}
          </li>
        ))}
      </ul>
    </section>
  );
}
