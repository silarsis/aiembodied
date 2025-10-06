import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeAssistantIntegration } from '../src/home-assistant/home-assistant-integration.js';
import type {
  HomeAssistantCommandIntent,
  HomeAssistantCommandResult,
  HomeAssistantConfig,
  HomeAssistantWebSocketFactory,
} from '../src/home-assistant/types.js';
import type { HomeAssistantEventPayload } from '../src/home-assistant/types.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.instances = [];
  }

  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners: Record<'open' | 'message' | 'close' | 'error', Set<(event: unknown) => void>> = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch('open', { type: 'open' });
    });
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void) {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void) {
    this.listeners[type].delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.readyState = 3;
    this.dispatch('close', { code: code ?? 1000 });
  }

  triggerMessage(payload: unknown) {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.dispatch('message', { data: serialized });
  }

  private dispatch(type: 'open' | 'message' | 'close' | 'error', event: unknown) {
    for (const listener of this.listeners[type]) {
      listener(event);
    }
  }
}

class InMemoryStore {
  readonly sessions: Array<{ id: string; startedAt: number; title: string | null }> = [];
  private readonly values = new Map<string, string>();

  createSession(record: { id: string; startedAt: number; title: string | null }) {
    this.sessions.push(record);
  }

  getValue(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setValue(key: string, value: string) {
    this.values.set(key, value);
  }
}

class MockConversation {
  readonly messages: Array<{ sessionId: string; content: string }> = [];
  activeSessionId: string | null = 'active-session';

  appendSystemMessage(content: string, _timestamp: number, sessionId?: string) {
    this.messages.push({ sessionId: sessionId ?? 'unknown', content });
  }

  getActiveSessionId() {
    return this.activeSessionId;
  }
}

const config: HomeAssistantConfig = {
  enabled: true,
  baseUrl: 'https://ha.local:8123',
  accessToken: 'ha-token',
  allowedEntities: ['light.kitchen'],
  eventTypes: ['state_changed'],
  reconnectDelaysMs: [50],
  heartbeatIntervalMs: 10000,
};

describe('HomeAssistantIntegration', () => {
  beforeEach(() => {
    MockWebSocket.reset();
  });

  it('records events and command activity into conversation history', async () => {
    const memoryStore = new InMemoryStore();
    const conversation = new MockConversation();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const integration = new HomeAssistantIntegration({
      config,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      conversation: {
        appendSystemMessage: (content, timestamp, sessionId) =>
          conversation.appendSystemMessage(content, timestamp, sessionId),
        getActiveSessionId: () => conversation.getActiveSessionId(),
      },
      memoryStore: {
        createSession: (record) => memoryStore.createSession(record),
        getValue: (key) => memoryStore.getValue(key),
        setValue: (key, value) => memoryStore.setValue(key, value),
      },
      fetchFn: fetchMock,
      WebSocketImpl: MockWebSocket as unknown as HomeAssistantWebSocketFactory,
      now: () => Date.parse('2024-01-01T00:00:00Z'),
    });

    const events: HomeAssistantEventPayload[] = [];
    integration.on('event', (event) => events.push(event));
    const commands: Array<{ intent: HomeAssistantCommandIntent; result: HomeAssistantCommandResult }> = [];
    integration.on('command', (payload) => commands.push(payload));

    const startPromise = integration.start();
    await Promise.resolve();
    const socket = MockWebSocket.instances[0];
    socket.triggerMessage({ type: 'auth_required' });
    socket.triggerMessage({ type: 'auth_ok' });
    await startPromise;

    socket.triggerMessage({
      type: 'event',
      id: 3,
      event: {
        event_type: 'state_changed',
        time_fired: '2024-01-01T01:00:00+00:00',
        data: {
          entity_id: 'light.kitchen',
          new_state: { state: 'on' },
          old_state: { state: 'off' },
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(memoryStore.sessions).toHaveLength(1);
    const logSessionId = memoryStore.sessions[0].id;
    expect(conversation.messages.some((message) => message.sessionId === logSessionId)).toBe(true);
    expect(conversation.messages.some((message) => message.sessionId === 'active-session')).toBe(true);

    const commandResult = await integration.dispatchIntent({
      domain: 'light',
      service: 'turn_on',
      entityId: 'light.kitchen',
    });

    expect(commandResult.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(commands).toHaveLength(1);
    expect(conversation.messages.some((message) => message.content.includes('command light.turn_on'))).toBe(true);

    await integration.stop();
  });

  it('rejects intents targeting entities outside of the whitelist', async () => {
    const integration = new HomeAssistantIntegration({
      config,
      WebSocketImpl: MockWebSocket as unknown as HomeAssistantWebSocketFactory,
    });

    const result = await integration.dispatchIntent({
      domain: 'light',
      service: 'turn_on',
      entityId: 'switch.office',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
  });
});
