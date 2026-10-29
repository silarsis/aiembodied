/** IPC contract for the local conversation backend (local LLM + services/speech). */

export interface LocalVoiceSttStatus {
  provider?: 'local' | 'openai';
  available: boolean;
  model: string | null;
  /** Set when local STT runs on its own server (Qwen3-ASR on llama-server). */
  url: string | null;
}

export interface LocalVoiceTtsStatus {
  provider: 'kokoro' | 'openai';
  available: boolean;
  ready: boolean;
  model: string | null;
  voice: string | null;
  error: string | null;
}

export interface LocalVoiceStatus {
  llm: { available: boolean; model: string; baseUrl: string; provider?: 'local' | 'openai' };
  stt?: LocalVoiceSttStatus;
  /** The text-to-speech engine in use (Kokoro through services/speech, or OpenAI). */
  tts?: LocalVoiceTtsStatus;
  /** services/speech, reported even when OpenAI does the speech (its voice list feeds Settings). */
  speech: {
    available: boolean;
    ready: boolean;
    sttModel: string | null;
    ttsModel?: string | null;
    voices: string[];
    defaultVoice: string | null;
    error: string | null;
  };
}

export interface LocalVoiceTranscribeResult {
  text: string;
  timings: Record<string, number>;
}

export interface LocalVoiceRespondRequest {
  requestId: string;
  text: string;
  /** System prompt for the turn (the same session instructions the Realtime backend gets). */
  instructions?: string;
}

export interface LocalVoiceRespondResult {
  requestId: string;
  text: string;
  cancelled: boolean;
}

/** Streamed from main to the renderer on `local-voice:event` while a reply is generated. */
export type LocalVoiceEvent =
  /** One spoken sentence: its raw text (avatar tags included) and its audio as 16-bit WAV. */
  | { requestId: string; type: 'sentence'; index: number; text: string; wav: Uint8Array }
  | { requestId: string; type: 'error'; message: string };
