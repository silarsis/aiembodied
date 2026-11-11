/** The renderer's bridge to the floor settings (who speaks when several avatars share a scene). Types only. */
export interface FloorBridge {
  /** Whether avatar-to-avatar chatter is out loud (otherwise it stays a text back channel). */
  getHearChatter(): Promise<boolean>;
  setHearChatter(enabled: boolean): Promise<boolean>;
}
