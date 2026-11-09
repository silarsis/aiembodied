/** Builds the real room generation service from the app's settings. Kept out of main.ts. */
import path from 'node:path';
import type { ModelRouting } from '../config/model-routing.js';
import type { ServerKeyLookup } from '../local-voice/voice-engines.js';
import { PolyHavenClient } from './asset-library/polyhaven.js';
import { PolyHavenSource } from './asset-library/library-source.js';
import { generateRoomLayout } from './room-layout-llm.js';
import { RoomGenerationService } from './room-generation.js';

export const ASSET_FOLDER = 'assets';

export function createRoomGenerationService(options: {
  userData: string;
  routing: () => ModelRouting;
  keyFor: ServerKeyLookup;
  appVersion: string;
  logger: Pick<Console, 'warn'>;
}): RoomGenerationService {
  const roomsDirectory = path.join(options.userData, 'rooms');
  const library = new PolyHavenClient({ root: path.join(roomsDirectory, ASSET_FOLDER), appVersion: options.appVersion, logger: options.logger });
  return new RoomGenerationService({
    roomsDirectory,
    writeLayout: (description, signal) =>
      generateRoomLayout(description, { routing: options.routing(), keyFor: options.keyFor, signal, logger: options.logger }),
    // Step 5 slots a generator source between the library and the primitive shapes here.
    sources: [new PolyHavenSource(library, options.logger)],
  });
}
