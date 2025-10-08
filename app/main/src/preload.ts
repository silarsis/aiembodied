import { contextBridge, ipcRenderer } from 'electron';
import type { ConfigSecretKey, RendererConfig } from './config/config-manager.js';
import type { AudioDevicePreferences } from './config/preferences-store.js';
import type {
  AvatarFaceDetail,
  AvatarFaceSummary,
  AvatarUploadRequest,
  AvatarUploadResult,
} from './avatar/types.js';
import type {
  ConversationAppendMessagePayload,
  ConversationHistory,
  ConversationMessage,
  ConversationSession,
} from './conversation/types.js';
import type { WakeWordDetectionEvent } from './wake-word/types.js';
import type { LatencyMetricName } from './metrics/types.js';

export interface ConfigBridge {
  get(): Promise<RendererConfig>;
  getSecret(key: ConfigSecretKey): Promise<string>;
  setAudioDevicePreferences(preferences: AudioDevicePreferences): Promise<RendererConfig>;
  setSecret(key: ConfigSecretKey, value: string): Promise<RendererConfig>;
  testSecret(key: ConfigSecretKey): Promise<{ ok: boolean; message?: string }>;
}

export interface PreloadApi {
  config: ConfigBridge;
  wakeWord: WakeWordBridge;
  conversation?: ConversationBridge;
  metrics?: MetricsBridge;
  avatar?: AvatarBridge;
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

export interface AvatarBridge {
  listFaces(): Promise<AvatarFaceSummary[]>;
  getActiveFace(): Promise<AvatarFaceDetail | null>;
  setActiveFace(faceId: string | null): Promise<AvatarFaceDetail | null>;
  uploadFace(request: AvatarUploadRequest): Promise<AvatarUploadResult>;
  deleteFace(faceId: string): Promise<void>;
}

const api: PreloadApi = {
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<RendererConfig>,
    getSecret: (key) => ipcRenderer.invoke('config:get-secret', key) as Promise<string>,
    setSecret: (key, value) =>
      ipcRenderer.invoke('config:set-secret', { key, value }) as Promise<RendererConfig>,
    testSecret: (key) =>
      ipcRenderer.invoke('config:test-secret', key) as Promise<{ ok: boolean; message?: string }>,
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
  avatar: {
    listFaces: () => ipcRenderer.invoke('avatar:list-faces') as Promise<AvatarFaceSummary[]>,
    getActiveFace: () => ipcRenderer.invoke('avatar:get-active-face') as Promise<AvatarFaceDetail | null>,
    setActiveFace: (faceId) =>
      ipcRenderer.invoke('avatar:set-active-face', faceId) as Promise<AvatarFaceDetail | null>,
    uploadFace: (payload) =>
      ipcRenderer.invoke('avatar:upload-face', payload) as Promise<AvatarUploadResult>,
    deleteFace: async (faceId) => {
      await ipcRenderer.invoke('avatar:delete-face', faceId);
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
