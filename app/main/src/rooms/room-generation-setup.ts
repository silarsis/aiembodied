/** Builds the real room generation service from the app's settings. Kept out of main.ts. */
import path from 'node:path';
import type { ComfyUIClient } from '../avatar/generation/comfyui-client.js';
import type { GeometryModel } from '../avatar/generation/character-model-service.js';
import type { ImageWorkflowModel } from '../avatar/generation/image-workflows.js';
import { routeTargets, type ModelRouting } from '../config/model-routing.js';
import type { ServerKeyLookup } from '../local-voice/voice-engines.js';
import type { AvatarCharacterModelSelection } from '../avatar/types.js';
import { GeneratedLibrary } from './asset-library/generated-library.js';
import { GeneratedSource } from './asset-library/generated-source.js';
import { PolyHavenClient } from './asset-library/polyhaven.js';
import { PolyHavenSource } from './asset-library/library-source.js';
import { OBJECT_SETTINGS_KEY, parseObjectSettings, type ObjectSettings } from './object-settings.js';
import { ASSET_FOLDER } from './asset-folder.js';
import { generateRoomLayout } from './room-layout-llm.js';
import { RoomGenerationService } from './room-generation.js';

export { ASSET_FOLDER };

/** The image and 3D steps both have a server in Models and servers. */
export function objectMakingAvailable(routing: ModelRouting): boolean {
  return routeTargets(routing, 'image').length > 0 && routeTargets(routing, 'mesh').length > 0;
}

/**
 * The 3D model for a single picture: TRELLIS.2 (textured, front image only) when it is installed,
 * else the studio's selected one, which is Hunyuan3D 2mv run from the front image alone.
 */
export async function pickSingleImageGeometry(models: {
  list(): Promise<Pick<AvatarCharacterModelSelection, 'geometry'>>;
  resolveGeometry(id?: string): Promise<GeometryModel>;
}): Promise<GeometryModel> {
  const { geometry } = await models.list();
  const single = geometry.find((entry) => entry.available && !entry.views);
  return models.resolveGeometry(single?.id);
}

export function createRoomGenerationService(options: {
  userData: string;
  routing: () => ModelRouting;
  keyFor: ServerKeyLookup;
  appVersion: string;
  logger: Pick<Console, 'warn'>;
  /** Reads the saved "Make missing objects" settings (`rooms.objects`). */
  readSetting?: (key: string) => string | null | undefined;
  /** The studio's ComfyUI path; without it missing objects become simple shapes. */
  comfy?: {
    pick: (stage: 'image' | 'mesh') => Promise<ComfyUIClient>;
    imageModel: () => Promise<ImageWorkflowModel>;
    geometryModel: () => Promise<GeometryModel>;
  };
  onRoomUpdated?: (roomId: string) => void;
}): RoomGenerationService {
  const roomsDirectory = path.join(options.userData, 'rooms');
  const assetsRoot = path.join(roomsDirectory, ASSET_FOLDER);
  const library = new PolyHavenClient({ root: assetsRoot, appVersion: options.appVersion, logger: options.logger });
  const generated = options.comfy
    ? new GeneratedSource({
        library: new GeneratedLibrary(assetsRoot),
        pickComfy: options.comfy.pick,
        imageModel: options.comfy.imageModel,
        geometryModel: options.comfy.geometryModel,
        logger: options.logger,
      })
    : undefined;
  return new RoomGenerationService({
    roomsDirectory,
    writeLayout: (description, signal) =>
      generateRoomLayout(description, { routing: options.routing(), keyFor: options.keyFor, signal, logger: options.logger }),
    // Library first, then objects made earlier; whatever is left is made in the background, then shapes.
    sources: [new PolyHavenSource(library, options.logger), ...(generated ? [generated] : [])],
    generator: generated,
    objectSettings: (): ObjectSettings & { available: boolean } => ({
      ...parseObjectSettings(options.readSetting?.(OBJECT_SETTINGS_KEY)),
      available: objectMakingAvailable(options.routing()),
    }),
    onRoomUpdated: options.onRoomUpdated,
    logger: options.logger,
  });
}
