import { contextBridge, ipcRenderer } from 'electron';
import type { ConfigSecretKey, RendererConfig } from './config/config-manager.js';
import type { AudioDevicePreferences } from './config/preferences-store.js';
import type {
  ConversationAppendMessagePayload,
  ConversationHistory,
  ConversationMessage,
  ConversationSession,
} from './conversation/types.js';
import type { WakeWordDetectionEvent } from './wake-word/types.js';
import type { LatencyMetricName } from './metrics/types.js';
import type {
  HomeAssistantCommandIntent,
  HomeAssistantCommandResult,
  HomeAssistantEventPayload,
  HomeAssistantStatusSnapshot,
} from './home-assistant/types.js';

export interface ConfigBridge {
  get(): Promise<RendererConfig>;
  getSecret(key: ConfigSecretKey): Promise<string>;
  setAudioDevicePreferences(preferences: AudioDevicePreferences): Promise<RendererConfig>;
}

export interface PreloadApi {
  config: ConfigBridge;
  wakeWord: WakeWordBridge;
  conversation?: ConversationBridge;
  metrics?: MetricsBridge;
  homeAssistant?: HomeAssistantBridge;
  ping(): string;
}

export interface WakeWordBridge {
  onWake(listener: (event: WakeWordDetectionEvent) => void): () => void;
}

export interface ConversationBridge {
  getHistory(): Promise<ConversationHistory>;
  appendMessage(message: ConversationAppendMessagePayload): Promise<ConversationMessage>;
  onSessionStarted(listener: (session: ConversationSession) => void): () => void;
  onMessageAppended(listener: (message: ConversationMessage) => void): () => void;
}

export interface MetricsBridge {
  observeLatency(metric: LatencyMetricName, valueMs: number): Promise<void>;
}

export interface HomeAssistantBridge {
  getStatus(): Promise<HomeAssistantStatusSnapshot>;
  dispatchIntent(intent: HomeAssistantCommandIntent): Promise<HomeAssistantCommandResult>;
  onEvent(listener: (event: HomeAssistantEventPayload) => void): () => void;
  onStatus(listener: (status: HomeAssistantStatusSnapshot) => void): () => void;
  onCommand(
    listener: (payload: { intent: HomeAssistantCommandIntent; result: HomeAssistantCommandResult }) => void,
  ): () => void;
}

const api: PreloadApi = {
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<RendererConfig>,
    getSecret: (key) => ipcRenderer.invoke('config:get-secret', key) as Promise<string>,
    setAudioDevicePreferences: (preferences) =>
      ipcRenderer.invoke('config:set-audio-devices', preferences) as Promise<RendererConfig>,
  },
  wakeWord: {
    onWake: (listener) => {
      const channel = 'wake-word:event';
      const handler = (_event: unknown, payload: WakeWordDetectionEvent) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
  },
  conversation: {
    getHistory: () => ipcRenderer.invoke('conversation:get-history') as Promise<ConversationHistory>,
    appendMessage: (message) =>
      ipcRenderer.invoke('conversation:append-message', message) as Promise<ConversationMessage>,
    onSessionStarted: (listener) => {
      const channel = 'conversation:session-started';
      const handler = (_event: unknown, payload: ConversationSession) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
    onMessageAppended: (listener) => {
      const channel = 'conversation:message-appended';
      const handler = (_event: unknown, payload: ConversationMessage) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
  },
  metrics: {
    observeLatency: async (metric, valueMs) => {
      await ipcRenderer.invoke('metrics:observe-latency', { metric, valueMs });
    },
  },
  homeAssistant: {
    getStatus: () => ipcRenderer.invoke('home-assistant:get-status') as Promise<HomeAssistantStatusSnapshot>,
    dispatchIntent: (intent) =>
      ipcRenderer.invoke('home-assistant:dispatch-intent', intent) as Promise<HomeAssistantCommandResult>,
    onEvent: (listener) => {
      const channel = 'home-assistant:event';
      const handler = (_event: unknown, payload: HomeAssistantEventPayload) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
    onStatus: (listener) => {
      const channel = 'home-assistant:status';
      const handler = (_event: unknown, payload: HomeAssistantStatusSnapshot) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
    onCommand: (listener) => {
      const channel = 'home-assistant:command';
      const handler = (
        _event: unknown,
        payload: { intent: HomeAssistantCommandIntent; result: HomeAssistantCommandResult },
      ) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
  },
  ping: () => 'pong',
};

contextBridge.exposeInMainWorld('aiembodied', api);

declare global {
  interface Window {
    aiembodied: PreloadApi;
  }
}
