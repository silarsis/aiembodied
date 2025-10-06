import type { HomeAssistantConfig } from '../config/config-manager.js';

export interface HomeAssistantWebSocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

export type HomeAssistantWebSocketFactory = new (url: string) => HomeAssistantWebSocket;

export interface HomeAssistantEventPayload {
  id: number;
  type: string;
  entityId?: string;
  timestamp: number;
  data: Record<string, unknown>;
  raw: unknown;
}

export interface HomeAssistantCommandIntent {
  domain: string;
  service: string;
  entityId: string;
  data?: Record<string, unknown>;
  source?: string;
  correlationId?: string;
}

export interface HomeAssistantCommandResult {
  success: boolean;
  status: number;
  response?: unknown;
  error?: string;
}

export interface HomeAssistantStatusSnapshot {
  connected: boolean;
  lastEventAt?: number;
  lastCommandAt?: number;
}

export interface HomeAssistantIntegrationOptions {
  config: HomeAssistantConfig;
  logger?: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
    debug?: (message: string, data?: Record<string, unknown>) => void;
  };
  conversation?: {
    appendSystemMessage: (content: string, timestamp: number, sessionId?: string) => void;
    getActiveSessionId: () => string | null;
  };
  memoryStore?: {
    getValue(key: string): string | null;
    setValue(key: string, value: string): void;
    createSession(record: { id: string; startedAt: number; title: string | null }): void;
  };
  fetchFn?: typeof fetch;
  WebSocketImpl?: HomeAssistantWebSocketFactory;
  now?: () => number;
}

export type HomeAssistantEventListener = (payload: HomeAssistantEventPayload) => void;

export type HomeAssistantStatusListener = (snapshot: HomeAssistantStatusSnapshot) => void;

export type { HomeAssistantConfig };
