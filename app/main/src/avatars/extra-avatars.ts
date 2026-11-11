/**
 * Dev way to try several avatars: `AIEMBODIED_EXTRA_AVATARS=Sage,Rex` makes the registry create
 * those profiles at start if they are missing. They wear the active VRM model (so there is no
 * second body to load) and keep separate conversation histories.
 */
import type { AvatarProfile, AvatarRegistry } from './avatar-registry.js';

export const EXTRA_AVATARS_ENV = 'AIEMBODIED_EXTRA_AVATARS';

export function defaultPersonaPrompt(name: string): string {
  return `You are ${name}, another AI in the room with Echo and Kevin. You have your own opinions and a voice of your own. Keep what you say short and natural, and talk to whoever spoke to you.`;
}

/** Names from the environment variable, trimmed, without empty entries or repeats. */
export function parseExtraAvatarNames(value: string | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of (value ?? '').split(',')) {
    const name = part.trim();
    const key = avatarIdForName(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** `Sage` -> `sage`; anything outside the id alphabet becomes `-`. */
export function avatarIdForName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Creates the missing profiles. Returns the ones it made. */
export function ensureExtraAvatars(
  registry: Pick<AvatarRegistry, 'get' | 'add'>,
  activeVrmModelId: () => string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): AvatarProfile[] {
  const created: AvatarProfile[] = [];
  for (const name of parseExtraAvatarNames(env[EXTRA_AVATARS_ENV])) {
    const id = avatarIdForName(name);
    if (registry.get(id)) continue;
    created.push(registry.add({ id, name, vrmModelId: activeVrmModelId() ?? null, prompt: defaultPersonaPrompt(name) }));
  }
  return created;
}
