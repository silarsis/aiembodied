/**
 * Where an avatar's saved settings live. They are still keyed by VRM model id (so everything
 * saved before avatars existed keeps working, and nothing is migrated destructively); an avatar
 * id reaches them through its profile's `vrmModelId`.
 */
import type { AvatarRegistry } from './avatar-registry.js';

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

/**
 * Key helpers for one avatar. No avatar id means the avatar of the active VRM model, which is
 * what the settings screens meant before avatars had ids.
 */
export class AvatarSettingsKeys {
  constructor(private readonly registry: Pick<AvatarRegistry, 'get' | 'activeAvatarId'>) {}

  private modelFor(avatarId?: string | null): string | null {
    const id = avatarId || this.registry.activeAvatarId();
    return this.registry.get(id)?.vrmModelId ?? null;
  }

  voice(engine: VoiceKeyEngine, avatarId?: string | null): string | null {
    const model = this.modelFor(avatarId);
    return model ? voiceKeyForModel(model, engine) : null;
  }

  idleHabits(avatarId?: string | null): string | null {
    const model = this.modelFor(avatarId);
    return model ? idleHabitsKeyForModel(model) : null;
  }

  prompt(avatarId?: string | null): string | null {
    const model = this.modelFor(avatarId);
    return model ? promptKeyForModel(model) : null;
  }
}
