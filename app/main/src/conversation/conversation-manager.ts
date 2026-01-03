import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  ConversationAppendMessagePayload,
  ConversationHistory,
  ConversationMessage,
  ConversationRole,
  ConversationSession,
  ConversationSessionWithMessages,
} from './types.js';
import type { MemoryStore, MessageRecord, SessionRecord } from '../memory/index.js';

type ConversationEventMap = {
  'session-started': (session: ConversationSession) => void;
  'message-appended': (message: ConversationMessage) => void;
};

export interface ConversationManagerOptions {
  store: MemoryStore;
  logger?: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
  maxSessions?: number;
  maxMessagesPerSession?: number;
}

const CURRENT_SESSION_KEY = 'conversation:currentSessionId';
const LAST_SESSION_KEY = 'conversation:lastSessionId';

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_MAX_MESSAGES_PER_SESSION = 200;

function sortSessionsDescending<T extends SessionRecord>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    if (a.startedAt === b.startedAt) {
      return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
    }
    return b.startedAt - a.startedAt;
  });
}

function sortMessagesAscending(messages: MessageRecord[]): MessageRecord[] {
  return [...messages].sort((a, b) => {
    if (a.ts === b.ts) {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    return a.ts - b.ts;
  });
}

function toConversationRole(role: string): ConversationRole {
  if (role === 'system' || role === 'user' || role === 'assistant') {
    return role;
  }
  // Default to 'assistant' for unknown roles
  return 'assistant';
}

export class ConversationManager extends EventEmitter {
  private readonly store: MemoryStore;

  private readonly logger?: ConversationManagerOptions['logger'];

  private readonly maxSessions: number;

  private readonly maxMessagesPerSession: number;

  private currentSessionId: string | null = null;

  constructor(options: ConversationManagerOptions) {
    super();
    this.store = options.store;
    this.logger = options.logger;
    this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.maxMessagesPerSession = Math.max(1, options.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES_PER_SESSION);

    this.initializeCurrentSession();
    this.pruneSessions();
  }

  override on<U extends keyof ConversationEventMap>(event: U, listener: ConversationEventMap[U]): this {
    return super.on(event, listener);
  }

  override once<U extends keyof ConversationEventMap>(event: U, listener: ConversationEventMap[U]): this {
    return super.once(event, listener);
  }

  override off<U extends keyof ConversationEventMap>(event: U, listener: ConversationEventMap[U]): this {
    return super.off(event, listener);
  }

  override emit<U extends keyof ConversationEventMap>(
    event: U,
    ...args: Parameters<ConversationEventMap[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getHistory(limit = this.maxSessions): ConversationHistory {
    const sessions = this.store.listSessions({ limit });
    const hydrated: ConversationSessionWithMessages[] = [];

    for (const session of sessions) {
      const loaded = this.store.getSessionWithMessages(session.id);
      if (!loaded) {
        continue;
      }

      hydrated.push({
        id: loaded.id,
        startedAt: loaded.startedAt,
        title: loaded.title,
        messages: loaded.messages.map((message) => ({
          id: message.id,
          sessionId: message.sessionId,
          role: toConversationRole(message.role),
          ts: message.ts,
          content: message.content,
          audioPath: message.audioPath,
        })),
      });
    }

    return {
      currentSessionId: this.currentSessionId,
      sessions: hydrated,
    };
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  startSession({
    id = randomUUID(),
    startedAt = Date.now(),
    title = null,
  }: Partial<Omit<ConversationSession, 'startedAt'>> & { startedAt?: number } = {}): ConversationSession {
    const session: SessionRecord = {
      id,
      startedAt,
      title,
    };

    this.store.createSession(session);
    this.currentSessionId = session.id;
    this.store.setValue(CURRENT_SESSION_KEY, session.id);
    this.store.setValue(LAST_SESSION_KEY, session.id);
    this.emit('session-started', { id: session.id, startedAt: session.startedAt, title: session.title });

    this.pruneSessions();

    return { id: session.id, startedAt: session.startedAt, title: session.title };
  }

  appendMessage(payload: ConversationAppendMessagePayload): ConversationMessage {
    const sessionId = payload.sessionId ?? this.currentSessionId;
    if (!sessionId) {
      throw new Error('Cannot append conversation message without an active session.');
    }

    const message: MessageRecord = {
      id: payload.id ?? randomUUID(),
      sessionId,
      role: payload.role,
      ts: payload.ts ?? Date.now(),
      content: payload.content,
      audioPath: payload.audioPath ?? null,
    };

    this.store.appendMessage(message);
    this.pruneMessages(sessionId);
    this.emit('message-appended', {
      id: message.id,
      sessionId: message.sessionId,
      role: toConversationRole(message.role),
      ts: message.ts,
      content: message.content,
      audioPath: message.audioPath,
    });

    return {
      id: message.id,
      sessionId: message.sessionId,
      role: toConversationRole(message.role),
      ts: message.ts,
      content: message.content,
      audioPath: message.audioPath,
    };
  }

  private initializeCurrentSession() {
    const storedId = this.store.getValue(CURRENT_SESSION_KEY);
    if (!storedId) {
      this.currentSessionId = null;
      return;
    }

    const existing = this.store.getSessionWithMessages(storedId);
    if (!existing) {
      this.store.deleteValue?.(CURRENT_SESSION_KEY);
      this.currentSessionId = null;
      return;
    }

    this.currentSessionId = existing.id;
  }

  private pruneSessions() {
    const sessions = sortSessionsDescending(this.store.listSessions({ limit: Number.MAX_SAFE_INTEGER }));
    if (sessions.length <= this.maxSessions) {
      return;
    }

    const keepIds = new Set<string>();
    if (this.currentSessionId) {
      keepIds.add(this.currentSessionId);
    }

    for (const session of sessions) {
      keepIds.add(session.id);
      if (keepIds.size >= this.maxSessions) {
        break;
      }
    }

    for (const session of sessions) {
      if (keepIds.has(session.id)) {
        continue;
      }
      this.store.deleteSession(session.id);
      this.logger?.info?.('Pruned archived conversation session', { sessionId: session.id });
    }
  }

  private pruneMessages(sessionId: string) {
    const messages = sortMessagesAscending(this.store.listMessages(sessionId));
    if (messages.length <= this.maxMessagesPerSession) {
      return;
    }

    const excess = messages.length - this.maxMessagesPerSession;
    const toRemove = messages.slice(0, excess).map((message) => message.id);
    if (toRemove.length === 0) {
      return;
    }

    this.store.deleteMessages(toRemove);
    this.logger?.info?.('Pruned archived conversation messages', {
      sessionId,
      removedCount: toRemove.length,
    });
  }
}

