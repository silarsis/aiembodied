/**
 * The "When idle" settings of the Backgrounds pop-up's 3D rooms tab, saved under the `rooms.idle` key,
 * plus how tall the avatar stands in rooms (the same tab's "Avatar height").
 */
export const IDLE_SETTINGS_KEY = 'rooms.idle';

export type Restlessness = 'calm' | 'normal' | 'restless';
/** What the avatar does when the user starts talking after it wandered off. */
export type OnTalk = 'come-back' | 'turn';

export interface IdleSettings {
  /** Wander when nobody is talking. */
  enabled: boolean;
  restlessness: Restlessness;
  onTalk: OnTalk;
  /** How tall the avatar stands in 3D rooms, sole to crown, in metres. */
  avatarHeight: number;
}

export const MIN_ROOM_AVATAR_HEIGHT = 1.0;
export const MAX_ROOM_AVATAR_HEIGHT = 2.2;

export const DEFAULT_IDLE_SETTINGS: IdleSettings = { enabled: true, restlessness: 'normal', onTalk: 'turn', avatarHeight: 1.6 };

/** Mean wait between idle actions, in seconds. */
export const RESTLESSNESS_MEAN_SECONDS: Record<Restlessness, number> = { calm: 180, normal: 90, restless: 40 };

/** Anything unreadable falls back to the default for that field. */
export function sanitizeIdleSettings(input: unknown): IdleSettings {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_IDLE_SETTINGS.enabled,
    restlessness:
      value.restlessness === 'calm' || value.restlessness === 'normal' || value.restlessness === 'restless'
        ? value.restlessness
        : DEFAULT_IDLE_SETTINGS.restlessness,
    onTalk: value.onTalk === 'come-back' || value.onTalk === 'turn' ? value.onTalk : DEFAULT_IDLE_SETTINGS.onTalk,
    avatarHeight:
      typeof value.avatarHeight === 'number' && Number.isFinite(value.avatarHeight)
        ? Math.round(Math.min(MAX_ROOM_AVATAR_HEIGHT, Math.max(MIN_ROOM_AVATAR_HEIGHT, value.avatarHeight)) * 100) / 100
        : DEFAULT_IDLE_SETTINGS.avatarHeight,
  };
}

/** The settings as saved (a JSON string in the memory store), defaults when missing or broken. */
export function parseIdleSettings(raw: string | null | undefined): IdleSettings {
  if (!raw) return { ...DEFAULT_IDLE_SETTINGS };
  try {
    return sanitizeIdleSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_IDLE_SETTINGS };
  }
}
