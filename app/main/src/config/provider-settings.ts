/**
 * Which provider runs each part of the assistant: the language model, speech-to-text,
 * text-to-speech and motion. Every part has a local option (the services that run on this
 * machine) and an OpenAI one, which needs the OpenAI API key.
 *
 * Settings resolve in three layers: built-in defaults, then environment variables, then what
 * the user saved on the Settings page. Only the fields the user changed are saved, so an env var
 * still applies to everything they left alone.
 */

export type LlmProvider = 'local' | 'openai';
export type SttProvider = 'local' | 'openai';
export type TtsProvider = 'kokoro' | 'openai';
export type MotionProvider = 'local' | 'openai';
export type LocalMotionBackend = 'ardy' | 'kimodo';

export interface ProviderSettings {
  llm: {
    provider: LlmProvider;
    /** OpenAI-compatible chat endpoint (llama-server), e.g. http://127.0.0.1:1234/v1. */
    localBaseUrl: string;
    localModel: string;
    openaiModel: string;
  };
  stt: {
    /** local: services/speech (Qwen3-ASR or faster-whisper, whichever it was started with). */
    provider: SttProvider;
    openaiModel: string;
  };
  tts: {
    provider: TtsProvider;
    /** Kokoro voice; empty means the speech service's default. */
    kokoroVoice: string;
    /** A Realtime API model: the /v1/audio/speech models shut down on 2027-01-06. */
    openaiModel: string;
    openaiVoice: string;
    /** Speaking style (tone, accent, pace), added to the Realtime model's instructions. */
    openaiInstructions: string;
  };
  motion: {
    /** local: services/motion streams motion live; openai: keyframe clips from an OpenAI model. */
    provider: MotionProvider;
    localServiceUrl: string;
    /** Which model the dev launcher starts services/motion with (takes effect when it restarts). */
    localBackend: LocalMotionBackend;
    openaiModel: string;
  };
  /** services/speech, used by local STT and Kokoro TTS. */
  speechServiceUrl: string;
}

export type ProviderSettingsPatch = {
  [Section in keyof ProviderSettings]?: ProviderSettings[Section] extends object
    ? Partial<ProviderSettings[Section]>
    : ProviderSettings[Section];
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  llm: {
    provider: 'local',
    // The llama-server slopcore runs Qwen Flash-Next on (see scripts/start-local-llm.ps1).
    localBaseUrl: 'http://127.0.0.1:1234/v1',
    localModel: 'qwen-next-flash',
    openaiModel: 'gpt-4.1-mini',
  },
  stt: {
    provider: 'local',
    openaiModel: 'gpt-4o-mini-transcribe',
  },
  tts: {
    provider: 'kokoro',
    kokoroVoice: '',
    openaiModel: 'gpt-realtime-2.1-mini',
    openaiVoice: 'alloy',
    openaiInstructions: '',
  },
  motion: {
    provider: 'local',
    localServiceUrl: 'http://127.0.0.1:8190',
    localBackend: 'ardy',
    openaiModel: 'gpt-4.1-mini',
  },
  speechServiceUrl: 'http://127.0.0.1:8192',
};

type Env = Record<string, string | undefined>;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Like text(), but keeps an empty string: it means "use the default" for optional fields. */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  return options.find((option) => option === raw);
}

function compact<T extends object>(value: T): Partial<T> | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as Partial<T>) : undefined;
}

/** Keep only the recognised, well-formed fields of a saved or submitted patch. */
export function sanitizeProviderPatch(input: unknown): ProviderSettingsPatch {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {};
  }
  const raw = input as Record<string, Record<string, unknown> | undefined>;
  const section = (name: string): Record<string, unknown> => {
    const value = raw[name];
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  };
  const llm = section('llm');
  const stt = section('stt');
  const tts = section('tts');
  const motion = section('motion');

  const patch: ProviderSettingsPatch = {
    llm: compact({
      provider: oneOf(llm.provider, ['local', 'openai'] as const),
      localBaseUrl: text(llm.localBaseUrl),
      localModel: text(llm.localModel),
      openaiModel: text(llm.openaiModel),
    }),
    stt: compact({
      provider: oneOf(stt.provider, ['local', 'openai'] as const),
      openaiModel: text(stt.openaiModel),
    }),
    tts: compact({
      provider: oneOf(tts.provider, ['kokoro', 'openai'] as const),
      kokoroVoice: optionalText(tts.kokoroVoice),
      openaiModel: text(tts.openaiModel),
      openaiVoice: text(tts.openaiVoice),
      openaiInstructions: optionalText(tts.openaiInstructions),
    }),
    motion: compact({
      provider: oneOf(motion.provider, ['local', 'openai'] as const),
      localServiceUrl: text(motion.localServiceUrl),
      localBackend: oneOf(motion.localBackend, ['ardy', 'kimodo'] as const),
      openaiModel: text(motion.openaiModel),
    }),
    speechServiceUrl: text(raw.speechServiceUrl),
  };
  return compact(patch) ?? {};
}

/** Merge `patch` over `base`, section by section. */
export function mergeProviderPatch<T extends ProviderSettingsPatch>(base: T, patch: ProviderSettingsPatch): T {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const current = merged[key];
    merged[key] =
      typeof value === 'object' && typeof current === 'object' && current !== null ? { ...current, ...value } : value;
  }
  return merged as T;
}

/** The settings environment variables give, before anything the user saved. */
export function providerPatchFromEnv(env: Env): ProviderSettingsPatch {
  return sanitizeProviderPatch({
    llm: {
      provider: env.LLM_PROVIDER,
      localBaseUrl: env.LOCAL_LLM_BASE_URL,
      localModel: env.LOCAL_LLM_MODEL,
      openaiModel: env.OPENAI_LLM_MODEL,
    },
    stt: { provider: env.STT_PROVIDER, openaiModel: env.OPENAI_STT_MODEL },
    tts: {
      provider: env.TTS_PROVIDER,
      kokoroVoice: text(env.LOCAL_TTS_VOICE),
      openaiModel: env.OPENAI_TTS_MODEL,
      openaiVoice: env.OPENAI_TTS_VOICE,
      openaiInstructions: text(env.OPENAI_TTS_INSTRUCTIONS),
    },
    motion: {
      provider: env.MOTION_PROVIDER,
      localServiceUrl: env.MOTION_SERVICE_URL,
      localBackend: env.MOTION_BACKEND,
      openaiModel: env.OPENAI_MOTION_MODEL,
    },
    speechServiceUrl: env.SPEECH_SERVICE_URL,
  });
}

export function resolveProviderSettings(env: Env, saved: ProviderSettingsPatch = {}): ProviderSettings {
  return mergeProviderPatch(mergeProviderPatch(DEFAULT_PROVIDER_SETTINGS, providerPatchFromEnv(env)), saved);
}

/** One short label per part ("openai:gpt-4.1-mini"), for logging. */
export function describeProviders(settings: ProviderSettings): Record<string, string> {
  return {
    llm: settings.llm.provider === 'openai' ? `openai:${settings.llm.openaiModel}` : `local:${settings.llm.localModel}`,
    stt: settings.stt.provider === 'openai' ? `openai:${settings.stt.openaiModel}` : 'local',
    tts:
      settings.tts.provider === 'openai'
        ? `openai:${settings.tts.openaiModel}/${settings.tts.openaiVoice}`
        : `kokoro:${settings.tts.kokoroVoice || 'default'}`,
    motion: settings.motion.provider === 'openai' ? `openai:${settings.motion.openaiModel}` : `local:${settings.motion.localBackend}`,
  };
}
