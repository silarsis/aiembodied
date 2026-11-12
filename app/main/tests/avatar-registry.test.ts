import { describe, expect, it } from 'vitest';
import { AVATAR_PROFILES_KEY, AvatarRegistry, DEFAULT_AVATAR_ID } from '../src/avatars/avatar-registry.js';
import { AvatarSettingsKeys, avatarOnlyKeys, pseudoModelIdForAvatar } from '../src/avatars/avatar-settings.js';

function makeRegistry(active: string | null = 'vrm-1') {
  const kv = new Map<string, string>();
  const state = { active };
  const registry = new AvatarRegistry({
    store: { getValue: (key) => kv.get(key) ?? null, setValue: (key, value) => void kv.set(key, value) },
    activeVrmModelId: () => state.active,
  });
  return { registry, kv, state };
}

describe('AvatarRegistry', () => {
  it('creates the default echo profile lazily on first read', () => {
    const { registry, kv } = makeRegistry('vrm-1');
    expect(kv.has(AVATAR_PROFILES_KEY)).toBe(false);
    expect(registry.list()).toEqual([{ id: 'echo', name: 'Echo', vrmModelId: 'vrm-1' }]);
    expect(JSON.parse(kv.get(AVATAR_PROFILES_KEY) ?? '[]')).toHaveLength(1);
    expect(registry.get('echo')?.name).toBe('Echo');
    expect(registry.get('nobody')).toBeNull();
  });

  it('has a null model when none is active, and echo follows the active model afterwards', () => {
    const { registry, state } = makeRegistry(null);
    expect(registry.get(DEFAULT_AVATAR_ID)?.vrmModelId).toBeNull();
    state.active = 'vrm-9';
    expect(registry.get(DEFAULT_AVATAR_ID)?.vrmModelId).toBe('vrm-9');
    expect(registry.idFor('vrm-9')).toBe('echo');
    expect(registry.activeAvatarId()).toBe('echo');
  });

  it('peek reads without writing', () => {
    const { registry, kv } = makeRegistry();
    expect(registry.peek().map((p) => p.id)).toEqual(['echo']);
    expect(kv.size).toBe(0);
  });

  it('adds, updates and removes avatars, and never removes the last', () => {
    const { registry } = makeRegistry();
    registry.add({ id: 'sage', name: 'Sage', vrmModelId: 'vrm-2' });
    expect(registry.list().map((p) => p.id)).toEqual(['echo', 'sage']);
    expect(() => registry.add({ id: 'sage' })).toThrow(/already exists/);
    expect(() => registry.add({ id: 'Bad Id' })).toThrow(/Invalid/);
    expect(registry.idFor('vrm-2')).toBe('sage');
    expect(registry.idFor('nope')).toBeNull();
    expect(registry.idFor(null)).toBeNull();
    expect(registry.update('sage', { name: 'Sage 2', vrmModelId: 'vrm-3' })).toEqual({ id: 'sage', name: 'Sage 2', vrmModelId: 'vrm-3' });
    expect(() => registry.update('ghost', {})).toThrow(/Unknown/);
    registry.remove('sage');
    expect(registry.list().map((p) => p.id)).toEqual(['echo']);
    expect(() => registry.remove('echo')).toThrow(/last avatar/);
    expect(() => registry.remove('ghost')).toThrow(/Unknown/);
  });

  it('falls back to the default when the saved value is corrupt', () => {
    const { registry, kv } = makeRegistry();
    kv.set(AVATAR_PROFILES_KEY, '{nope');
    expect(registry.list().map((p) => p.id)).toEqual(['echo']);
  });
});

describe('AvatarSettingsKeys', () => {
  it('resolves to the same VRM-model-keyed keys as before for echo', () => {
    const { registry } = makeRegistry('vrm-1');
    const keys = new AvatarSettingsKeys(registry);
    expect(keys.voice('openai')).toBe('avatar.voice.vrm-1');
    expect(keys.voice('kokoro')).toBe('avatar.voice.vrm-1.kokoro');
    expect(keys.voice('piper', 'echo')).toBe('avatar.voice.vrm-1.piper');
    expect(keys.prompt()).toBe('avatar.prompt.vrm-1');
    expect(keys.idleHabits('echo')).toBe('avatar.idleHabits.vrm-1');
  });

  it('uses the named avatar model, and null without a model or avatar', () => {
    const { registry } = makeRegistry('vrm-1');
    registry.add({ id: 'sage', vrmModelId: 'vrm-2' });
    registry.add({ id: 'bare' });
    const keys = new AvatarSettingsKeys(registry);
    expect(keys.prompt('sage')).toBe('avatar.prompt.vrm-2');
    expect(keys.prompt('bare')).toBeNull();
    expect(keys.prompt('ghost')).toBeNull();
    expect(makeRegistryKeys(null).prompt()).toBeNull();
  });

  it('gives an avatar sharing Echo\'s body its own voice and idle habits keys, and no prompt key', () => {
    const { registry } = makeRegistry('vrm-1');
    registry.add({ id: 'sage', prompt: 'Be calm.' });
    registry.add({ id: 'twin', vrmModelId: 'vrm-1' });
    const keys = new AvatarSettingsKeys(registry);
    expect(pseudoModelIdForAvatar('sage')).toBe('avatar:sage');
    expect(keys.voice('openai', 'sage')).toBe('avatar.voice.avatar:sage');
    expect(keys.voice('kokoro', 'sage')).toBe('avatar.voice.avatar:sage.kokoro');
    expect(keys.idleHabits('sage')).toBe('avatar.idleHabits.avatar:sage');
    expect(keys.prompt('sage')).toBeNull();
    expect(keys.sharesEchoBody('sage')).toBe(true);
    // Wearing the very model Echo wears is sharing her body: nothing of hers is borrowed.
    expect(keys.idleHabits('twin')).toBe('avatar.idleHabits.avatar:twin');
    expect(keys.prompt('twin')).toBeNull();
    // Echo and library characters keep the model keys.
    expect(keys.idleHabits('echo')).toBe('avatar.idleHabits.vrm-1');
    expect(keys.sharesEchoBody('echo')).toBe(false);
    registry.add({ id: 'luna', vrmModelId: 'vrm-2' });
    expect(keys.idleHabits('luna')).toBe('avatar.idleHabits.vrm-2');
    expect(keys.voice('piper', 'luna')).toBe('avatar.voice.vrm-2.piper');
    expect(keys.prompt('luna')).toBe('avatar.prompt.vrm-2');
    expect(keys.sharesEchoBody('luna')).toBe(false);
    expect(keys.sharesEchoBody('ghost')).toBe(false);
  });

  it('lists the keys that go when an avatar is removed', () => {
    expect(avatarOnlyKeys('sage', ['kokoro', 'piper'])).toEqual([
      'avatar.idleHabits.avatar:sage',
      'avatar.voice.avatar:sage',
      'avatar.voice.avatar:sage.kokoro',
      'avatar.voice.avatar:sage.piper',
    ]);
  });

  it('no avatar id means the avatar of the active model', () => {
    const { registry, state } = makeRegistry('vrm-1');
    registry.add({ id: 'sage', vrmModelId: 'vrm-2' });
    const keys = new AvatarSettingsKeys(registry);
    state.active = 'vrm-2';
    expect(keys.prompt()).toBe('avatar.prompt.vrm-2');
  });

  it('update sets, trims and clears the prompt', () => {
    const { registry } = makeRegistry();
    registry.add({ id: 'sage', name: 'Sage' });
    expect(registry.update('sage', { prompt: '  Be calm.  ' }).prompt).toBe('Be calm.');
    expect(registry.get('sage')?.prompt).toBe('Be calm.');
    expect(registry.update('sage', { name: 'Sagey' }).prompt).toBe('Be calm.');
    const cleared = registry.update('sage', { prompt: '' });
    expect(cleared.prompt).toBeUndefined();
    expect('prompt' in (registry.get('sage') ?? {})).toBe(false);
  });
});

function makeRegistryKeys(active: string | null) {
  return new AvatarSettingsKeys(makeRegistry(active).registry);
}
