import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationManager } from '../src/conversation/conversation-manager.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import {
  IMPORTED_KEY,
  MemoryCapture,
  MemoryEngineClient,
  MemoryEngineError,
  MemoryOutbox,
  memoryEngineSettings,
  setupMemoryEngine,
  type MemoryEngineMessage,
  type OutboxItem,
} from '../src/memory-engine/index.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function createStore(): Promise<MemoryStore> {
  const directory = await mkdtemp(path.join(tmpdir(), 'memory-engine-'));
  const store = new MemoryStore({ filePath: path.join(directory, 'memory.db') });
  cleanups.push(async () => {
    store.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

/** A stand-in for services/memory: records what it was sent, or fails while `down` is set. */
function fakeEngine() {
  const state = {
    down: false,
    sessions: new Map<string, Record<string, unknown>>(),
    messages: new Map<string, MemoryEngineMessage>(),
    calls: [] as string[],
  };
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    state.calls.push(`${init?.method ?? 'GET'} ${pathname}`);
    if (state.down) {
      throw new TypeError('fetch failed');
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.method === 'PUT' && pathname.startsWith('/v1/sessions/')) {
      state.sessions.set(pathname.split('/').pop() as string, body);
      return new Response(JSON.stringify({ id: pathname.split('/').pop() }), { status: 200 });
    }
    if (init?.method === 'POST' && pathname === '/v1/messages') {
      let inserted = 0;
      for (const message of body.messages as MemoryEngineMessage[]) {
        if (!state.messages.has(message.id)) {
          state.messages.set(message.id, message);
          inserted += 1;
        }
      }
      return new Response(JSON.stringify({ inserted, duplicates: (body.messages as unknown[]).length - inserted }));
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
  return { state, fetchFn: fetchFn as unknown as typeof fetch };
}

const quiet = { info: () => {}, warn: () => {} };

describe('memory engine settings', () => {
  it('is on by default at 127.0.0.1:8194 and can be turned off', () => {
    expect(memoryEngineSettings({})).toEqual({
      enabled: true,
      brief: true,
      autoRecall: true,
      url: 'http://127.0.0.1:8194',
      apiToken: undefined,
    });
    expect(memoryEngineSettings({ MEMORY_ENABLED: '0' }).enabled).toBe(false);
    expect(memoryEngineSettings({ MEMORY_BRIEF: 'off', MEMORY_AUTO_RECALL: 'false' })).toMatchObject({
      brief: false,
      autoRecall: false,
    });
    expect(memoryEngineSettings({ MEMORY_SERVICE_URL: 'http://x:1', MEMORY_API_TOKEN: 't' })).toMatchObject({
      url: 'http://x:1',
      apiToken: 't',
    });
  });
});

describe('MemoryEngineClient', () => {
  it('sends the bearer token and marks refused requests as not worth retrying', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'bad role' }), { status: 422 }));
    const client = new MemoryEngineClient({ baseUrl: 'http://engine/', apiToken: 'abc', fetchFn: fetchFn as unknown as typeof fetch });
    const failure = await client.postMessages([]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MemoryEngineError);
    expect((failure as MemoryEngineError).retryable).toBe(false);
    expect((failure as MemoryEngineError).message).toContain('bad role');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://engine/v1/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc');
  });

  it('treats an unreachable engine and a 503 as worth retrying', async () => {
    const down = new MemoryEngineClient({
      baseUrl: 'http://engine',
      fetchFn: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(((await down.health().catch((e: unknown) => e)) as MemoryEngineError).retryable).toBe(true);
    const starting = new MemoryEngineClient({
      baseUrl: 'http://engine',
      fetchFn: (async () => new Response('{"error":"database is not ready"}', { status: 503 })) as unknown as typeof fetch,
    });
    expect(((await starting.putSession('s', { started_at: 'x' }).catch((e: unknown) => e)) as MemoryEngineError).retryable).toBe(true);
  });
});

describe('MemoryOutbox', () => {
  it('keeps writes while the engine is down and sends them in order once it is back', async () => {
    const store = await createStore();
    const engine = fakeEngine();
    engine.state.down = true;
    const client = new MemoryEngineClient({ baseUrl: 'http://engine', fetchFn: engine.fetchFn });
    const outbox = new MemoryOutbox({ store, client, logger: quiet, retryMs: 60_000 });
    cleanups.push(() => outbox.stop());

    outbox.enqueue({ kind: 'session', id: 's1', session: { started_at: '2026-11-03T08:00:00.000Z' } });
    for (const id of ['m1', 'm2']) {
      outbox.enqueue({
        kind: 'message',
        message: { id, session_id: 's1', role: 'user', content: id, created_at: '2026-11-03T08:00:01.000Z' },
      });
    }
    await outbox.flush();
    expect(outbox.status()).toMatchObject({ pending: 3, failing: true });
    expect(store.listMemoryOutbox()[0].attempts).toBe(1);

    engine.state.down = false;
    await outbox.flush();
    expect(outbox.status()).toEqual({ pending: 0, failing: false, lastError: null });
    expect(engine.state.calls.slice(-2)).toEqual(['PUT /v1/sessions/s1', 'POST /v1/messages']);
    expect([...engine.state.messages.keys()]).toEqual(['m1', 'm2']);
  });

  it('sends a handoff note after the conversation it belongs to', async () => {
    const store = await createStore();
    const engine = fakeEngine();
    const client = new MemoryEngineClient({ baseUrl: 'http://engine', fetchFn: engine.fetchFn });
    const outbox = new MemoryOutbox({ store, client, logger: quiet });
    cleanups.push(() => outbox.stop());
    outbox.enqueue({ kind: 'session', id: 's1', session: { started_at: '2026-11-03T08:00:00.000Z' } });
    outbox.enqueue({ kind: 'handoff', sessionId: 's1', handoff: { text: 'Ask about the budget.', agent: 'Echo', model: 'qwen' } });
    await outbox.flush();
    expect(engine.state.calls).toEqual(['PUT /v1/sessions/s1', 'PUT /v1/sessions/s1/handoff']);
    expect(outbox.status().pending).toBe(0);
  });

  it('drops writes the engine refuses so they cannot block the queue', async () => {
    const store = await createStore();
    const client = {
      putSession: vi.fn(async () => ({ id: 's' })),
      postMessages: vi.fn(async () => {
        throw new MemoryEngineError('422', 422, false);
      }),
    };
    const outbox = new MemoryOutbox({ store, client, logger: quiet });
    cleanups.push(() => outbox.stop());
    outbox.enqueue({ kind: 'message', message: { id: 'bad', session_id: 's', role: 'user', content: 'x', created_at: 'nope' } });
    await outbox.flush();
    expect(outbox.status().pending).toBe(0);
  });
});

describe('MemoryStore outbox', () => {
  it('drops the queued writes of one conversation only', async () => {
    const store = await createStore();
    store.enqueueMemoryOutbox('session', { id: 'a', session: {} });
    store.enqueueMemoryOutbox('message', { id: 'm1', session_id: 'a', role: 'user', content: 'x' });
    store.enqueueMemoryOutbox('message', { id: 'm2', session_id: 'b', role: 'user', content: 'y' });
    store.enqueueMemoryOutbox('fact', { id: 'f', fact: { text: 'z', session_id: 'a' } });
    store.enqueueMemoryOutbox('handoff', { sessionId: 'a', handoff: { text: 'note' } });
    expect(store.dropMemoryOutboxForSession('a')).toBe(3);
    expect(store.listMemoryOutbox().map((entry) => entry.kind)).toEqual(['message', 'fact']);
  });
});

describe('MemoryCapture', () => {
  function capture() {
    const items: OutboxItem[] = [];
    const memory = new MemoryCapture({ outbox: { enqueue: (item) => items.push(item) }, agent: () => ({ name: 'Echo', id: 'vrm-1' }) });
    return { memory, items };
  }

  it('records user and assistant messages but not system notices', () => {
    const { memory, items } = capture();
    memory.recordMessage({ id: 'a', sessionId: 's', role: 'system', content: 'Wake word detected', ts: 0 });
    memory.recordMessage({ id: 'b', sessionId: 's', role: 'user', content: '   ', ts: 0 });
    memory.recordMessage({ id: 'c', sessionId: 's', role: 'user', content: 'hello', ts: Date.UTC(2026, 10, 3, 8) });
    expect(items).toEqual([
      {
        kind: 'message',
        message: { id: 'c', session_id: 's', role: 'user', content: 'hello', created_at: '2026-11-03T08:00:00.000Z' },
      },
    ]);
  });

  it('records sessions with the character, and tool calls with their result', () => {
    const { memory, items } = capture();
    memory.recordSession({ id: 's', startedAt: 0, title: null });
    memory.recordToolCall({ sessionId: 's', name: 'web_search', arguments: { query: 'q' }, result: 'r', ok: true, at: 5 });
    expect(items[0]).toEqual({
      kind: 'session',
      id: 's',
      session: { started_at: '1970-01-01T00:00:00.000Z', agent: 'Echo', channel: 'voice', title: null, meta: { agent_id: 'vrm-1' } },
    });
    expect(items[1]).toMatchObject({
      kind: 'message',
      message: { session_id: 's', role: 'tool', content: 'r', tool: { name: 'web_search', arguments: { query: 'q' }, ok: true } },
    });
  });
});

describe('setupMemoryEngine', () => {
  it('imports the SQLite history once, then follows new conversation', async () => {
    const store = await createStore();
    store.createSession({ id: 'old', startedAt: Date.UTC(2026, 9, 1), title: null });
    store.appendMessage({ id: 'old-1', sessionId: 'old', role: 'user', ts: Date.UTC(2026, 9, 1, 0, 0, 1), content: 'old question', audioPath: null });
    store.appendMessage({ id: 'old-2', sessionId: 'old', role: 'system', ts: Date.UTC(2026, 9, 1, 0, 0, 2), content: 'notice', audioPath: null });

    const engine = fakeEngine();
    const conversations = new ConversationManager({ store });
    const runtime = setupMemoryEngine({
      settings: { enabled: true, url: 'http://engine' },
      store,
      conversations,
      logger: quiet,
      fetchFn: engine.fetchFn,
    });
    cleanups.push(() => runtime?.stop());
    expect(store.getValue(IMPORTED_KEY)).not.toBeNull();

    const session = conversations.startSession({ startedAt: Date.UTC(2026, 10, 3, 8) });
    conversations.appendMessage({ sessionId: session.id, role: 'user', content: 'new question', ts: Date.UTC(2026, 10, 3, 8, 0, 1) });
    runtime?.recordToolCall({ name: 'web_search', arguments: {}, result: 'found it', ok: true, at: Date.UTC(2026, 10, 3, 8, 0, 2) });
    await runtime?.outbox.flush();

    expect([...engine.state.sessions.keys()]).toEqual(['old', session.id]);
    expect(engine.state.sessions.get('old')).toMatchObject({ agent: 'assistant', meta: { imported: true } });
    const stored = [...engine.state.messages.values()];
    expect(stored.map((m) => [m.session_id, m.role, m.content])).toEqual([
      ['old', 'user', 'old question'],
      [session.id, 'user', 'new question'],
      [session.id, 'tool', 'found it'],
    ]);

    // A second start doesn't queue the history again.
    runtime?.stop();
    const again = setupMemoryEngine({ settings: { enabled: true, url: 'http://engine' }, store, conversations, logger: quiet, fetchFn: engine.fetchFn });
    cleanups.push(() => again?.stop());
    expect(store.countMemoryOutbox()).toBe(0);
  });

  it('does nothing when memory is off', async () => {
    const store = await createStore();
    expect(
      setupMemoryEngine({ settings: { enabled: false, url: 'x' }, store, conversations: new ConversationManager({ store }), logger: quiet }),
    ).toBeNull();
  });
});
