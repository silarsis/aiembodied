import { contextBridge, ipcRenderer } from 'electron';
import type { ConfigSecretKey, RendererConfig } from './config/config-manager.js';
import type { AudioDevicePreferences } from './config/preferences-store.js';
import type {
  AvatarDisplayMode,
  AvatarFaceDetail,
  AvatarFaceSummary,
  AvatarUploadRequest,
  AvatarUploadResult,
  AvatarGenerationResult,
  AvatarModelSummary,
  AvatarModelUploadRequest,
  AvatarModelUploadResult,
  AvatarAnimationSummary,
  AvatarAnimationUploadRequest,
  AvatarAnimationUploadResult,
  AvatarAnimationGenerationRequest,
} from './avatar/types.js';
import type {
  ConversationAppendMessagePayload,
  ConversationHistory,
  ConversationMessage,
  ConversationSession,
} from './conversation/types.js';
import type { WakeWordDetectionEvent } from './wake-word/types.js';
import type { LatencyMetricName } from './metrics/types.js';

function logPreloadMessage(
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
) {
  const prefix = `[preload bridge] ${message}`;
  try {
    if (meta) {
      if (level === 'info') {
        console.info(prefix, meta);
      } else if (level === 'warn') {
        console.warn(prefix, meta);
      } else {
        console.error(prefix, meta);
      }
    } else if (level === 'info') {
      console.info(prefix);
    } else if (level === 'warn') {
      console.warn(prefix);
    } else {
      console.error(prefix);
    }
  } catch {
    // Ignore logging errors — console may be unavailable in some contexts.
  }
}

function forwardPreloadDiagnostics(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
  try {
    ipcRenderer.send('diagnostics:preload-log', {
      level,
      message,
      meta,
      ts: Date.now(),
    });
  } catch {
    // ignore IPC forwarding errors
  }
}

const logPreloadInfo = (message: string, meta?: Record<string, unknown>) => {
  logPreloadMessage('info', message, meta);
  forwardPreloadDiagnostics('info', message, meta);
};
const logPreloadError = (message: string, meta?: Record<string, unknown>) => {
  logPreloadMessage('error', message, meta);
  forwardPreloadDiagnostics('error', message, meta);
};

function cloneBinaryPayload(
  payload: unknown,
  context: { id: string; errorMessage: string },
): ArrayBuffer {
  const sharedArrayBufferCtor = typeof SharedArrayBuffer === 'undefined' ? null : SharedArrayBuffer;

  const cloneFromView = (view: ArrayBufferView): ArrayBuffer => {
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return copy.buffer;
  };

  if (payload instanceof ArrayBuffer) {
    return payload.slice(0);
  }

  if (sharedArrayBufferCtor && payload instanceof sharedArrayBufferCtor) {
    const view = new Uint8Array(payload);
    const copy = new Uint8Array(view.length);
    copy.set(view);
    return copy.buffer;
  }

  if (ArrayBuffer.isView(payload)) {
    return cloneFromView(payload as ArrayBufferView);
  }

  if (payload && typeof payload === 'object' && 'data' in (payload as { data?: unknown })) {
    const dataField = (payload as { data?: unknown }).data;
    if (typeof dataField === 'object' && dataField && ArrayBuffer.isView(dataField)) {
      return cloneFromView(dataField as ArrayBufferView);
    }
  }

  logPreloadError(context.errorMessage, { id: context.id, payloadType: typeof payload });
  throw new Error(context.errorMessage);
}

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
  camera?: CameraBridge;
  ping(): string;
  __bridgeReady?: boolean;
  __bridgeVersion?: string;
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
  generateFace(request: AvatarUploadRequest): Promise<AvatarGenerationResult>;
  applyGeneratedFace(generationId: string, candidateId: string, name?: string): Promise<AvatarUploadResult>;
  deleteFace(faceId: string): Promise<void>;
  listModels(): Promise<AvatarModelSummary[]>;
  getActiveModel(): Promise<AvatarModelSummary | null>;
  setActiveModel(modelId: string | null): Promise<AvatarModelSummary | null>;
  uploadModel(request: AvatarModelUploadRequest): Promise<AvatarModelUploadResult>;
  deleteModel(modelId: string): Promise<void>;
  loadModelBinary(modelId: string): Promise<ArrayBuffer>;
  listAnimations(): Promise<AvatarAnimationSummary[]>;
  uploadAnimation(request: AvatarAnimationUploadRequest): Promise<AvatarAnimationUploadResult>;
  generateAnimation(request: AvatarAnimationGenerationRequest): Promise<AvatarAnimationUploadResult>;
  deleteAnimation(animationId: string): Promise<void>;
  loadAnimationBinary(animationId: string): Promise<ArrayBuffer>;
  getDisplayModePreference(): Promise<AvatarDisplayMode>;
  setDisplayModePreference(mode: AvatarDisplayMode): Promise<void>;
  triggerBehaviorCue(cue: string): Promise<void>;
}

export interface CameraDetectionEvent {
  cue: string;
  timestamp?: number;
  confidence?: number;
  provider?: string;
  payload?: Record<string, unknown> | null;
}

export interface CameraBridge {
  onDetection(listener: (event: CameraDetectionEvent) => void): () => void;
  emitDetection(event: CameraDetectionEvent): Promise<void>;
}

const api: PreloadApi & { __bridgeReady: boolean; __bridgeVersion: string } = {
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
    generateFace: (payload) =>
      ipcRenderer.invoke('avatar:generate-face', payload) as Promise<AvatarGenerationResult>,
    applyGeneratedFace: (generationId, candidateId, name) =>
      ipcRenderer.invoke('avatar:apply-generated-face', { generationId, candidateId, name }) as Promise<AvatarUploadResult>,
    deleteFace: async (faceId) => {
      await ipcRenderer.invoke('avatar:delete-face', faceId);
    },
    listModels: () => ipcRenderer.invoke('avatar-model:list') as Promise<AvatarModelSummary[]>,
    getActiveModel: () => ipcRenderer.invoke('avatar-model:get-active') as Promise<AvatarModelSummary | null>,
    setActiveModel: (modelId) =>
      ipcRenderer.invoke('avatar-model:set-active', modelId) as Promise<AvatarModelSummary | null>,
    uploadModel: (payload) =>
      ipcRenderer.invoke('avatar-model:upload', payload) as Promise<AvatarModelUploadResult>,
    deleteModel: async (modelId) => {
      await ipcRenderer.invoke('avatar-model:delete', modelId);
    },
    loadModelBinary: async (modelId) => {
      const payload = await ipcRenderer.invoke('avatar-model:load', modelId);
      return cloneBinaryPayload(payload, {
        id: modelId,
        errorMessage: 'Unexpected VRM binary payload received from main process.',
      });
    },
    listAnimations: () => ipcRenderer.invoke('avatar-animation:list') as Promise<AvatarAnimationSummary[]>,
    uploadAnimation: (payload) =>
      ipcRenderer.invoke('avatar-animation:upload', payload) as Promise<AvatarAnimationUploadResult>,
    generateAnimation: (payload: AvatarAnimationGenerationRequest) =>
      ipcRenderer.invoke('avatar-animation:generate', payload) as Promise<AvatarAnimationUploadResult>,
    deleteAnimation: async (animationId) => {
      await ipcRenderer.invoke('avatar-animation:delete', animationId);
    },
    loadAnimationBinary: async (animationId) => {
      const payload = await ipcRenderer.invoke('avatar-animation:load', animationId);
      return cloneBinaryPayload(payload, {
        id: animationId,
        errorMessage: 'Unexpected VRMA binary payload received from main process.',
      });
    },
    getDisplayModePreference: () =>
      ipcRenderer.invoke('avatar:get-display-mode') as Promise<AvatarDisplayMode>,
    setDisplayModePreference: async (mode) => {
      await ipcRenderer.invoke('avatar:set-display-mode', mode);
    },
    triggerBehaviorCue: async (cue) => {
      await ipcRenderer.invoke('avatar:trigger-behavior', cue);
    },
  },
  camera: {
    onDetection: (listener) => {
      const channel = 'camera:detection';
      const handler = (_event: unknown, payload: CameraDetectionEvent) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
    emitDetection: async (event) => {
      await ipcRenderer.invoke('camera:emit-detection', event);
    },
  },
  ping: () => 'pong',
  __bridgeReady: true,
  __bridgeVersion: '1.0.0',
};

logPreloadInfo('Preparing to expose renderer bridge.', {
  keys: Object.keys(api),
  hasAvatarBridge: typeof api.avatar !== 'undefined',
  hasCameraBridge: typeof api.camera !== 'undefined',
});

function exposeBridge() {
  try {
    contextBridge.exposeInMainWorld('aiembodied', api);
    logPreloadInfo('Renderer bridge exposed successfully.', {
      keys: Object.keys(api),
      hasAvatarBridge: typeof api.avatar !== 'undefined',
      hasCameraBridge: typeof api.camera !== 'undefined',
      bridgeReady: api.__bridgeReady,
      bridgeVersion: api.__bridgeVersion,
    });
    forwardPreloadDiagnostics('info', 'preload:bridge-exposed', {
      keys: Object.keys(api),
      hasAvatarBridge: typeof api.avatar !== 'undefined',
      bridgeReady: api.__bridgeReady,
      bridgeVersion: api.__bridgeVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logPreloadError('Failed to expose renderer bridge.', { message });
    throw error;
  }
}

// Expose the bridge immediately; preload runs before DOM is ready but
// contextBridge is available and safe to use at this time.
try {
  exposeBridge();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logPreloadError('Bridge exposure failed at preload init.', { message });
}

declare global {
  interface Window {
    aiembodied: PreloadApi;
  }
}
