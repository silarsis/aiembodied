import { FloorController } from './index.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface FloorIpcOptions {
  handle: HandleIpc;
  placeOf: (event: unknown) => string;
  existingFloor: (placeId: string) => FloorController | undefined;
  floor: () => FloorController | null;
}

export function registerFloorIpc(options: FloorIpcOptions): void {
  const { handle, placeOf, existingFloor, floor } = options;

  // Kevin started speaking over the avatars: cancel what they say and drop what waits.
  handle('floor:interrupt', (event) => {
    existingFloor(placeOf(event))?.interrupt();
  });
  handle('floor:get-hear-chatter', () => floor()?.hearChatter() ?? false);
  handle(
    'floor:set-hear-chatter',
    (_event, enabled: unknown) => floor()?.setHearChatter(enabled === true) ?? false,
  );
}
