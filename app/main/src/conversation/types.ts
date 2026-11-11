export type ConversationRole = 'system' | 'user' | 'assistant';

export interface ConversationSession {
  id: string;
  startedAt: number;
  title: string | null;
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: ConversationRole;
  ts: number;
  content: string;
  audioPath: string | null;
  /** Who said it: an avatar id, or 'user'. Unset for system notes and for messages saved before speakers were recorded. */
  speaker?: string;
}

export interface ConversationSessionWithMessages extends ConversationSession {
  messages: ConversationMessage[];
}

export interface ConversationHistory {
  currentSessionId: string | null;
  sessions: ConversationSessionWithMessages[];
}

export interface ConversationAppendMessagePayload {
  sessionId?: string;
  role: ConversationRole;
  content: string;
  ts?: number;
  audioPath?: string | null;
  id?: string;
  /** An avatar id or 'user'. Defaults to 'user' for user messages, 'echo' for assistant messages, unset for system. */
  speaker?: string;
}
