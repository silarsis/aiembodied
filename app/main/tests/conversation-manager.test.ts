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

  describe('appendToRecentSession', () => {
    const MIN = 60_000;

    it('reuses the current session when its newest message is recent', () => {
      const { store, state } = createStoreDouble();
      const manager = new ConversationManager({ store });
      const now = Date.now();
      const session = manager.startSession({ startedAt: now - 2 * 60 * MIN });
      manager.appendMessage({ sessionId: session.id, role: 'user', content: 'hi', ts: now - 5 * MIN });

      const started = vi.fn();
      manager.on('session-started', started);
      const added = manager.appendToRecentSession([
        { role: 'system', content: 'note', ts: now },
        { role: 'assistant', content: 'reply', ts: now },
      ]);

      expect(started).not.toHaveBeenCalled();
      expect(state.sessions).toHaveLength(1);
      expect(added.map((m) => [m.role, m.content, m.sessionId])).toEqual([
        ['system', 'note', session.id],
        ['assistant', 'reply', session.id],
      ]);
    });

    it('starts a new session when the current one has been idle too long', () => {
      const { store, state } = createStoreDouble();
      const manager = new ConversationManager({ store });
      const now = Date.now();
      const old = manager.startSession({ startedAt: now - 3 * 60 * MIN });
      manager.appendMessage({ sessionId: old.id, role: 'user', content: 'hi', ts: now - 31 * MIN });

      const started = vi.fn();
      manager.on('session-started', started);
      const added = manager.appendToRecentSession([{ role: 'system', content: 'note' }]);

      expect(started).toHaveBeenCalledTimes(1);
      expect(state.sessions).toHaveLength(2);
      expect(added[0]?.sessionId).not.toBe(old.id);
      expect(manager.getCurrentSessionId()).toBe(added[0]?.sessionId);
    });

    it('uses the start time of an empty session, and starts one when none exists', () => {
      const { store, state } = createStoreDouble();
      const manager = new ConversationManager({ store });
      const first = manager.appendToRecentSession([{ role: 'system', content: 'a' }]);
      expect(state.sessions).toHaveLength(1);

      const empty = manager.startSession({ startedAt: Date.now() - 40 * MIN });
      const second = manager.appendToRecentSession([{ role: 'system', content: 'b' }]);
      expect(second[0]?.sessionId).not.toBe(empty.id);
      expect(second[0]?.sessionId).not.toBe(first[0]?.sessionId);
      expect(manager.appendToRecentSession([{ role: 'system', content: 'c' }], 60 * MIN)).toHaveLength(1);
    });
  });
});

describe('ConversationManager speakers', () => {
  it('defaults the speaker by role, keeps an explicit one, and reports it in events and history', () => {
    const { store } = createStoreDouble();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = new ConversationManager({ store, logger });
    manager.startSession({ id: 's1', startedAt: 1 });
    const events: ConversationMessage[] = [];
    manager.on('message-appended', (message) => events.push(message));

    const user = manager.appendMessage({ role: 'user', content: 'hi', ts: 1 });
    const assistant = manager.appendMessage({ role: 'assistant', content: 'hello', ts: 2 });
    const other = manager.appendMessage({ role: 'assistant', content: 'hey', ts: 3, speaker: 'sage' });
    const system = manager.appendMessage({ role: 'system', content: 'note', ts: 4 });

    expect([user.speaker, assistant.speaker, other.speaker, system.speaker]).toEqual(['user', 'echo', 'sage', undefined]);
    expect(events.map((m) => m.speaker)).toEqual(['user', 'echo', 'sage', undefined]);
    const history = manager.getHistory();
    expect(history.sessions[0]?.messages.map((m) => m.speaker)).toEqual(['user', 'echo', 'sage', undefined]);
  });
});
