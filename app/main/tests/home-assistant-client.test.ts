import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeAssistantClient } from '../src/home-assistant/home-assistant-client.js';
import type { HomeAssistantConfig } from '../src/config/config-manager.js';
import type { HomeAssistantEventPayload } from '../src/home-assistant/types.js';

class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.instances = [];
  }

  readonly sent: string[] = [];
  readyState = 1;
  terminate = vi.fn();

  constructor(public readonly url: string, _options?: unknown) {
    super();
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.emit('open');
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.readyState = 3;
    this.emit('close', code ?? 1000);
  }

  triggerMessage(payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.emit('message', data);
  }
}

const baseConfig: HomeAssistantConfig = {
  enabled: true,
  baseUrl: 'https://ha.local:8123',
  accessToken: 'ha-token',
  allowedEntities: ['light.kitchen'],
  eventTypes: ['state_changed'],
  reconnectDelaysMs: [20, 40],
  heartbeatIntervalMs: 10000,
};

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCondition(assertion: () => void, timeoutMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await flushMicrotasks();
  }
  throw lastError ?? new Error('Condition not satisfied');
}

describe('HomeAssistantClient', () => {
  beforeEach(() => {
    MockWebSocket.reset();
  });

  it('authenticates and emits subscribed events', async () => {
    const client = new HomeAssistantClient({
      config: baseConfig,
      WebSocketImpl: MockWebSocket as unknown as typeof import('ws'),
      now: () => 123456,
    });

    const events: HomeAssistantEventPayload[] = [];
    client.on('event', (event) => events.push(event));

    const startPromise = client.start();
    await Promise.resolve();

    const socket = MockWebSocket.instances.at(-1)!;
    socket.triggerMessage({ type: 'auth_required' });
    socket.triggerMessage({ type: 'auth_ok' });

    expect(socket.sent).toContainEqual(JSON.stringify({ type: 'auth', access_token: 'ha-token' }));
    expect(socket.sent.some((message) => message.includes('subscribe_events'))).toBe(true);

    socket.triggerMessage({
      type: 'event',
      id: 7,
      event: {
        event_type: 'state_changed',
        time_fired: '2024-01-01T00:00:00+00:00',
        data: {
          entity_id: 'light.kitchen',
          new_state: { state: 'on' },
          old_state: { state: 'off' },
        },
      },
    });

    await startPromise;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('state_changed');
    expect(events[0].entityId).toBe('light.kitchen');
    expect(events[0].timestamp).toBe(Date.parse('2024-01-01T00:00:00+00:00'));
  });

  it('reconnects after unexpected close', async () => {
    vi.useFakeTimers();
    const client = new HomeAssistantClient({
      config: { ...baseConfig, reconnectDelaysMs: [10] },
      WebSocketImpl: MockWebSocket as unknown as typeof import('ws'),
    });

    const startPromise = client.start();
    await Promise.resolve();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.triggerMessage({ type: 'auth_required' });
    firstSocket.triggerMessage({ type: 'auth_ok' });
    await startPromise;

    firstSocket.close(1006);
    expect(MockWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10);
    await waitForCondition(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    vi.useRealTimers();
  });

  it('rejects command dispatch for unauthorized entities', async () => {
    const fetchMock = vi.fn();
    const client = new HomeAssistantClient({
      config: baseConfig,
      WebSocketImpl: MockWebSocket as unknown as typeof import('ws'),
      fetchFn: fetchMock,
    });

    const result = await client.dispatchCommand({
      domain: 'light',
      service: 'turn_on',
      entityId: 'switch.garage',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dispatches commands using the REST API', async () => {
    const response = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    const client = new HomeAssistantClient({
      config: baseConfig,
      WebSocketImpl: MockWebSocket as unknown as typeof import('ws'),
      fetchFn: fetchMock,
    });

    const result = await client.dispatchCommand({
      domain: 'light',
      service: 'turn_on',
      entityId: 'light.kitchen',
      data: { brightness: 150 },
    });

    expect(fetchMock).toHaveBeenCalledWith('https://ha.local:8123/api/services/light/turn_on', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ha-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ brightness: 150, entity_id: 'light.kitchen' }),
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.response).toEqual({ success: true });
  });
});
