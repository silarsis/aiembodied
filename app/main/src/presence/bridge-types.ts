/** The renderer's bridge to presence (Echo's picture of whether Kevin is around). Types only. */
export interface PresenceUpdatePayload {
  listening?: boolean;
  voicePhase?: 'off' | 'waiting' | 'listening' | 'transcribing' | 'thinking' | 'responding' | 'error';
  /** ms since epoch of the latest camera sighting of a face. */
  faceSeenAt?: number;
}

export interface PresenceBridge {
  update(payload: PresenceUpdatePayload): Promise<boolean>;
  getDoNotDisturb(): Promise<boolean>;
  setDoNotDisturb(enabled: boolean): Promise<boolean>;
}
