import { StationRegistry } from './station-registry.js';
import { StationTrips } from './station-trips.js';
import type { Station, StationSource } from '../shared/stations/types.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface StationsIpcOptions {
  handle: HandleIpc;
  stationRegistry: () => StationRegistry | null;
  stationTrips: () => StationTrips | null;
}

export function registerStationsIpc(options: StationsIpcOptions): void {
  const { handle, stationRegistry, stationTrips } = options;

  // Stations (stations/): which tools live at which object. `station:arrived` is the renderer saying the avatar
  // reached the object (or cannot walk); a desktop room sends it too.
  const requireStations = (): StationRegistry => {
    const registry = stationRegistry();
    if (!registry) throw new Error('Stations are unavailable.');
    return registry;
  };
  handle('stations:list', () => requireStations().views());
  handle(
    'stations:hold',
    (_event, roomId: unknown, objectId: unknown, source: unknown, extra: unknown) =>
      requireStations().hold(
        String(roomId ?? ''),
        String(objectId ?? ''),
        (source ?? null) as StationSource | null,
        (extra && typeof extra === 'object' ? extra : {}) as Partial<Station>,
      ),
  );
  handle('stations:update', (_event, id: unknown, changes: unknown) =>
    requireStations().update(
      String(id ?? ''),
      (changes && typeof changes === 'object' ? changes : {}) as Partial<Station>,
    ),
  );
  handle('stations:remove', (_event, id: unknown) => requireStations().remove(String(id ?? '')));
  handle('station:arrived', (_event, useId: unknown) => {
    if (typeof useId === 'string' && useId) stationTrips()?.arrived(useId);
  });
}
