/**
 * The avatars the app knows about. Today there is one, `echo`; phase 3 adds more to the same
 * scene. Profiles are kept as a JSON array in the memory store's KV table, created lazily on the
 * first read, so an existing install gets its single `echo` profile without any migration step.
 *
 * Per-avatar settings (prompt, voice, idle habits) are still saved under the VRM model id, so a
 * profile's `vrmModelId` is what ties an avatar to them (see avatar-settings.ts).
 */

export const DEFAULT_AVATAR_ID = 'echo';
export const AVATAR_PROFILES_KEY = 'avatars.profiles';

export interface AvatarProfile {
  id: string;
  name: string;
  /** The body (VRM model) this avatar wears, or null when it has none of its own yet. */
  vrmModelId: string | null;
}

export interface AvatarRegistryStore {
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
}

export interface AvatarRegistryOptions {
  store: AvatarRegistryStore;
  /**
   * The VRM model picked in the character settings. The default avatar always follows it, so with
   * one avatar picking another model behaves as it always has.
   */
  activeVrmModelId?: () => string | null | undefined;
  /** Name for the lazily created default profile. */
  defaultName?: string;
}

export type AvatarProfileInput = { id: string; name?: string; vrmModelId?: string | null };
export type AvatarProfileUpdate = { name?: string; vrmModelId?: string | null };

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseProfiles(raw: string | null): AvatarProfile[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const seen = new Set<string>();
    const profiles: AvatarProfile[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const { id, name, vrmModelId } = item as Record<string, unknown>;
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      profiles.push({
        id,
        name: typeof name === 'string' && name.trim() ? name.trim() : id,
        vrmModelId: typeof vrmModelId === 'string' && vrmModelId ? vrmModelId : null,
      });
    }
    return profiles.length > 0 ? profiles : null;
  } catch {
    return null;
  }
}

export class AvatarRegistry {
  private readonly store: AvatarRegistryStore;
  private readonly activeVrmModelId: () => string | null | undefined;
  private readonly defaultName: string;

  constructor(options: AvatarRegistryOptions) {
    this.store = options.store;
    this.activeVrmModelId = options.activeVrmModelId ?? (() => null);
    this.defaultName = options.defaultName ?? 'Echo';
  }

  private load(): AvatarProfile[] {
    const stored = parseProfiles(this.store.getValue(AVATAR_PROFILES_KEY));
    if (stored) return stored;
    const created: AvatarProfile[] = [
      { id: DEFAULT_AVATAR_ID, name: this.defaultName, vrmModelId: this.activeVrmModelId() ?? null },
    ];
    this.save(created);
    return created;
  }

  private save(profiles: AvatarProfile[]): void {
    this.store.setValue(AVATAR_PROFILES_KEY, JSON.stringify(profiles));
  }

  /** The default avatar wears whatever model is active; others wear the one saved for them. */
  private resolve(profile: AvatarProfile): AvatarProfile {
    if (profile.id !== DEFAULT_AVATAR_ID) return { ...profile };
    return { ...profile, vrmModelId: this.activeVrmModelId() ?? profile.vrmModelId };
  }

  /**
   * The profiles as saved, or the default one when nothing is saved yet, without writing anything
   * or looking up the active model. For start-up wiring that only needs ids and names.
   */
  peek(): AvatarProfile[] {
    return (
      parseProfiles(this.store.getValue(AVATAR_PROFILES_KEY)) ?? [{ id: DEFAULT_AVATAR_ID, name: this.defaultName, vrmModelId: null }]
    );
  }

  list(): AvatarProfile[] {
    return this.load().map((profile) => this.resolve(profile));
  }

  get(id: string): AvatarProfile | null {
    const found = this.load().find((profile) => profile.id === id);
    return found ? this.resolve(found) : null;
  }

  add(input: AvatarProfileInput): AvatarProfile {
    const id = input.id.trim();
    if (!ID_PATTERN.test(id)) {
      throw new Error(`Invalid avatar id "${input.id}": use lowercase letters, digits, "-" or "_".`);
    }
    const profiles = this.load();
    if (profiles.some((profile) => profile.id === id)) {
      throw new Error(`Avatar "${id}" already exists.`);
    }
    const profile: AvatarProfile = { id, name: input.name?.trim() || id, vrmModelId: input.vrmModelId ?? null };
    this.save([...profiles, profile]);
    return this.resolve(profile);
  }

  update(id: string, changes: AvatarProfileUpdate): AvatarProfile {
    const profiles = this.load();
    const index = profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error(`Unknown avatar "${id}".`);
    const current = profiles[index];
    const next: AvatarProfile = {
      ...current,
      name: changes.name !== undefined ? changes.name.trim() || current.name : current.name,
      vrmModelId: changes.vrmModelId !== undefined ? changes.vrmModelId : current.vrmModelId,
    };
    profiles[index] = next;
    this.save(profiles);
    return this.resolve(next);
  }

  /** Remove an avatar. The last one cannot go: there is always at least one. */
  remove(id: string): void {
    const profiles = this.load();
    if (!profiles.some((profile) => profile.id === id)) throw new Error(`Unknown avatar "${id}".`);
    if (profiles.length <= 1) throw new Error('Cannot remove the last avatar.');
    this.save(profiles.filter((profile) => profile.id !== id));
  }

  /** The avatar wearing a VRM model, or null when none does. */
  idFor(vrmModelId: string | null | undefined): string | null {
    if (!vrmModelId) return null;
    return this.list().find((profile) => profile.vrmModelId === vrmModelId)?.id ?? null;
  }

  /** The avatar of the active VRM model; the default avatar when no profile claims it. */
  activeAvatarId(): string {
    return this.idFor(this.activeVrmModelId()) ?? DEFAULT_AVATAR_ID;
  }
}
