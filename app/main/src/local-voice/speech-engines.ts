/**
 * The speech-to-text and text-to-speech engines the conversation pipeline can use: services/speech
 * (Qwen3-ASR or faster-whisper, and Kokoro) or OpenAI (transcriptions API for STT; the Realtime
 * API for TTS, in openai-realtime-tts.ts).
 */
import type { OpenAiAudioClient } from './openai-audio-client.js';
import type { SpeechServiceClient, SpeechServiceHealth } from './speech-service-client.js';
import type { LocalVoiceSttStatus, LocalVoiceTranscribeResult, LocalVoiceTtsStatus } from './types.js';

type CallOptions = { signal?: AbortSignal };
/** `voice`: the character's own voice for this engine, used instead of the engine's default. */
export type SpeakOptions = CallOptions & { voice?: string };

export interface SpeechToTextEngine {
  transcribe(wav: Uint8Array, options?: CallOptions): Promise<LocalVoiceTranscribeResult>;
  /** `speech` is the speech service's health (null when it is down), checked once per status call. */
  status(speech: SpeechServiceHealth | null): Promise<LocalVoiceSttStatus>;
}

export interface TextToSpeechEngine {
  /** Speak `text`; returns a 16-bit PCM WAV. */
  synthesize(text: string, options?: SpeakOptions): Promise<Uint8Array>;
  status(speech: SpeechServiceHealth | null): LocalVoiceTtsStatus;
  /** Release a held connection; called when settings swap the engine out. */
  close?(): void;
}

export class SpeechServiceStt implements SpeechToTextEngine {
  constructor(private readonly speech: SpeechServiceClient) {}

  transcribe(wav: Uint8Array, options?: CallOptions): Promise<LocalVoiceTranscribeResult> {
    return this.speech.transcribe(wav, options);
  }

  async status(health: SpeechServiceHealth | null): Promise<LocalVoiceSttStatus> {
    // The speech service reports ready even when its separate STT server is down, so ask that too.
    const url = health?.sttUrl ?? null;
    const available = url ? await this.speech.isSttServerUp(url) : health?.ready === true;
    return { provider: 'local', available, model: health?.sttModel ?? null, url };
  }
}

/**
 * Speaking through services/speech: Kokoro (the engine it starts with), Kitten or Piper. A voice
 * the engine doesn't know (a character's choice from before a model was removed, say) is dropped
 * and the engine's default voice speaks instead.
 */
export class SpeechServiceTts implements TextToSpeechEngine {
  constructor(
    private readonly speech: SpeechServiceClient,
    private readonly target: { engine: 'kokoro' | 'kitten' | 'piper'; model?: string; voice?: string },
  ) {}

  get engine(): 'kokoro' | 'kitten' | 'piper' {
    return this.target.engine;
  }

  async synthesize(text: string, options?: SpeakOptions): Promise<Uint8Array> {
    const { engine, model } = this.target;
    const voice = options?.voice || this.target.voice || undefined;
    const request = { text, voice, ...(engine === 'kokoro' ? {} : { engine, ...(model ? { model } : {}) }) };
    try {
      return await this.speech.synthesize(request, { signal: options?.signal });
    } catch (error) {
      if (voice && voice !== this.target.voice && error instanceof Error && /unknown voice/i.test(error.message)) {
        return this.speech.synthesize({ ...request, voice: this.target.voice || undefined }, { signal: options?.signal });
      }
      throw error;
    }
  }

  status(health: SpeechServiceHealth | null): LocalVoiceTtsStatus {
    return {
      provider: this.target.engine,
      available: Boolean(health),
      ready: health?.ready === true,
      model: this.target.engine === 'kokoro' ? health?.ttsModel ?? null : this.target.model ?? this.target.engine,
      voice: this.target.voice || (this.target.engine === 'kokoro' ? health?.defaultVoice : null) || null,
      error: health?.error ?? null,
    };
  }
}

/** Kokoro through services/speech, with `voice` (empty: the service's default). */
export class KokoroTts extends SpeechServiceTts {
  constructor(speech: SpeechServiceClient, voice?: string) {
    super(speech, { engine: 'kokoro', voice });
  }
}

export class OpenAiStt implements SpeechToTextEngine {
  constructor(
    private readonly client: OpenAiAudioClient,
    private readonly model: string,
  ) {}

  transcribe(wav: Uint8Array, options?: CallOptions): Promise<LocalVoiceTranscribeResult> {
    return this.client.transcribe(wav, { model: this.model }, options);
  }

  async status(): Promise<LocalVoiceSttStatus> {
    return { provider: 'openai', available: this.client.hasApiKey, model: this.model, url: null };
  }
}
