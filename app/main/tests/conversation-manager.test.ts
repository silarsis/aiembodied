import { describe, expect, it, vi } from 'vitest';
import { ConversationManager } from '../src/conversation/conversation-manager.js';
import type {
  ConversationMessage,
  ConversationSession,
} from '../src/conversation/types.js';
import type {
  MemoryStore,
  MessageRecord,
  SessionRecord,
  SessionWithMessages,
} from '../src/memory/memory-store.js';

function createStoreDouble() {
  const sessions: SessionRecord[] = [];
  const messages: MessageRecord[] = [];
  const kv = new Map<string, string>();

  const listSessions = ({ limit = 50, offset = 0 } = {}): SessionRecord[] => {
    const sorted = [...sessions].sort((a, b) => {
      if (a.startedAt === b.startedAt) {
        return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
      }
      return b.startedAt - a.startedAt;
    });
    return sorted.slice(offset, offset + limit).map((session) => ({ ...session }));
  };

  const listMessages = (sessionId: string): MessageRecord[] => {
    const relevant = messages.filter((message) => message.sessionId === sessionId);
    return [...relevant]
      .sort((a, b) => {
        if (a.ts === b.ts) {
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        }
        return a.ts - b.ts;
      })
      .map((message) => ({ ...message }));
  };

  const store: MemoryStore = {
    createSession: (session) => {
      sessions.push({ ...session });
    },
    updateSessionTitle: () => {},
    deleteSession: (sessionId) => {
      const index = sessions.findIndex((session) => session.id === sessionId);
      if (index >= 0) {
        sessions.splice(index, 1);
      }
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.sessionId === sessionId) {
          messages.splice(i, 1);
        }
      }
    },
    listSessions,
    getSessionWithMessages: (sessionId) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        return null;
      }

      return {
        id: session.id,
        startedAt: session.startedAt,
        title: session.title,
        messages: listMessages(sessionId),
      } satisfies SessionWithMessages;
    },
    listMessages,
    appendMessage: (message) => {
      messages.push({ ...message });
    },
    deleteMessages: (ids) => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (ids.includes(messages[i]?.id)) {
          messages.splice(i, 1);
        }
      }
    },
    setValue: (key, value) => {
      kv.set(key, value);
    },
    getValue: (key) => kv.get(key) ?? null,
    deleteValue: (key) => {
      kv.delete(key);
    },
    exportData: () => ({ sessions: [], messages: [], kv: {} }),
    importData: () => {},
    dispose: () => {},
  };

  return { store, state: { sessions, messages, kv } };
}

describe('ConversationManager', () => {
  it('creates sessions, tracks current session, and emits start events', () => {
    const { store, state } = createStoreDouble();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = new ConversationManager({ store, logger, maxSessions: 5, maxMessagesPerSession: 5 });

    const started: ConversationSession[] = [];
    manager.on('session-started', (session) => {
      started.push(session);
    });

    const session = manager.startSession({ startedAt: 1_700_000_000_000 });
    expect(session.id).toBeDefined();
    expect(started).toHaveLength(1);
    expect(started[0]?.id).toBe(session.id);
    expect(manager.getCurrentSessionId()).toBe(session.id);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.id).toBe(session.id);
  });

  it('appends messages, enforces per-session retention, and emits append events', () => {
    const { store, state } = createStoreDouble();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = new ConversationManager({ store, logger, maxSessions: 5, maxMessagesPerSession: 2 });

    const session = manager.startSession({ id: 'session-1', startedAt: 1_700_000_000_000 });
    const appended: ConversationMessage[] = [];
    manager.on('message-appended', (message) => {
      appended.push(message);
    });

    manager.appendMessage({ sessionId: session.id, role: 'system', content: 'First', ts: 1 });
    manager.appendMessage({ sessionId: session.id, role: 'system', content: 'Second', ts: 2 });
    manager.appendMessage({ sessionId: session.id, role: 'system', content: 'Third', ts: 3 });

    const storedMessages = state.messages.filter((message) => message.sessionId === session.id);
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages.map((message) => message.content)).toEqual(['Second', 'Third']);
    expect(appended).toHaveLength(3);
  });

  it('prunes the oldest sessions while keeping the active conversation', () => {
    const { store, state } = createStoreDouble();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = new ConversationManager({ store, logger, maxSessions: 2, maxMessagesPerSession: 10 });

    const first = manager.startSession({ id: 'session-oldest', startedAt: 1_000 });
    manager.startSession({ id: 'session-middle', startedAt: 2_000 });
    manager.startSession({ id: 'session-newest', startedAt: 3_000 });

    const remainingIds = state.sessions.map((session) => session.id);
    expect(remainingIds).toContain('session-newest');
    expect(remainingIds).toContain('session-middle');
    expect(remainingIds).not.toContain(first.id);
  });

  it('throws when appending without an active session', () => {
    const { store } = createStoreDouble();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = new ConversationManager({ store, logger, maxSessions: 5, maxMessagesPerSession: 5 });

    expect(() => manager.appendMessage({ role: 'system', content: 'orphan message' })).toThrow();
  });
});

