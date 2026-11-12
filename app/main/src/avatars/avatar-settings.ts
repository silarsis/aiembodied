/**
 * Where an avatar's saved settings live. They are still keyed by VRM model id (so everything
 * saved before avatars existed keeps working, and nothing is migrated destructively); an avatar
 * id reaches them through its profile's `vrmModelId`.
 *
 * An avatar that shares Echo's body (no model of its own, or the very model Echo wears) must not
 * borrow Echo's settings, so its voice and idle habits are keyed by a pseudo model id made from
 * its avatar id, `avatar:<id>`. Its personality is the profile's `prompt`, so it has no prompt key.
 */
import { DEFAULT_AVATAR_ID, type AvatarRegistry } from './avatar-registry.js';

/** The engine ids a voice is saved per; 'openai' keeps the key it always had. */
export type VoiceKeyEngine = string;

export function voiceKeyForModel(vrmModelId: string, engine: VoiceKeyEngine): string {
  return engine === 'openai' ? `avatar.voice.${vrmModelId}` : `avatar.voice.${vrmModelId}.${engine}`;
}

export function idleHabitsKeyForModel(vrmModelId: string): string {
  return `avatar.idleHabits.${vrmModelId}`;
}

export function promptKeyForModel(vrmModelId: string): string {
  return `avatar.prompt.${vrmModelId}`;
}

const PSEUDO_PREFIX = 'avatar:';

/** The stand-in model id an avatar sharing Echo's body saves its voice and idle habits under. */
export function pseudoModelIdForAvatar(avatarId: string): string {
  return `${PSEUDO_PREFIX}${avatarId}`;
}

/**
 * Every key that belongs to an avatar sharing Echo's body, for clean-up when it is removed. Settings
 * saved under a real VRM model id are left alone: that character stays in the library.
 */
export function avatarOnlyKeys(avatarId: string, engines: readonly VoiceKeyEngine[]): string[] {
  const model = pseudoModelIdForAvatar(avatarId);
  return [idleHabitsKeyForModel(model), voiceKeyForModel(model, 'openai'), ...engines.map((engine) => voiceKeyForModel(model, engine))];
}

/**
 * Key helpers for one avatar. No avatar id means the avatar of the active VRM model, which is
 * what the settings screens meant before avatars had ids.
 */
export class AvatarSettingsKeys {
  constructor(private readonly registry: Pick<AvatarRegistry, 'get' | 'activeAvatarId'>) {}

  private modelFor(avatarId?: string | null): string | null {
    const id = avatarId || this.registry.activeAvatarId();
    const profile = this.registry.get(id);
    if (!profile) return null;
    if (id === DEFAULT_AVATAR_ID) return profile.vrmModelId;
    return this.sharesEchoBody(id) ? pseudoModelIdForAvatar(id) : profile.vrmModelId;
  }

  /** True for an avatar other than Echo with no body of its own (or wearing the one Echo wears). */
  sharesEchoBody(avatarId: string): boolean {
    if (avatarId === DEFAULT_AVATAR_ID) return false;
    const profile = this.registry.get(avatarId);
    if (!profile) return false;
    return !profile.vrmModelId || profile.vrmModelId === this.registry.get(DEFAULT_AVATAR_ID)?.vrmModelId;
  }

  voice(engine: VoiceKeyEngine, avatarId?: string | null): string | null {
    const model = this.modelFor(avatarId);
    return model ? voiceKeyForModel(model, engine) : null;
  }

  idleHabits(avatarId?: string | null): string | null {
    const model = this.modelFor(avatarId);
    return model ? idleHabitsKeyForModel(model) : null;
  }

  /** Null for an avatar sharing Echo's body: its prompt is the profile's own `prompt`. */
  prompt(avatarId?: string | null): string | null {
    const id = avatarId || this.registry.activeAvatarId();
    if (this.sharesEchoBody(id)) return null;
    const model = this.modelFor(id);
    return model ? promptKeyForModel(model) : null;
  }
}
