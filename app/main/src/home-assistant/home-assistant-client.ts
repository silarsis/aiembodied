import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type WebSocket from 'ws';
import createWebSocket, { type ClientOptions as WebSocketClientOptions, type RawData } from 'ws';
import type { HomeAssistantConfig } from '../config/config-manager.js';
import type {
  HomeAssistantCommandIntent,
  HomeAssistantCommandResult,
  HomeAssistantEventPayload,
  HomeAssistantStatusSnapshot,
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
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
}

interface WebSocketLike extends EventEmitter {
  readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface HomeAssistantWebSocketOptions extends WebSocketClientOptions {}

const DEFAULT_RECONNECT_DELAYS = [1000, 5000, 15000];
const HEARTBEAT_INTERVAL_MS = 30000;
const CONNECTION_TIMEOUT_MS = 10000;

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
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly now: () => number;
  private readonly reconnectDelays: readonly number[];

  private state: ConnectionState = ConnectionState.Idle;
  private socket: (WebSocketLike & { terminate?: () => void }) | null = null;
  private reconnectAttempt = 0;
  private manualStop = false;
  private lastEventAt: number | undefined;
  private lastCommandAt: number | undefined;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectResolver: (() => void) | null = null;
  private connectRejecter: ((error: unknown) => void) | null = null;
  private nextMessageId = 1;

  constructor(options: HomeAssistantClientOptions) {
    super();
    this.config = options.config;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.WebSocketImpl = options.WebSocketImpl ?? createWebSocket;
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

    if (this.socket) {
      try {
        this.socket.close();
      } catch (error) {
        this.logger?.warn('Error while closing Home Assistant socket', describeError(error));
      }
      if (typeof this.socket.terminate === 'function') {
        try {
          this.socket.terminate();
        } catch (error) {
          this.logger?.warn('Error while terminating Home Assistant socket', describeError(error));
        }
      }
      this.socket.removeAllListeners();
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

    const socket = new this.WebSocketImpl(wsUrl, {
      handshakeTimeout: CONNECTION_TIMEOUT_MS,
    } as HomeAssistantWebSocketOptions);

    this.socket = socket as WebSocketLike & { terminate?: () => void };

    socket.on('open', () => {
      this.logger?.info('Home Assistant socket opened. Awaiting authentication.');
      this.emit('status', this.getStatusSnapshot());
    });

    socket.on('message', (data: RawData) => {
      const payload = this.parseMessage(data);
      if (!payload) {
        return;
      }
      this.processMessage(payload);
    });

    socket.on('close', (code: number) => {
      this.logger?.warn('Home Assistant socket closed', { code });
      this.cleanupHeartbeat();
      this.emit('disconnected');
      this.state = this.manualStop ? ConnectionState.Idle : ConnectionState.Connecting;
      if (this.manualStop) {
        this.emit('status', this.getStatusSnapshot());
        return;
      }
      this.scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      this.logger?.error('Home Assistant socket error', describeError(error));
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
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
    if (!this.socket || this.socket.readyState !== 1) {
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

    delay(delayMs)
      .then(() => {
        if (this.manualStop) {
          return;
        }
        return this.establishConnection();
      })
      .catch((error) => {
        this.handleConnectionError(error);
      });
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
