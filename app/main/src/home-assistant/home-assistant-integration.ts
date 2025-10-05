import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HomeAssistantClient } from './home-assistant-client.js';
import type {
  HomeAssistantCommandIntent,
  HomeAssistantCommandResult,
  HomeAssistantEventListener,
  HomeAssistantEventPayload,
  HomeAssistantIntegrationOptions,
  HomeAssistantStatusListener,
  HomeAssistantStatusSnapshot,
} from './types.js';

interface HomeAssistantIntegrationEvents {
  event: (payload: HomeAssistantEventPayload) => void;
  status: (snapshot: HomeAssistantStatusSnapshot) => void;
  command: (payload: { intent: HomeAssistantCommandIntent; result: HomeAssistantCommandResult }) => void;
  error: (error: Error) => void;
}

const EVENT_SESSION_KEY = 'homeAssistant:eventSessionId';

export class HomeAssistantIntegration extends EventEmitter {
  private readonly logger?: HomeAssistantIntegrationOptions['logger'];
  private readonly conversation: HomeAssistantIntegrationOptions['conversation'];
  private readonly memoryStore: HomeAssistantIntegrationOptions['memoryStore'] | null;
  private readonly now: () => number;

  private readonly client: HomeAssistantClient;
  private readonly allowedEntities: readonly string[];

  private eventSessionId: string | null = null;
  private started = false;

  constructor(private readonly options: HomeAssistantIntegrationOptions) {
    super();
    this.logger = options.logger;
    this.conversation = HomeAssistantIntegration.normalizeConversationBridge(options.conversation);
    this.memoryStore = options.memoryStore ?? null;
    this.now = options.now ?? Date.now;
    this.allowedEntities = options.config.allowedEntities;

    this.client = new HomeAssistantClient({
      config: options.config,
      logger: options.logger,
      fetchFn: options.fetchFn,
      WebSocketImpl: options.WebSocketImpl,
      now: this.now,
    });

    this.client.on('event', (payload) => this.handleEvent(payload));
    this.client.on('status', (snapshot) => this.emit('status', snapshot));
    this.client.on('command-dispatched', ({ intent, ...rest }) => {
      const result: HomeAssistantCommandResult = { ...rest };
      this.emit('command', { intent, result });
      this.recordCommand(intent, result);
    });
    this.client.on('error', (error) => {
      this.logger?.error?.('Home Assistant client error', { message: error.message });
      this.emit('error', error);
    });
  }

  override on<U extends keyof HomeAssistantIntegrationEvents>(event: U, listener: HomeAssistantIntegrationEvents[U]): this {
    return super.on(event, listener);
  }

  override once<U extends keyof HomeAssistantIntegrationEvents>(event: U, listener: HomeAssistantIntegrationEvents[U]): this {
    return super.once(event, listener);
  }

  override off<U extends keyof HomeAssistantIntegrationEvents>(event: U, listener: HomeAssistantIntegrationEvents[U]): this {
    return super.off(event, listener);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    try {
      await this.client.start();
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    await this.client.stop();
  }

  async dispatchIntent(intent: HomeAssistantCommandIntent): Promise<HomeAssistantCommandResult> {
    if (!this.allowedEntities.includes(intent.entityId)) {
      this.logger?.warn?.('Rejected Home Assistant intent for unauthorized entity', {
        entityId: intent.entityId,
        domain: intent.domain,
        service: intent.service,
      });
      return { success: false, status: 403, error: `Entity ${intent.entityId} is not allowed.` };
    }

    const result = await this.client.dispatchCommand(intent);
    return result;
  }

  getStatus(): HomeAssistantStatusSnapshot {
    return this.client.getStatusSnapshot();
  }

  addEventListener(listener: HomeAssistantEventListener): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  addStatusListener(listener: HomeAssistantStatusListener): () => void {
    this.on('status', listener);
    return () => this.off('status', listener);
  }

  private handleEvent(payload: HomeAssistantEventPayload): void {
    this.logger?.info?.('Home Assistant event received', {
      type: payload.type,
      entityId: payload.entityId,
      timestamp: payload.timestamp,
    });

    this.emit('event', payload);
    this.recordEvent(payload);
  }

  private recordEvent(payload: HomeAssistantEventPayload): void {
    const message = formatEventMessage(payload);
    const timestamp = payload.timestamp || this.now();

    const eventSession = this.ensureEventSession();
    if (eventSession) {
      this.appendSystemMessage(message, timestamp, eventSession);
    }

    const activeSession = this.conversation?.getActiveSessionId?.();
    if (activeSession && activeSession !== eventSession) {
      this.appendSystemMessage(message, timestamp, activeSession);
    }
  }

  private recordCommand(intent: HomeAssistantCommandIntent, result: HomeAssistantCommandResult): void {
    const timestamp = this.now();
    const outcome = result.success ? 'succeeded' : 'failed';
    const message =
      `Home Assistant command ${intent.domain}.${intent.service} ${outcome} for ${intent.entityId} (status ${result.status})` +
      (result.error ? `: ${result.error}` : '.');

    const eventSession = this.ensureEventSession();
    if (eventSession) {
      this.appendSystemMessage(message, timestamp, eventSession);
    }

    const activeSession = this.conversation?.getActiveSessionId?.();
    if (activeSession && activeSession !== eventSession) {
      this.appendSystemMessage(message, timestamp, activeSession);
    }
  }

  private appendSystemMessage(content: string, timestamp: number, sessionId: string): void {
    try {
      this.conversation?.appendSystemMessage(content, timestamp, sessionId);
    } catch (error) {
      this.logger?.warn?.('Failed to append Home Assistant context message', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensureEventSession(): string | null {
    if (!this.memoryStore) {
      return null;
    }

    if (this.eventSessionId) {
      return this.eventSessionId;
    }

    const stored = this.memoryStore.getValue(EVENT_SESSION_KEY);
    if (stored) {
      this.eventSessionId = stored;
      return stored;
    }

    const sessionId = randomUUID();
    const startedAt = this.now();

    try {
      this.memoryStore.createSession({
        id: sessionId,
        startedAt,
        title: 'Home Assistant Events',
      });
      this.memoryStore.setValue(EVENT_SESSION_KEY, sessionId);
      this.eventSessionId = sessionId;
      return sessionId;
    } catch (error) {
      this.logger?.warn?.('Failed to create Home Assistant event session', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private static normalizeConversationBridge(
    conversation: HomeAssistantIntegrationOptions['conversation'],
  ): HomeAssistantIntegrationOptions['conversation'] {
    return conversation ?? undefined;
  }
}

function formatEventMessage(event: HomeAssistantEventPayload): string {
  const timestamp = new Date(event.timestamp).toISOString();
  const parts = [`Home Assistant event "${event.type}" at ${timestamp}`];
  if (event.entityId) {
    parts.push(`entity ${event.entityId}`);
  }

  const dataSummary = summarizeEventData(event.data);
  if (dataSummary) {
    parts.push(dataSummary);
  }

  return parts.join(' - ');
}

function summarizeEventData(data: Record<string, unknown>): string | null {
  const newState = data.new_state as Record<string, unknown> | undefined;
  const oldState = data.old_state as Record<string, unknown> | undefined;
  const newValue = typeof newState?.state === 'string' ? newState.state : undefined;
  const oldValue = typeof oldState?.state === 'string' ? oldState.state : undefined;

  if (newValue && oldValue) {
    return `state changed from "${oldValue}" to "${newValue}"`;
  }

  if (newValue) {
    return `state is "${newValue}"`;
  }

  if (typeof data.value === 'string') {
    return `value: ${data.value}`;
  }

  if (typeof data.state === 'string') {
    return `state: ${data.state}`;
  }

  return null;
}
