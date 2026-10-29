/**
 * The speech-to-text and text-to-speech engines the conversation pipeline can use: services/speech
 * (Qwen3-ASR or faster-whisper, and Kokoro) or OpenAI (transcriptions API for STT; the Realtime
 * API for TTS, in openai-realtime-tts.ts).
 */
import type { OpenAiAudioClient } from './openai-audio-client.js';
import type { SpeechServiceClient, SpeechServiceHealth } from './speech-service-client.js';
import type { LocalVoiceSttStatus, LocalVoiceTranscribeResult, LocalVoiceTtsStatus } from './types.js';

type CallOptions = { signal?: AbortSignal };

export interface SpeechToTextEngine {
  transcribe(wav: Uint8Array, options?: CallOptions): Promise<LocalVoiceTranscribeResult>;
  /** `speech` is the speech service's health (null when it is down), checked once per status call. */
  status(speech: SpeechServiceHealth | null): Promise<LocalVoiceSttStatus>;
}

export interface TextToSpeechEngine {
  /** Speak `text`; returns a 16-bit PCM WAV. */
  synthesize(text: string, options?: CallOptions): Promise<Uint8Array>;
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

export class KokoroTts implements TextToSpeechEngine {
  /** `voice` empty or unset: the speech service's default. */
  constructor(
    private readonly speech: SpeechServiceClient,
    private readonly voice?: string,
  ) {}

  synthesize(text: string, options?: CallOptions): Promise<Uint8Array> {
    return this.speech.synthesize({ text, voice: this.voice || undefined }, options);
  }

  status(health: SpeechServiceHealth | null): LocalVoiceTtsStatus {
    return {
      provider: 'kokoro',
      available: Boolean(health),
      ready: health?.ready === true,
      model: health?.ttsModel ?? null,
      voice: this.voice || health?.defaultVoice || null,
      error: health?.error ?? null,
    };
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
