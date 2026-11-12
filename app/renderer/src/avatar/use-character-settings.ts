import { useCallback, useEffect, useState } from 'react';
import type { AvatarProfile, AvatarsBridge } from '../../../main/src/avatars/bridge-types.js';
import { MAX_IDLE_HABITS_LENGTH } from '../../../main/src/rooms/idle-habits.js';
import type { SpeakingVoiceOptions } from '../../../main/src/local-voice/types.js';
import type { CharacterSettingsControls } from './character-settings.js';
import type { AvatarBridge } from './types.js';

/** Runs a save, shows its error if any, and tells the app something changed. */
export type Run = (action: () => Promise<unknown>) => Promise<boolean>;

/** What a scene card needs to read and save a character's settings. */
export interface CharacterSettingsContext {
  /** The per-character preference calls (prompt, idle habits, voice). */
  avatarApi?: Pick<AvatarBridge, 'getVoicePreference' | 'setVoicePreference' | 'getPromptPreference' | 'setPromptPreference' | 'getIdleHabits' | 'setIdleHabits'>;
  /** The speaking engine's voices, with the named character's pick. */
  getVoiceOptions?: (avatarId?: string) => Promise<SpeakingVoiceOptions>;
  /** Local conversation: voices come from the speaking engine. Otherwise a fixed list is used. */
  isLocalBackend: boolean;
  /** The voice names of the OpenAI backend. */
  realtimeVoices: string[];
  /** Echo's controls, wired to the app's own state (session instructions, idle persona, voice). */
  echo: CharacterSettingsControls;
}

interface Options {
  context: CharacterSettingsContext;
  avatarsApi: Pick<AvatarsBridge, 'update'>;
  profile: AvatarProfile;
  /** The character wears a body of its own, so its prompt is saved for that body (the profile prompt is only the fallback). */
  ownBody: boolean;
  run: Run;
}

/**
 * The prompt, idle habits and voice of a character other than Echo, read and saved under its avatar id.
 * A character with a body of its own keeps them under that body; one sharing Echo's body keeps its prompt
 * in its profile and its habits and voice under its avatar id (the main process decides the keys).
 */
export function useCharacterSettings({ context, avatarsApi, profile, ownBody, run }: Options): CharacterSettingsControls {
  const { avatarApi, getVoiceOptions, isLocalBackend, realtimeVoices } = context;
  const id = profile.id;

  // Prompt
  // A body of its own: the saved prompt is read first (the profile's is only the fallback). Otherwise the profile's prompt is the prompt.
  const readsSaved = ownBody && Boolean(avatarApi?.getPromptPreference);
  const [prompt, setPrompt] = useState({ text: profile.prompt ?? '', saved: (profile.prompt ?? '').trim(), loaded: !readsSaved });
  useEffect(() => {
    if (!readsSaved || !avatarApi?.getPromptPreference) return;
    let cancelled = false;
    avatarApi
      .getPromptPreference(id)
      .then((stored) => {
        if (cancelled) return;
        const text = stored && stored.length > 0 ? stored : (profile.prompt ?? '');
        setPrompt({ text, saved: text.trim(), loaded: true });
      })
      .catch((error: unknown) => {
        console.warn('Could not read the personality prompt', error);
        if (!cancelled) setPrompt({ text: profile.prompt ?? '', saved: (profile.prompt ?? '').trim(), loaded: true });
      });
    return () => {
      cancelled = true;
    };
    // The fallback is read once per editor; saving replaces it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarApi, id, readsSaved]);
  const savePrompt = useCallback(() => {
    const next = prompt.text.trim();
    if (!prompt.loaded || next === prompt.saved) return;
    const save = ownBody
      ? () => (avatarApi?.setPromptPreference ? avatarApi.setPromptPreference(prompt.text, id) : Promise.reject(new Error('Saving the prompt is not available.')))
      : () => avatarsApi.update(id, { prompt: prompt.text });
    void run(save).then((ok) => {
      if (ok) setPrompt((current) => ({ ...current, saved: next }));
    });
  }, [prompt, ownBody, avatarApi, avatarsApi, id, run]);

  // Idle habits
  const [habits, setHabitsState] = useState({ text: '', saved: '', loaded: false });
  useEffect(() => {
    if (!avatarApi?.getIdleHabits) return;
    let cancelled = false;
    avatarApi
      .getIdleHabits(id)
      .then((stored) => {
        if (!cancelled) setHabitsState({ text: stored ?? '', saved: (stored ?? '').trim(), loaded: true });
      })
      .catch((error: unknown) => {
        console.warn('Could not read the idle habits', error);
        if (!cancelled) setHabitsState({ text: '', saved: '', loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [avatarApi, id, ownBody]);
  const saveHabits = useCallback(() => {
    const next = habits.text.trim().slice(0, MAX_IDLE_HABITS_LENGTH);
    if (!habits.loaded || next === habits.saved || !avatarApi?.setIdleHabits) return;
    void run(() => avatarApi.setIdleHabits?.(next, id) ?? Promise.resolve()).then((ok) => {
      if (ok) setHabitsState((current) => ({ ...current, saved: next }));
    });
  }, [habits, avatarApi, id, run]);

  // Voice
  const [options, setOptions] = useState<SpeakingVoiceOptions | null>(null);
  const [listVoice, setListVoice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (isLocalBackend) {
      if (!getVoiceOptions) return;
      getVoiceOptions(id)
        .then((read) => {
          if (!cancelled) setOptions(read);
        })
        .catch((error: unknown) => console.warn('Could not read the speaking voices', error));
    } else if (avatarApi?.getVoicePreference) {
      avatarApi
        .getVoicePreference(undefined, id)
        .then((stored) => {
          if (!cancelled) setListVoice(stored);
        })
        .catch((error: unknown) => console.warn('Could not read the voice', error));
    }
    return () => {
      cancelled = true;
    };
  }, [isLocalBackend, getVoiceOptions, avatarApi, id, ownBody]);

  return {
    prompt: {
      value: prompt.text,
      onChange: (text) => setPrompt((current) => ({ ...current, text })),
      onBlur: savePrompt,
      disabled: !prompt.loaded,
    },
    habits: {
      value: habits.text,
      onChange: (text) => setHabitsState((current) => ({ ...current, text })),
      onBlur: saveHabits,
      maxLength: MAX_IDLE_HABITS_LENGTH,
      disabled: !habits.loaded,
    },
    voice: isLocalBackend
      ? {
          kind: 'engine',
          options,
          onChange: (voice) => {
            const engine = options?.engine;
            if (!engine) return;
            setOptions((current) => (current ? { ...current, selected: voice || null } : current));
            void run(() => avatarApi?.setVoicePreference(voice, engine, id) ?? Promise.resolve());
          },
        }
      : {
          kind: 'list',
          voices: realtimeVoices,
          value: listVoice && realtimeVoices.includes(listVoice) ? listVoice : (realtimeVoices[0] ?? ''),
          onChange: (voice) => {
            setListVoice(voice);
            void run(() => avatarApi?.setVoicePreference(voice, undefined, id) ?? Promise.resolve());
          },
        },
  };
}
