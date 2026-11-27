import { BackgroundService } from '../backgrounds/background-service.js';
import { RoomService } from './room-service.js';
import { pickIdleActions } from './idle-thoughts.js';
import { objectMakingAvailable } from './room-generation-setup.js';
import type { RoomGenerationService } from './room-generation.js';
import { ConfigManager } from '../config/config-manager.js';
import { AicontrollerBridge } from '../aicontroller/bridge.js';
import { BUILT_IN_SERVER_IDS, routeTargets } from '../shared/config/model-routing.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';
import type { Logger } from 'winston';

export interface RoomsIpcOptions {
  handle: HandleIpc;
  logger: Logger;
  manager: ConfigManager;
  aicontroller: AicontrollerBridge;
  broadcast: (channel: string, payload?: unknown) => void;
  rooms: () => RoomService | null;
  backgrounds: () => BackgroundService | null;
  roomGeneration: () => RoomGenerationService | null;
}

export function registerRoomsIpc(options: RoomsIpcOptions): void {
  const { handle, logger, manager, aicontroller, broadcast, rooms, backgrounds, roomGeneration } =
    options;

  const requireRooms = (): RoomService => {
    const service = rooms();
    if (!service) throw new Error('Rooms are unavailable.');
    return service;
  };
  const requireBackgrounds = (): BackgroundService => {
    const service = backgrounds();
    if (!service) throw new Error('Backgrounds are unavailable.');
    return service;
  };
  handle('background:list-rooms', () => requireRooms().list());
  handle('background:load-room', (_event, id: string) => requireRooms().load(id));
  const requireGeneration = (): RoomGenerationService => {
    const generation = roomGeneration();
    if (!generation) throw new Error('Room building is unavailable.');
    return generation;
  };
  handle('rooms:generate', (_event, description: unknown) =>
    requireGeneration().generate(String(description ?? ''), (progress) =>
      broadcast('rooms:generate-progress', progress),
    ),
  );
  handle('rooms:cancel-generate', () => requireGeneration().cancel());
  handle('rooms:making', () => requireGeneration().making);
  const objectSettingsView = () => ({
    ...requireBackgrounds().getObjectSettings(),
    available: objectMakingAvailable(manager.getConfig().models),
  });
  handle('rooms:object-settings:get', () => objectSettingsView());
  handle('rooms:object-settings:set', (_event, settings: unknown) => {
    requireBackgrounds().setObjectSettings(settings);
    return objectSettingsView();
  });
  handle('rooms:generated:list', () => requireGeneration().listGenerated());
  handle('rooms:generated:delete', (_event, id: unknown) =>
    requireGeneration().deleteGenerated(String(id ?? '')),
  );
  handle('rooms:delete', async (_event, id: string) => {
    await requireGeneration().delete(id);
    const backgroundService = backgrounds();
    if (backgroundService && (await backgroundService.getActive()) === id)
      await backgroundService.setActive(null);
  });
  handle('rooms:idle-settings:get', () => requireBackgrounds().getIdleSettings());
  handle('rooms:idle-settings:set', (_event, settings: unknown) =>
    requireBackgrounds().setIdleSettings(settings),
  );
  // The "Idle thoughts" job: what the avatar does next on its own. Null on any failure; the renderer then picks at random.
  handle('rooms:idle-pick', async (_event, context: unknown) => {
    const routing = manager.getConfig().models;
    // Echo's model is still loading under the model controller: no request, the renderer picks at random.
    if (
      aicontroller.echoWaiting() &&
      routeTargets(routing, 'llm')[0]?.server.id === BUILT_IN_SERVER_IDS.llm
    )
      return null;
    return pickIdleActions(context as { system: string; user: string }, {
      routing,
      keyFor: (id) => manager.getServerKey(id),
      logger,
    });
  });
}
