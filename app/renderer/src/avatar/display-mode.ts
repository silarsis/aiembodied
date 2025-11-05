import type { AvatarModelSummary } from './types.js';

export type AvatarDisplayMode = 'sprites' | 'vrm';

export interface AvatarDisplayState {
  mode: AvatarDisplayMode;
  preference: AvatarDisplayMode;
  lastError: string | null;
}

export type AvatarDisplayAction =
  | { type: 'set-mode'; mode: AvatarDisplayMode }
  | { type: 'vrm-ready' }
  | { type: 'vrm-error'; message: string };

export const DEFAULT_AVATAR_DISPLAY_STATE: AvatarDisplayState = {
  mode: 'sprites',
  preference: 'sprites',
  lastError: null,
};

export const AVATAR_DISPLAY_STORAGE_KEY = 'avatarDisplayMode';

export function parseAvatarDisplayMode(value: unknown): AvatarDisplayMode | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'sprites' || normalized === 'vrm') {
    return normalized;
  }

  return null;
}

export function avatarDisplayReducer(
  state: AvatarDisplayState,
  action: AvatarDisplayAction,
): AvatarDisplayState {
  switch (action.type) {
    case 'set-mode': {
      if (action.mode === state.mode && action.mode === state.preference && !state.lastError) {
        return state;
      }
      return {
        mode: action.mode,
        preference: action.mode,
        lastError: null,
      };
    }
    case 'vrm-ready': {
      if (state.preference !== 'vrm') {
        return state.lastError ? { ...state, lastError: null } : state;
      }
      if (state.mode === 'vrm' && !state.lastError) {
        return state;
      }
      return {
        mode: 'vrm',
        preference: 'vrm',
        lastError: null,
      };
    }
    case 'vrm-error': {
      const message = action.message?.trim() || 'VRM renderer encountered an unknown error.';
      if (state.mode === 'sprites' && state.lastError === message) {
        return state;
      }
      return {
        ...state,
        mode: 'sprites',
        lastError: message,
      };
    }
    default:
      return state;
  }
}

export function shouldRenderVrm(
  state: AvatarDisplayState,
  model: AvatarModelSummary | null | undefined,
): boolean {
  return state.mode === 'vrm' && Boolean(model);
}
