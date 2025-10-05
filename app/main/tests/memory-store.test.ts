import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, type MemoryStoreExport } from '../src/memory/memory-store.js';

const tempDirs: string[] = [];
const stores: MemoryStore[] = [];

async function createStore(): Promise<MemoryStore> {
  const directory = await mkdtemp(path.join(tmpdir(), 'memory-store-'));
  tempDirs.push(directory);
  const filePath = path.join(directory, 'memory.db');
  const store = new MemoryStore({ filePath });
  stores.push(store);
  return store;
}

async function cleanup() {
  while (stores.length > 0) {
    const store = stores.pop();
    store?.dispose();
  }

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

afterEach(async () => {
  await cleanup();
});

describe('MemoryStore', () => {
  it('runs migrations and persists sessions and messages', async () => {
    const store = await createStore();
    const startedAt = Date.now();

    store.createSession({ id: 'session-1', startedAt, title: 'First Session' });
    store.appendMessage({
      id: 'message-1',
      sessionId: 'session-1',
      role: 'user',
      ts: startedAt + 10,
      content: 'Hello there!',
      audioPath: null,
    });
    store.appendMessage({
      id: 'message-2',
      sessionId: 'session-1',
      role: 'assistant',
      ts: startedAt + 20,
      content: 'Hi! How can I help you?',
      audioPath: '   ',
    });

    const listing = store.listSessions();
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatchObject({ id: 'session-1', startedAt, title: 'First Session' });

    const loaded = store.getSessionWithMessages('session-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[1]).toMatchObject({
      id: 'message-2',
      audioPath: null,
    });
  });

  it('updates session titles and orders sessions by recency', async () => {
    const store = await createStore();
    const base = Date.now();

    store.createSession({ id: 'session-older', startedAt: base - 1_000, title: 'Older' });
    store.createSession({ id: 'session-newer', startedAt: base, title: 'Newer' });

    store.updateSessionTitle('session-older', '  ');
    store.updateSessionTitle('session-newer', 'Updated Title');

    const sessions = store.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(['session-newer', 'session-older']);
    expect(sessions[1].title).toBeNull();

    const older = store.getSessionWithMessages('session-older');
    expect(older?.title).toBeNull();
  });

  it('supports key-value storage and deletion', async () => {
    const store = await createStore();

    expect(store.getValue('missing')).toBeNull();

    store.setValue('last-session', 'session-123');
    expect(store.getValue('last-session')).toBe('session-123');

    store.setValue('last-session', 'session-456');
    expect(store.getValue('last-session')).toBe('session-456');

    store.deleteValue('last-session');
    expect(store.getValue('last-session')).toBeNull();
  });

  it('exports and imports data using replace and merge strategies', async () => {
    const original = await createStore();
    const startedAt = Date.now();
    original.createSession({ id: 'session-1', startedAt, title: 'History' });
    original.appendMessage({
      id: 'message-1',
      sessionId: 'session-1',
      role: 'user',
      ts: startedAt + 1,
      content: 'Ping',
      audioPath: null,
    });
    original.setValue('lastSessionId', 'session-1');

    const exported = original.exportData();

    const replacement = await createStore();
    replacement.createSession({ id: 'session-old', startedAt: startedAt - 100, title: 'Old' });
    replacement.setValue('lastSessionId', 'session-old');

    replacement.importData(exported, { strategy: 'replace' });
    expect(replacement.listSessions()).toHaveLength(1);
    expect(replacement.getValue('lastSessionId')).toBe('session-1');

    const mergeTarget = await createStore();
    mergeTarget.createSession({ id: 'session-2', startedAt: startedAt + 500, title: 'Keep me' });

    const mergeData: MemoryStoreExport = {
      ...exported,
      sessions: [...exported.sessions, { id: 'session-2', startedAt: startedAt + 500, title: 'Keep me' }],
      messages: exported.messages,
      kv: exported.kv,
    };

    mergeTarget.importData(mergeData, { strategy: 'merge' });

    const mergedSessions = mergeTarget.listSessions();
    expect(mergedSessions).toHaveLength(2);
    expect(mergedSessions.map((session) => session.id)).toContain('session-1');
    expect(mergedSessions.map((session) => session.id)).toContain('session-2');
  });
});
