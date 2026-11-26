// Types only: shared/ holds what the main process and the renderer both need.


/** One model of a speech-service TTS engine (GET /v1/tts/engines). */
export interface SpeechTtsModel {
  id: string;
  label: string;
  installed: boolean;
  sizeMb?: number;
  voices: string[];
  defaultVoice: string | null;
  download: { status: 'downloading' | 'done' | 'error'; received: number; total: number; error: string | null } | null;
}


export interface SpeechTtsEngine {
  id: string;
  label: string;
  available: boolean;
  error: string | null;
  models: SpeechTtsModel[];
}
