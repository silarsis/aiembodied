import { normalizeIdleHabits } from '../shared/rooms/idle-habits.js';
import { avatarIdForName } from './avatar-id.js';
import { AvatarRegistry, DEFAULT_AVATAR_ID } from './avatar-registry.js';
import type { AvatarProfile } from '../shared/avatars/avatar-registry-types.js';
import { avatarOnlyKeys } from './avatar-settings.js';
import { readTagInstructions } from './tag-instructions.js';
import type { AvatarTagInstructions } from '../shared/avatars/bridge-types.js';
import { VoiceServices } from './voice-services.js';
import { MemoryStore } from '../memory/index.js';
import { SPEAKING_ENGINES } from '../shared/config/model-routing.js';
import { PursuitManager } from '../pursuits/pursuit-manager.js';
import { AgentSync } from '../agent-time/agent-sync.js';
import { AgentSleep } from '../agent-time/sleep.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

/** Lowercase a-z0-9_- slug of an avatar name; "avatar" when nothing usable is left. */
function slugifyAvatarName(name: string): string {
  return avatarIdForName(name).slice(0, 60) || 'avatar';
}

/** Validate the renderer's add/update fields (name <= 80, prompt <= 4000). */
function readAvatarFields(
  input: unknown,
  requireName: boolean,
): { name?: string; vrmModelId?: string | null; prompt?: string } {
  if (!input || typeof input !== 'object') throw new Error('Avatar details are required.');
  const { name, vrmModelId, prompt } = input as Record<string, unknown>;
  const out: { name?: string; vrmModelId?: string | null; prompt?: string } = {};
  if (name !== undefined || requireName) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Give the avatar a name.');
    if (name.trim().length > 80) throw new Error('The name can be at most 80 characters.');
    out.name = name.trim();
  }
  if (vrmModelId !== undefined && vrmModelId !== null) {
    if (typeof vrmModelId !== 'string' || vrmModelId.length > 200) throw new Error('Invalid body.');
    out.vrmModelId = vrmModelId || null;
  } else if (vrmModelId === null) {
    out.vrmModelId = null;
  }
  if (prompt !== undefined) {
    if (typeof prompt !== 'string') throw new Error('The prompt must be text.');
    if (prompt.length > 4000) throw new Error('The prompt can be at most 4000 characters.');
    out.prompt = prompt;
  }
  return out;
}

export interface AvatarsIpcOptions {
  handle: HandleIpc;
  avatarRegistry: () => AvatarRegistry | null;
  memoryStore: () => MemoryStore | null;
  voiceServices: () => VoiceServices | null;
  pursuitManager: () => PursuitManager | null;
  agentSync: () => AgentSync | null;
  agentSleep: AgentSleep;
  placeOf: (event: unknown) => string;
  startAvatarPlumbing: (profile: AvatarProfile) => void;
  stopAvatarPlumbing: (avatarId: string) => void;
  setTagInstructions: (placeId: string, instructions: AvatarTagInstructions) => void;
  characterIdleHabitsKey: (avatarId?: string) => string | null;
  avatarPersona: (avatarId: string) => { persona: string | undefined; ownModel: boolean };
}

export function registerAvatarsIpc(options: AvatarsIpcOptions): void {
  const {
    handle,
    avatarRegistry,
    memoryStore,
    voiceServices,
    pursuitManager,
    agentSync,
    agentSleep,
    placeOf,
    startAvatarPlumbing,
    stopAvatarPlumbing,
    setTagInstructions,
    characterIdleHabitsKey,
    avatarPersona,
  } = options;
  const requireAvatarRegistry = (): AvatarRegistry => {
    const registry = avatarRegistry();
    if (!registry) throw new Error('Avatars are not available yet.');
    return registry;
  };

  handle('avatars:list', () => avatarRegistry()?.list() ?? []);
  handle('avatars:add', (_event, input: unknown) => {
    const registry = requireAvatarRegistry();
    const fields = readAvatarFields(input, true);
    const base = slugifyAvatarName(fields.name ?? '');
    const taken = new Set(registry.list().map((profile) => profile.id));
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base.slice(0, 60)}-${n}`;
    const profile = registry.add({
      id,
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.vrmModelId !== undefined ? { vrmModelId: fields.vrmModelId } : {}),
      ...(fields.prompt ? { prompt: fields.prompt } : {}),
    });
    startAvatarPlumbing(profile);
    void agentSync()?.sync();
    return profile;
  });
  handle('avatars:update', (_event, id: unknown, changes: unknown) => {
    const registry = requireAvatarRegistry();
    if (typeof id !== 'string' || !id) throw new Error('Avatar id is required.');
    const updated = registry.update(id, readAvatarFields(changes, false));
    void agentSync()?.sync();
    return updated;
  });
  // What the idle director needs for the avatars other than Echo: their personality and idle habits, as saved.
  handle('avatars:idle-personas', () => {
    const personas: Record<string, { personality: string; habits: string }> = {};
    for (const profile of avatarRegistry()?.list() ?? []) {
      if (profile.id === DEFAULT_AVATAR_ID) continue;
      const habitsKey = characterIdleHabitsKey(profile.id);
      personas[profile.id] = {
        personality: avatarPersona(profile.id).persona ?? '',
        habits:
          habitsKey && memoryStore ? normalizeIdleHabits(memoryStore()?.getValue(habitsKey)) : '',
      };
    }
    return personas;
  });
  // Each place keeps its own: an avatar's prompt uses the instructions of the place it stands in.
  handle('avatars:set-tag-instructions', (event, instructions: unknown) => {
    setTagInstructions(placeOf(event), readTagInstructions(instructions));
  });
  handle('avatars:remove', (_event, id: unknown) => {
    const registry = requireAvatarRegistry();
    if (typeof id !== 'string' || !id) throw new Error('Avatar id is required.');
    if (id === DEFAULT_AVATAR_ID) throw new Error('Echo cannot be removed.');
    registry.remove(id);
    stopAvatarPlumbing(id);
    voiceServices()?.delete(id);
    pursuitManager()?.interrupt(id, 'removed');
    agentSleep.forget(id);
    void agentSync()?.sync();
    memoryStore()?.deleteReadingNotes(id);
    // Its own voice and idle habits go with it, so a later avatar with the same id starts clean.
    // Settings saved under a library character's VRM model id stay: that character is still in the library.
    for (const key of avatarOnlyKeys(id, SPEAKING_ENGINES)) memoryStore()?.deleteValue(key);
  });
}
