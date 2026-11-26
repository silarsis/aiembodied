export interface PushToTalkStatus {
  /** The accelerator asked for; empty when push-to-talk is off. */
  shortcut: string;
  registered: boolean;
  /** Why the key could not be registered (usually another app already holds it). */
  error?: string;
}

/** The push-to-talk key was pressed (sent from the main process). */
export interface TalkTriggerEvent {
  source: 'shortcut';
  timestamp: number;
}
