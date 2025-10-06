import { EventEmitter } from 'node:events';
import type { HomeAssistantConfig } from '../config/config-manager.js';
import type {
  HomeAssistantCommandIntent,
  HomeAssistantCommandResult,
  HomeAssistantEventPayload,
  HomeAssistantStatusSnapshot,
  HomeAssistantWebSocket,
  HomeAssistantWebSocketFactory,
} from './types.js';

interface HomeAssistantClientEvents {
  connected: () => void;
  disconnected: () => void;
  event: (payload: HomeAssistantEventPayload) => void;
  error: (error: Error) => void;
  status: (snapshot: HomeAssistantStatusSnapshot) => void;
  'command-dispatched': (result: HomeAssistantCommandResult & { intent: HomeAssistantCommandIntent }) => void;
}

interface HomeAssistantClientOptions {
  config: HomeAssistantConfig;
  logger?: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
    debug?: (message: string, data?: Record<string, unknown>) => void;
  };
  fetchFn?: typeof fetch;
  WebSocketImpl?: HomeAssistantWebSocketFactory;
  now?: () => number;
}

const DEFAULT_RECONNECT_DELAYS = [1000, 5000, 15000];
const HEARTBEAT_INTERVAL_MS = 30000;
const SOCKET_OPEN_STATE = 1;

type SocketListeners = {
  open: (event: unknown) => void;
  message: (event: unknown) => void;
  close: (event: unknown) => void;
  error: (event: unknown) => void;
};

const enum ConnectionState {
  Idle = 0,
  Connecting = 1,
  Connected = 2,
  Stopping = 3,
}

export class HomeAssistantClient extends EventEmitter {
  private readonly config: HomeAssistantConfig;
  private readonly logger?: HomeAssistantClientOptions['logger'];
  private readonly fetchFn: typeof fetch;
  private readonly WebSocketImpl: HomeAssistantWebSocketFactory;
  private readonly now: () => number;
  private readonly reconnectDelays: readonly number[];

  private state: ConnectionState = ConnectionState.Idle;
  private socket: HomeAssistantWebSocket | null = null;
  private socketListeners: SocketListeners | null = null;
  private reconnectAttempt = 0;
  private manualStop = false;
  private lastEventAt: number | undefined;
  private lastCommandAt: number | undefined;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectResolver: (() => void) | null = null;
  private connectRejecter: ((error: unknown) => void) | null = null;
  private nextMessageId = 1;

  constructor(options: HomeAssistantClientOptions) {
    super();
    this.config = options.config;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.WebSocketImpl = resolveWebSocketFactory(options.WebSocketImpl);
    this.now = options.now ?? Date.now;
    this.reconnectDelays =
      options.config.reconnectDelaysMs && options.config.reconnectDelaysMs.length > 0
        ? options.config.reconnectDelaysMs
        : DEFAULT_RECONNECT_DELAYS;
  }

  override on<U extends keyof HomeAssistantClientEvents>(event: U, listener: HomeAssistantClientEvents[U]): this {
    return super.on(event, listener);
  }

  override once<U extends keyof HomeAssistantClientEvents>(event: U, listener: HomeAssistantClientEvents[U]): this {
    return super.once(event, listener);
  }

  override off<U extends keyof HomeAssistantClientEvents>(event: U, listener: HomeAssistantClientEvents[U]): this {
    return super.off(event, listener);
  }

  async start(): Promise<void> {
    if (this.state === ConnectionState.Connected) {
      return;
    }

    if (this.state === ConnectionState.Connecting) {
      return new Promise<void>((resolve, reject) => {
        const done = () => {
          this.off('connected', done);
          this.off('error', reject);
          resolve();
        };
        this.once('connected', done);
        this.once('error', reject);
      });
    }

    this.manualStop = false;
    this.state = ConnectionState.Connecting;

    return new Promise<void>((resolve, reject) => {
      this.connectResolver = resolve;
      this.connectRejecter = reject;
      this.establishConnection().catch(reject);
    });
  }

  async stop(): Promise<void> {
    this.manualStop = true;
    this.state = ConnectionState.Stopping;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch (error) {
        this.logger?.warn('Error while closing Home Assistant socket', describeError(error));
      }
      this.detachSocketListeners();
      this.socket = null;
    }

    this.state = ConnectionState.Idle;
  }

  isConnected(): boolean {
    return this.state === ConnectionState.Connected;
  }

  getStatusSnapshot(): HomeAssistantStatusSnapshot {
    return {
      connected: this.isConnected(),
      lastEventAt: this.lastEventAt,
      lastCommandAt: this.lastCommandAt,
    };
  }

  async dispatchCommand(intent: HomeAssistantCommandIntent): Promise<HomeAssistantCommandResult> {
    if (!this.config.allowedEntities.includes(intent.entityId)) {
      const error = `Entity ${intent.entityId} is not permitted for control.`;
      this.logger?.warn('Home Assistant command rejected', { entityId: intent.entityId, source: intent.source });
      return { success: false, status: 403, error };
    }

    if (!intent.domain || !intent.service) {
      return { success: false, status: 400, error: 'Home Assistant intent is missing domain or service.' };
    }

    const url = new URL(`/api/services/${intent.domain}/${intent.service}`, this.config.baseUrl);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
    };
    const body: Record<string, unknown> = { ...(intent.data ?? {}) };
    if (!body.entity_id) {
      body.entity_id = intent.entityId;
    }

    this.logger?.info('Dispatching Home Assistant command', {
      entityId: intent.entityId,
      domain: intent.domain,
      service: intent.service,
      source: intent.source ?? 'unknown',
      correlationId: intent.correlationId,
    });

    const response = await this.fetchFn(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    this.lastCommandAt = this.now();
    const result: HomeAssistantCommandResult = {
      success: response.ok,
      status: response.status,
    };

    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        result.response = await response.json();
      } catch (error) {
        this.logger?.warn('Failed to parse Home Assistant command response', describeError(error));
      }
    } else {
      result.response = await response.text().catch(() => undefined);
    }

    if (!response.ok) {
      const message = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
      result.error = message;
      this.logger?.error('Home Assistant command failed', {
        status: response.status,
        entityId: intent.entityId,
        domain: intent.domain,
        service: intent.service,
        correlationId: intent.correlationId,
        response: result.response,
      });
    } else {
      this.logger?.info('Home Assistant command succeeded', {
        entityId: intent.entityId,
        domain: intent.domain,
        service: intent.service,
        correlationId: intent.correlationId,
      });
    }

    this.emit('command-dispatched', { ...result, intent });
    this.emit('status', this.getStatusSnapshot());
    return result;
  }

  private async establishConnection(): Promise<void> {
    try {
      await this.connectWebSocket();
    } catch (error) {
      this.handleConnectionError(error);
      throw error;
    }
  }

  private buildWebSocketUrl(): string {
    const url = new URL(this.config.baseUrl);
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    }
    url.pathname = url.pathname.replace(/\/$/, '') + '/api/websocket';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private async connectWebSocket(): Promise<void> {
    const wsUrl = this.buildWebSocketUrl();
    this.logger?.info('Connecting to Home Assistant WebSocket', { url: wsUrl });

    const socket = new this.WebSocketImpl(wsUrl);
    this.socket = socket;

    const listeners: SocketListeners = {
      open: () => {
        this.logger?.info('Home Assistant socket opened. Awaiting authentication.');
        this.emit('status', this.getStatusSnapshot());
      },
      message: (event: unknown) => {
        const payload = this.parseMessage(extractMessageData(event));
        if (!payload) {
          return;
        }
        this.processMessage(payload);
      },
      close: (event: unknown) => {
        const { code } = extractCloseDetails(event);
        this.logger?.warn('Home Assistant socket closed', { code });
        this.detachSocketListeners();
        this.socket = null;
        this.cleanupHeartbeat();
        this.emit('disconnected');
        this.state = this.manualStop ? ConnectionState.Idle : ConnectionState.Connecting;
        if (this.manualStop) {
          this.emit('status', this.getStatusSnapshot());
          return;
        }
        this.scheduleReconnect();
      },
      error: (event: unknown) => {
        const error = extractError(event);
        this.logger?.error('Home Assistant socket error', describeError(error));
        this.emit('error', error);
      },
    };

    this.socketListeners = listeners;
    socket.addEventListener('open', listeners.open);
    socket.addEventListener('message', listeners.message);
    socket.addEventListener('close', listeners.close);
    socket.addEventListener('error', listeners.error);
  }

  private processMessage(payload: Record<string, unknown>): void {
    const type = typeof payload.type === 'string' ? payload.type : '';
    switch (type) {
      case 'auth_required':
        this.sendMessage({ type: 'auth', access_token: this.config.accessToken });
        break;
      case 'auth_ok':
        this.handleAuthenticated();
        break;
      case 'auth_invalid':
        this.logger?.error('Home Assistant authentication failed', {
          message: payload.message ?? 'Unknown authentication failure',
        });
        this.emit('error', new Error('Home Assistant authentication failed.'));
        void this.stop();
        break;
      case 'event':
        this.handleEvent(payload);
        break;
      case 'result':
        this.handleResult(payload);
        break;
      case 'pong':
        this.logger?.debug?.('Received Home Assistant pong');
        break;
      default:
        this.logger?.debug?.('Unhandled Home Assistant message', { type, payload });
    }
  }

  private handleAuthenticated(): void {
    this.logger?.info('Home Assistant authentication accepted. Subscribing to events.');
    this.state = ConnectionState.Connected;
    this.reconnectAttempt = 0;
    this.emit('connected');
    this.emit('status', this.getStatusSnapshot());

    for (const eventType of this.config.eventTypes) {
      this.sendMessage({
        id: this.nextMessageId++,
        type: 'subscribe_events',
        event_type: eventType,
      });
    }

    this.startHeartbeat();
    if (this.connectResolver) {
      this.connectResolver();
      this.connectResolver = null;
      this.connectRejecter = null;
    }
  }

  private handleEvent(payload: Record<string, unknown>): void {
    const event = (payload.event ?? {}) as Record<string, unknown>;
    const eventType = typeof event.event_type === 'string' ? event.event_type : 'unknown';
    const timeFired = typeof event.time_fired === 'string' ? event.time_fired : undefined;
    const timestamp = timeFired ? Date.parse(timeFired) : this.now();
    const data = (event.data as Record<string, unknown>) ?? {};
    const entityId = typeof data.entity_id === 'string' ? data.entity_id : undefined;

    const parsed: HomeAssistantEventPayload = {
      id: typeof payload.id === 'number' ? payload.id : this.nextMessageId++,
      type: eventType,
      entityId,
      timestamp,
      data,
      raw: payload,
    };

    this.lastEventAt = timestamp;
    this.emit('event', parsed);
    this.emit('status', this.getStatusSnapshot());
  }

  private handleResult(payload: Record<string, unknown>): void {
    if (payload.success === false) {
      this.logger?.warn('Home Assistant subscription error', { payload });
    }
  }

  private parseMessage(data: unknown): Record<string, unknown> | null {
    try {
      if (typeof data === 'string') {
        return JSON.parse(data) as Record<string, unknown>;
      }

      if (data instanceof Buffer) {
        return JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
      }

      if (data instanceof ArrayBuffer) {
        return JSON.parse(Buffer.from(data).toString('utf-8')) as Record<string, unknown>;
      }

      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        return JSON.parse(Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf-8')) as Record<
          string,
          unknown
        >;
      }

      if (Array.isArray(data)) {
        return null;
      }

      return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
    } catch (error) {
      this.logger?.warn('Failed to parse Home Assistant message', describeError(error));
      return null;
    }
  }

  private sendMessage(message: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN_STATE) {
      this.logger?.warn('Attempted to send Home Assistant message while socket closed', { message });
      return;
    }

    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.logger?.warn('Failed to send Home Assistant message', describeError(error));
    }
  }

  private startHeartbeat(): void {
    this.cleanupHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendMessage({ type: 'ping' });
    }, this.config.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  }

  private cleanupHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.manualStop) {
      return;
    }

    const delayMs = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)];
    this.reconnectAttempt += 1;
    this.logger?.info('Scheduling Home Assistant reconnect', { delayMs, attempt: this.reconnectAttempt });

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualStop) {
        return;
      }
      void this.establishConnection().catch((error) => {
        this.handleConnectionError(error);
      });
    }, delayMs);
  }

  private handleConnectionError(error: unknown): void {
    const described = describeError(error);
    this.logger?.error('Home Assistant connection error', described);
    this.emit('error', error instanceof Error ? error : new Error(described.message ?? String(described)));
    if (this.connectRejecter) {
      this.connectRejecter(error);
      this.connectResolver = null;
      this.connectRejecter = null;
    }
  }

  private detachSocketListeners(): void {
    if (!this.socket || !this.socketListeners) {
      this.socketListeners = null;
      return;
    }

    this.socket.removeEventListener('open', this.socketListeners.open);
    this.socket.removeEventListener('message', this.socketListeners.message);
    this.socket.removeEventListener('close', this.socketListeners.close);
    this.socket.removeEventListener('error', this.socketListeners.error);
    this.socketListeners = null;
  }
}

function describeError(error: unknown): { message: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  return { message: 'Unknown Home Assistant client error' };
}

function resolveWebSocketFactory(factory?: HomeAssistantWebSocketFactory): HomeAssistantWebSocketFactory {
  if (factory) {
    return factory;
  }

  if (typeof globalThis.WebSocket === 'function') {
    return globalThis.WebSocket as unknown as HomeAssistantWebSocketFactory;
  }

  throw new Error('No WebSocket implementation available for Home Assistant client.');
}

function extractMessageData(event: unknown): unknown {
  if (event && typeof event === 'object' && 'data' in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}

function extractCloseDetails(event: unknown): { code?: number; reason?: string } {
  if (event && typeof event === 'object') {
    const record = event as { code?: unknown; reason?: unknown };
    return {
      code: typeof record.code === 'number' ? record.code : undefined,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    };
  }
  return {};
}

function extractError(event: unknown): Error {
  if (event instanceof Error) {
    return event;
  }

  if (event && typeof event === 'object' && 'error' in event) {
    const possible = (event as { error?: unknown }).error;
    if (possible instanceof Error) {
      return possible;
    }
    if (typeof possible === 'string') {
      return new Error(possible);
    }
  }

  if (typeof event === 'string') {
    return new Error(event);
  }

  return new Error('Unknown Home Assistant socket error');
}
