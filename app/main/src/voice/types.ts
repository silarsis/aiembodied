/** Shared between main, preload and renderer for the local voice chain (STT -> LLM -> TTS). */

export interface LocalVoiceStatus {
  backend: 'local' | 'openai';
  llm: { available: boolean; model: string | null; baseUrl: string };
  speech: { available: boolean; ready: boolean; stt: string | null; tts: string | null };
}

export interface LocalVoiceTurnRequest {
  turnId: string;
  /** 16-bit little-endian mono PCM at 16 kHz. */
  audio: Uint8Array;
  /** System prompt for the LLM (the session instructions, including avatar tag rules). */
  instructions?: string;
}

export interface LocalVoiceTimings {
  sttMs?: number;
  firstTokenMs?: number;
  firstAudioMs?: number;
  totalMs: number;
}

export type LocalVoiceEvent =
  | { turnId: string; type: 'transcript'; text: string }
  /** A finished piece of the reply (a sentence, or a run of avatar tags), raw text including tags. */
  | { turnId: string; type: 'text'; text: string }
  /** 16-bit little-endian mono PCM for one spoken sentence, in reply order. */
  | { turnId: string; type: 'audio'; index: number; sampleRate: number; data: Uint8Array };

export interface LocalVoiceTurnResult {
  turnId: string;
  transcript: string;
  text: string;
  /** True when the turn was cut short (barge-in or a newer turn). */
  cancelled: boolean;
  timings: LocalVoiceTimings;
}
