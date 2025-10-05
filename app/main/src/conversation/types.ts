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
}
