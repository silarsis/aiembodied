import { MAX_IDLE_HABITS_LENGTH, normalizeIdleHabits } from '../shared/rooms/idle-habits.js';
import { AvatarRegistry, DEFAULT_AVATAR_ID } from './avatar-registry.js';
import { ConfigManager } from '../config/config-manager.js';
import { MemoryStore } from '../memory/index.js';
import type { SpeakingVoiceOptions } from '../shared/local-voice/types.js';
import { SpeechServiceClient } from '../local-voice/speech-service-client.js';
import {
  parseSpeakingModel,
  routeTargets,
  SPEAKING_ENGINES,
  speakingVoiceKey,
  type SpeakingEngineId,
} from '../shared/config/model-routing.js';
import { OPENAI_TTS_VOICES } from '../shared/config/model-routing.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';
import type { Logger } from 'winston';

/** For settings: no avatar id means the avatar of the active VRM model (what the screens always meant). */
function settingsAvatarArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface AvatarSettingsIpcOptions {
  handle: HandleIpc;
  logger: Logger;
  manager: ConfigManager;
  memoryStore: () => MemoryStore | null;
  avatarRegistry: () => AvatarRegistry | null;
  characterVoiceKey: (engine: SpeakingEngineId | 'openai', avatarId?: string) => string | null;
  characterIdleHabitsKey: (avatarId?: string) => string | null;
  characterPromptKey: (avatarId?: string) => string | null;
  characterVoice: (engine: SpeakingEngineId | 'openai' | null, avatarId?: string) => string | null;
}

export function registerAvatarSettingsIpc(options: AvatarSettingsIpcOptions): void {
  const {
    handle,
    logger,
    manager,
    memoryStore: getMemoryStore,
    avatarRegistry,
    characterVoiceKey,
    characterIdleHabitsKey,
    characterPromptKey,
    characterVoice,
  } = options;

  /** The voices the character can pick for whatever speaks now, and the one it has (the active character's without an avatar id). */
  const speakingVoiceOptions = async (avatarId?: string): Promise<SpeakingVoiceOptions> => {
    const routing = manager.getConfig().models;
    const target = routeTargets(routing, 'tts')[0];
    const engine = speakingVoiceKey(routing);
    if (!target || !engine) {
      return {
        engine: null,
        label: 'Nothing speaks',
        voices: [],
        defaultVoice: null,
        selected: null,
      };
    }
    const route = routing.routes.tts;
    if (engine === 'openai') {
      return {
        engine,
        label: 'OpenAI',
        voices: [...OPENAI_TTS_VOICES],
        defaultVoice: route.voice || 'alloy',
        selected: characterVoice(engine, avatarId),
      };
    }
    const parsed = parseSpeakingModel(target.model);
    const engines = await new SpeechServiceClient({ baseUrl: target.server.url }).ttsEngines();
    const found = engines?.find((entry) => entry.id === engine);
    let voices: string[] = [];
    let fallback: string | null = null;
    if (engine === 'piper') {
      voices = (found?.models ?? []).filter((model) => model.installed).map((model) => model.id);
    } else {
      const model = found?.models.find((entry) =>
        engine === 'kitten' ? entry.id === parsed.model : true,
      );
      voices = model?.voices ?? [];
      fallback = model?.defaultVoice ?? null;
    }
    if (!found && engine === 'kokoro') {
      voices =
        (await new SpeechServiceClient({ baseUrl: target.server.url }).health())?.voices ?? [];
    }
    return {
      engine,
      label: found?.label ?? engine,
      voices,
      defaultVoice: parsed.legacyVoice || route.voice || fallback || voices[0] || null,
      selected: characterVoice(engine, avatarId),
    };
  };

  // Avatar voice preferences
  const voiceEngine = (engine: unknown): SpeakingEngineId | 'openai' =>
    typeof engine === 'string' && (SPEAKING_ENGINES as readonly string[]).includes(engine)
      ? (engine as SpeakingEngineId)
      : 'openai';

  // Without an engine: the OpenAI voice (the Realtime conversation engine's), as before.
  handle('avatar:voice:get-preference', (_event, engine?: unknown, avatarId?: unknown) => {
    const memoryStore = getMemoryStore();
    if (!memoryStore) {
      logger.warn('Memory store unavailable for avatar voice preference');
      return null;
    }
    const key = characterVoiceKey(voiceEngine(engine), settingsAvatarArg(avatarId));
    return key ? memoryStore.getValue(key) : null;
  });

  handle(
    'avatar:voice:set-preference',
    (_event, voice: unknown, engine?: unknown, avatarId?: unknown) => {
      // An empty voice for an engine clears the character's pick (back to the engine's default).
      if (typeof voice !== 'string' || (!voice && engine === undefined)) {
        logger.warn('Invalid voice preference:', voice);
        return;
      }
      const memoryStore = getMemoryStore();
      if (!memoryStore) {
        logger.warn('Memory store unavailable for avatar voice preference');
        return;
      }
      const key = characterVoiceKey(voiceEngine(engine), settingsAvatarArg(avatarId));
      if (!key) {
        logger.warn('No active avatar model to set voice preference');
        return;
      }
      memoryStore.setValue(key, voice);
      logger.info('Avatar voice preference saved', { key, voice });
    },
  );

  // Per-character personality prompt. Null means the character has none of its own yet, so the
  // renderer falls back to the global prompt (what every character used before this existed).
  handle('avatar:prompt:get-preference', (_event, avatarId?: unknown) => {
    const key = characterPromptKey(settingsAvatarArg(avatarId));
    const memoryStore = getMemoryStore();
    if (!key || !memoryStore) return null;
    const stored = memoryStore.getValue(key);
    return typeof stored === 'string' && stored.length > 0 ? stored : null;
  });

  handle('avatar:prompt:set-preference', (_event, prompt: unknown, avatarId?: unknown) => {
    if (typeof prompt !== 'string') {
      logger.warn('Invalid personality prompt');
      return;
    }
    const key = characterPromptKey(settingsAvatarArg(avatarId));
    const memoryStore = getMemoryStore();
    if (!key || !memoryStore) {
      logger.warn('No active avatar model to save the personality prompt for');
      return;
    }
    memoryStore.setValue(key, prompt.trim());
    logger.info('Avatar personality prompt saved', { key, length: prompt.trim().length });
    // A prompt saved for the character's own body replaces the profile's fallback prompt, so the
    // text shown in the Characters pop-up and the text used for its turns are always the same one.
    const registry = avatarRegistry();
    const named = settingsAvatarArg(avatarId) ?? registry?.activeAvatarId();
    if (named && named !== DEFAULT_AVATAR_ID && registry?.get(named)?.prompt) {
      registry.update(named, { prompt: '' });
    }
  });

  handle('avatar:idle-habits:get', (_event, avatarId?: unknown) => {
    const key = characterIdleHabitsKey(settingsAvatarArg(avatarId));
    const memoryStore = getMemoryStore();
    if (!key || !memoryStore) return '';
    return normalizeIdleHabits(memoryStore.getValue(key));
  });

  handle('avatar:idle-habits:set', (_event, habits: unknown, avatarId?: unknown) => {
    if (typeof habits !== 'string') {
      logger.warn('Invalid idle habits');
      return;
    }
    const key = characterIdleHabitsKey(settingsAvatarArg(avatarId));
    const memoryStore = getMemoryStore();
    if (!key || !memoryStore) {
      logger.warn('No active avatar model to save idle habits for');
      return;
    }
    const saved = normalizeIdleHabits(habits);
    memoryStore.setValue(key, saved);
    logger.info('Avatar idle habits saved', {
      key,
      length: saved.length,
      max: MAX_IDLE_HABITS_LENGTH,
    });
  });

  handle('local-voice:voice-options', (_event, avatarId?: unknown) =>
    speakingVoiceOptions(settingsAvatarArg(avatarId)),
  );
}
