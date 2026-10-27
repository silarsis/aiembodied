/** IPC contract for the local conversation backend (local LLM + services/speech). */

export interface LocalVoiceStatus {
  llm: { available: boolean; model: string; baseUrl: string };
  speech: {
    available: boolean;
    ready: boolean;
    sttModel: string | null;
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
