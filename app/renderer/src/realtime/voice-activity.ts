/** Where the assistant is in a conversation turn, for the status indicators. */
export type VoicePhase = 'off' | 'waiting' | 'listening' | 'transcribing' | 'thinking' | 'responding' | 'error';

export interface VoiceActivity {
  phase: VoicePhase;
  /** Extra context, e.g. why speech was ignored or what failed. */
  detail?: string;
  /** When this phase began (ms since epoch). */
  since: number;
}
