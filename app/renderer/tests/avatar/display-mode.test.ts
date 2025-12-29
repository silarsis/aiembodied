import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AVATAR_DISPLAY_STATE,
  avatarDisplayReducer,
  parseAvatarDisplayMode,
  shouldRenderVrm,
} from '../../src/avatar/display-mode.js';

const SAMPLE_MODEL = {
  id: 'vrm-1',
  name: 'Sample',
  createdAt: Date.now(),
  version: '1.0',
  fileSha: 'abc',
  thumbnailDataUrl: null,
  description: null,
};

describe('parseAvatarDisplayMode', () => {
  it('normalizes stored values to known modes', () => {
    expect(parseAvatarDisplayMode('VRM')).toBe('vrm');
    expect(parseAvatarDisplayMode('sprites')).toBe('sprites');
    expect(parseAvatarDisplayMode('  Sprites  ')).toBe('sprites');
  });

  it('rejects unknown inputs', () => {
    expect(parseAvatarDisplayMode('avatar')).toBeNull();
    expect(parseAvatarDisplayMode(undefined)).toBeNull();
  });
});

describe('avatarDisplayReducer', () => {
  it('sets and persists explicit mode selections', () => {
    const next = avatarDisplayReducer(DEFAULT_AVATAR_DISPLAY_STATE, { type: 'set-mode', mode: 'vrm' });
    expect(next.mode).toBe('vrm');
    expect(next.preference).toBe('vrm');
    expect(next.lastError).toBeNull();
  });

  it('falls back to sprites when VRM errors occur', () => {
    const vrmPreferred = { ...DEFAULT_AVATAR_DISPLAY_STATE, mode: 'vrm' as const, preference: 'vrm' as const };
    const next = avatarDisplayReducer(vrmPreferred, {
      type: 'vrm-error',
      message: 'WebGL failed',
    });
    expect(next.mode).toBe('sprites');
    expect(next.preference).toBe('vrm');
    expect(next.lastError).toBe('WebGL failed');
  });

  it('restores VRM mode when the renderer recovers', () => {
    const errorState = {
      mode: 'sprites' as const,
      preference: 'vrm' as const,
      lastError: 'WebGL failed',
    };
    const next = avatarDisplayReducer(errorState, { type: 'vrm-ready' });
    expect(next.mode).toBe('vrm');
    expect(next.preference).toBe('vrm');
    expect(next.lastError).toBeNull();
  });

  it('ignores VRM readiness when sprites are preferred', () => {
    const spritePreferred = { ...DEFAULT_AVATAR_DISPLAY_STATE };
    const next = avatarDisplayReducer(spritePreferred, { type: 'vrm-ready' });
    expect(next).toEqual(spritePreferred);
  });
});

describe('shouldRenderVrm', () => {
  it('requires both VRM mode and an active model', () => {
    const state = { ...DEFAULT_AVATAR_DISPLAY_STATE, mode: 'vrm' as const, preference: 'vrm' as const };
    expect(shouldRenderVrm(state, SAMPLE_MODEL)).toBe(true);
    expect(shouldRenderVrm(state, null)).toBe(false);
    const spriteState = { ...state, mode: 'sprites' as const };
    expect(shouldRenderVrm(spriteState, SAMPLE_MODEL)).toBe(false);
  });
});
