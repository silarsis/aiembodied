import { useCallback, useEffect, useState } from 'react';
import { MAX_IDLE_HABITS_LENGTH } from '../../../main/src/rooms/idle-habits.js';
import type { AvatarBridge } from './types.js';

/**
 * The active character's idle habits: what they like to do when nobody is talking. Each avatar keeps
 * its own (saved by the main process), so the text reloads when the character changes.
 */
export function useIdleHabits(avatarApi: Pick<AvatarBridge, 'getIdleHabits' | 'setIdleHabits'> | undefined, modelId: string | undefined) {
  // The text belongs to the character it was loaded or typed for; another character shows nothing until its own arrives.
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (!modelId || !avatarApi?.getIdleHabits) return;
    let cancelled = false;
    avatarApi
      .getIdleHabits()
      .then((stored) => {
        if (!cancelled) setDraft({ id: modelId, text: stored ?? '' });
      })
      .catch((error: unknown) => {
        console.warn('Could not read the idle habits', error);
        if (!cancelled) setDraft({ id: modelId, text: '' });
      });
    return () => {
      cancelled = true;
    };
  }, [avatarApi, modelId]);

  const habits = modelId && draft?.id === modelId ? draft.text : '';
  const setHabits = useCallback(
    (text: string) => {
      if (modelId) setDraft({ id: modelId, text });
    },
    [modelId],
  );

  const save = useCallback(async () => {
    if (!modelId || !avatarApi?.setIdleHabits) return;
    try {
      await avatarApi.setIdleHabits(habits.trim().slice(0, MAX_IDLE_HABITS_LENGTH));
    } catch (error) {
      console.error('Failed to save the idle habits', error);
    }
  }, [avatarApi, modelId, habits]);

  return { habits, setHabits, save, available: Boolean(modelId && avatarApi?.setIdleHabits), maxLength: MAX_IDLE_HABITS_LENGTH };
}
