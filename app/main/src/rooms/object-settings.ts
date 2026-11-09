/** The "Make missing objects" settings of the 3D rooms tab, saved under the `rooms.objects` key. */
export const OBJECT_SETTINGS_KEY = 'rooms.objects';

export const MAX_OBJECTS_PER_ROOM = 8;

export interface ObjectSettings {
  /** Make objects the Poly Haven library has nothing for, with the image and 3D steps. */
  enabled: boolean;
  /** At most this many new objects per room (0 to 8); the rest become simple shapes. */
  maxPerRoom: number;
}

export const DEFAULT_OBJECT_SETTINGS: ObjectSettings = { enabled: true, maxPerRoom: 3 };

/** What the tab shows: the settings, and whether the image and 3D steps are set up. */
export interface ObjectSettingsView extends ObjectSettings {
  available: boolean;
}

/** Anything unreadable falls back to the default for that field. */
export function sanitizeObjectSettings(input: unknown): ObjectSettings {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const count = typeof value.maxPerRoom === 'number' && Number.isFinite(value.maxPerRoom) ? Math.round(value.maxPerRoom) : DEFAULT_OBJECT_SETTINGS.maxPerRoom;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_OBJECT_SETTINGS.enabled,
    maxPerRoom: Math.min(MAX_OBJECTS_PER_ROOM, Math.max(0, count)),
  };
}

export function parseObjectSettings(raw: string | null | undefined): ObjectSettings {
  if (!raw) return { ...DEFAULT_OBJECT_SETTINGS };
  try {
    return sanitizeObjectSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_OBJECT_SETTINGS };
  }
}

/** A generated object in the tab's list. */
export interface GeneratedObjectSummary {
  /** Folder name; also what `deleteGeneratedObject` takes. */
  id: string;
  name: string;
  created: string;
  /** `aiembodied-asset://` URL of the picture the model was made from. */
  imageUrl: string;
}
