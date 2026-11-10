import type { IdleSettings } from '../rooms/idle-settings.js';
import type { GeneratedObjectSummary, ObjectSettings, ObjectSettingsView } from '../rooms/object-settings.js';
import type { RoomGenerationProgress, RoomGenerationResult } from '../rooms/room-generation.js';
import type { IdlePickContext, IdlePickResult, RoomFile, RoomSummary } from '../rooms/types.js';

export interface BackgroundSummary {
  id: string;
  name: string;
  builtIn: boolean;
  thumbnailDataUrl: string;
  /** The user's own description that generated this scene; absent for included scenes. */
  description?: string;
  /** Shared composition anchor: object-position and projected avatar feet use this same fraction. */
  groundY: number;
}

export interface BackgroundBridge {
  list(): Promise<BackgroundSummary[]>;
  getActive(): Promise<string | null>;
  setActive(id: string | null): Promise<void>;
  load(id: string): Promise<string>;
  generate(prompt: string): Promise<BackgroundSummary>;
  delete(id: string): Promise<void>;
  listRooms(): Promise<RoomSummary[]>;
  loadRoom(id: string): Promise<RoomFile>;
  /** Describe a room in words and build it (resolves when saved; progress comes through onRoomProgress). */
  generateRoom?(description: string): Promise<RoomGenerationResult>;
  cancelRoomGeneration?(): Promise<boolean>;
  /** Deletes a saved (not built-in) room. */
  deleteRoom?(id: string): Promise<void>;
  onRoomProgress?(listener: (progress: RoomGenerationProgress) => void): () => void;
  /** The "When idle" settings of 3D rooms (key `rooms.idle`). */
  getIdleSettings?(): Promise<IdleSettings>;
  setIdleSettings?(settings: IdleSettings): Promise<IdleSettings>;
  /** The "Make missing objects" settings (key `rooms.objects`), with whether the image and 3D steps are set up. */
  getObjectSettings?(): Promise<ObjectSettingsView>;
  setObjectSettings?(settings: Partial<ObjectSettings>): Promise<ObjectSettingsView>;
  /** Objects the app made for rooms, with the picture each came from. */
  listGeneratedObjects?(): Promise<GeneratedObjectSummary[]>;
  deleteGeneratedObject?(id: string): Promise<void>;
  /** The room whose objects are still being made in the background, or null. */
  getMakingRoom?(): Promise<string | null>;
  /** A saved room's file changed (an object was made); reload it if it is showing. */
  onRoomUpdated?(listener: (roomId: string) => void): () => void;
  /** Ask the Idle thoughts model what to do next; null when it fails (pick at random instead). */
  pickIdle?(context: IdlePickContext): Promise<IdlePickResult | null>;
}
