/** IPC contract for the local conversation backend (local LLM + services/speech). */

export interface LocalVoiceSttStatus {
  provider?: 'local' | 'openai';
  available: boolean;
  model: string | null;
  /** Set when local STT runs on its own server (Qwen3-ASR on llama-server). */
  url: string | null;
}

export interface LocalVoiceTtsStatus {
  provider: 'kokoro' | 'kitten' | 'piper' | 'openai';
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
  /** The avatar that answers (default 'echo'): its own history, notes and voice. */
  avatarId?: string;
  text: string;
  /** System prompt for the turn (the same session instructions the Realtime backend gets). */
  instructions?: string;
  /**
   * A one-off sample of the voice (Character → Test Response): no tools, no long-term memory, and
   * it neither sees nor joins the conversation history.
   */
  preview?: boolean;
  /**
   * A system-initiated turn: `text` is ignored and the turn answers the updates queued with
   * LocalVoiceService.notify() (for example from the coding agent). Nothing is said as Kevin.
   */
  system?: boolean;
  /**
   * Run the whole turn (LLM, history, memory, tools) without speech: no text-to-speech call is made
   * and 'sentence' events carry an empty `wav`. Used for back-channel talk between avatars.
   */
  silent?: boolean;
}

export interface LocalVoiceRespondResult {
  requestId: string;
  text: string;
  cancelled: boolean;
  /** For a system turn: the note the model was given, so the conversation record can keep it, marked. */
  note?: string;
}

/** Updates for Echo waiting to be spoken (see LocalVoiceService.notify). */
export interface LocalVoiceSystemStatus {
  /** How many updates are queued. */
  pending: number;
  /** A system turn may run now (the coalescing wait and the rate limit have passed). */
  ready: boolean;
  /** The queued updates, for the status panel. */
  texts: string[];
  /** At least one queued update is urgent (a question): it is announced even when no conversation is running. */
  urgent: boolean;
}

/** Streamed from main to the renderer on `local-voice:event` while a reply is generated. */
export type LocalVoiceEvent = (
  /** One spoken sentence: its raw text (avatar tags included) and its audio as 16-bit WAV. */
  | { requestId: string; type: 'sentence'; index: number; text: string; wav: Uint8Array }
  | { requestId: string; type: 'error'; message: string }
  /** A tool call the model made: sent as it starts, and again when it finishes. */
  | {
      requestId: string;
      type: 'tool';
      callId: string;
      name: string;
      label: string;
      status: 'started' | 'done' | 'failed';
      detail?: string;
    }
) & {
  /** The avatar the event is for; absent for Echo. */
  avatarId?: string;
};

/** The voices a character can pick for the engine that speaks now (Character → Voice). */
export interface SpeakingVoiceOptions {
  /** What the choice is saved for; null when nothing speaks. */
  engine: 'kokoro' | 'kitten' | 'piper' | 'openai' | null;
  label: string;
  voices: string[];
  /** What speaks when the character hasn't picked one (Models and servers → Speaking). */
  defaultVoice: string | null;
  /** The character's own pick for this engine, if any. */
  selected: string | null;
}
