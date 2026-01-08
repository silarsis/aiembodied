import { contextBridge, ipcRenderer } from 'electron';
import type { ConfigSecretKey, RendererConfig } from './config/config-manager.js';
import type { AudioDevicePreferences } from './config/preferences-store.js';
import type {
  AvatarModelSummary,
  AvatarModelUploadRequest,
  AvatarModelUploadResult,
  AvatarAnimationSummary,
  AvatarAnimationUploadRequest,
  AvatarAnimationUploadResult,
  AvatarAnimationGenerationRequest,
  AvatarPoseSummary,
  AvatarPoseUploadRequest,
  AvatarPoseUploadResult,
  AvatarPoseGenerationRequest,
  PoseEvaluationRequest,
  PoseEvaluationResult,
  SpeechMovementRequest,
  MovementTimeline,
  StreamingPoseRequest,
  SinglePoseResult,
  FastPoseRequest,
  FastPoseResult,
} from './avatar/types.js';
import type {
  ConversationAppendMessagePayload,
  ConversationHistory,
  ConversationMessage,
  ConversationSession,
} from './conversation/types.js';
import type { WakeWordDetectionEvent } from './wake-word/types.js';
import type { LatencyMetricName } from './metrics/types.js';
import type { RealtimeEphemeralTokenRequest, RealtimeEphemeralTokenResponse } from './realtime/types.js';
import type {
  MCPServerConfig,
  MCPServerConfigInput,
  MCPToolSummary,
  MCPConnectionResult,
  MCPToolResult,
} from './mcp/types.js';
import type { OpenAIFunction } from './tools/tool-registry.js';

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
  realtime: RealtimeBridge;
  wakeWord: WakeWordBridge;
  conversation?: ConversationBridge;
  metrics?: MetricsBridge;
  avatar?: AvatarBridge;
  camera?: CameraBridge;
  mcp: MCPBridge;
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

export interface RealtimeBridge {
  mintEphemeralToken(request: RealtimeEphemeralTokenRequest): Promise<RealtimeEphemeralTokenResponse>;
}

export interface AvatarBridge {
  listModels(): Promise<AvatarModelSummary[]>;
  getActiveModel(): Promise<AvatarModelSummary | null>;
  setActiveModel(modelId: string | null): Promise<AvatarModelSummary | null>;
  uploadModel(request: AvatarModelUploadRequest): Promise<AvatarModelUploadResult>;
  deleteModel(modelId: string): Promise<void>;
  loadModelBinary(modelId: string): Promise<ArrayBuffer>;
  updateModelThumbnail(modelId: string, thumbnailDataUrl: string): Promise<AvatarModelSummary | null>;
  updateModelDescription(modelId: string, description: string): Promise<AvatarModelSummary | null>;
  generateModelDescription(thumbnailDataUrl: string): Promise<string>;
  listAnimations(): Promise<AvatarAnimationSummary[]>;
  uploadAnimation(request: AvatarAnimationUploadRequest): Promise<AvatarAnimationUploadResult>;
  generateAnimation(request: AvatarAnimationGenerationRequest): Promise<AvatarAnimationUploadResult>;
  deleteAnimation(animationId: string): Promise<void>;
  renameAnimation(animationId: string, newName: string): Promise<AvatarAnimationSummary>;
  loadAnimationBinary(animationId: string): Promise<ArrayBuffer>;
  triggerBehaviorCue(cue: string): Promise<void>;
  listPoses(): Promise<AvatarPoseSummary[]>;
  uploadPose(payload: AvatarPoseUploadRequest): Promise<AvatarPoseUploadResult>;
  generatePose(request: AvatarPoseGenerationRequest): Promise<AvatarPoseUploadResult>;
  deletePose(poseId: string): Promise<void>;
  loadPose(poseId: string): Promise<unknown>;
  evaluatePose(request: PoseEvaluationRequest): Promise<PoseEvaluationResult>;
  refinePose(request: PoseEvaluationRequest): Promise<AvatarPoseUploadResult>;
  generateMovementTimeline(request: SpeechMovementRequest): Promise<MovementTimeline>;
  generateSinglePose(request: StreamingPoseRequest): Promise<SinglePoseResult>;
  generateFastPose(request: FastPoseRequest): Promise<FastPoseResult>;
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

export interface ServerStatusEvent {
  serverId: string;
  status: 'connected' | 'disconnected' | 'error';
}

export interface MCPBridge {
  // Server management
  listServers(): Promise<MCPServerConfig[]>;
  addServer(config: MCPServerConfigInput): Promise<MCPServerConfig>;
  updateServer(id: string, updates: Partial<MCPServerConfigInput>): Promise<MCPServerConfig>;
  deleteServer(id: string): Promise<void>;
  connectServer(id: string): Promise<MCPConnectionResult>;
  disconnectServer(id: string): Promise<void>;
  testConnection(id: string): Promise<MCPConnectionResult>;

  // Tool management
  listTools(serverId?: string): Promise<MCPToolSummary[]>;
  updateToolPreferences(
    toolId: string,
    prefs: {
      enabled?: boolean;
      confirmationLevel?: string;
      customDescription?: string;
    },
  ): Promise<void>;

  // Tool execution (for manual testing)
  executeTool(toolId: string, params: unknown): Promise<MCPToolResult>;

  // Events
  onServerStatusChanged(callback: (event: ServerStatusEvent) => void): () => void;
  onToolsDiscovered(callback: (serverId: string, count: number) => void): () => void;

  // LLM integration
  getToolDefinitionsForLLM(): Promise<OpenAIFunction[]>;
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
  realtime: {
    mintEphemeralToken: (request) =>
      ipcRenderer.invoke('realtime:mint-ephemeral-token', request) as Promise<RealtimeEphemeralTokenResponse>,
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
      const payload: unknown = await ipcRenderer.invoke('avatar-model:load', modelId);
      return cloneBinaryPayload(payload, {
        id: modelId,
        errorMessage: 'Unexpected VRM binary payload received from main process.',
      });
    },
    updateModelThumbnail: (modelId, thumbnailDataUrl) =>
      ipcRenderer.invoke('avatar-model:update-thumbnail', {
        modelId,
        thumbnailDataUrl,
      }) as Promise<AvatarModelSummary | null>,
    updateModelDescription: (modelId, description) =>
      ipcRenderer.invoke('avatar-model:update-description', {
        modelId,
        description,
      }) as Promise<AvatarModelSummary | null>,
    generateModelDescription: (thumbnailDataUrl) =>
      ipcRenderer.invoke('avatar-model:generate-description', {
        thumbnailDataUrl,
      }) as Promise<string>,
    listAnimations: () => ipcRenderer.invoke('avatar-animation:list') as Promise<AvatarAnimationSummary[]>,
    uploadAnimation: (payload) =>
      ipcRenderer.invoke('avatar-animation:upload', payload) as Promise<AvatarAnimationUploadResult>,
    generateAnimation: (payload: AvatarAnimationGenerationRequest) =>
      ipcRenderer.invoke('avatar-animation:generate', payload) as Promise<AvatarAnimationUploadResult>,
    deleteAnimation: async (animationId) => {
      await ipcRenderer.invoke('avatar-animation:delete', animationId);
    },
    renameAnimation: async (animationId, newName) =>
      ipcRenderer.invoke('avatar-animation:rename', animationId, newName) as Promise<AvatarAnimationSummary>,
    loadAnimationBinary: async (animationId) => {
      const payload: unknown = await ipcRenderer.invoke('avatar-animation:load', animationId);
      return cloneBinaryPayload(payload, {
        id: animationId,
        errorMessage: 'Unexpected VRMA binary payload received from main process.',
      });
    },
    triggerBehaviorCue: async (cue) => {
      await ipcRenderer.invoke('avatar:trigger-behavior', cue);
    },
    listPoses: () => ipcRenderer.invoke('avatar-pose:list') as Promise<AvatarPoseSummary[]>,
    uploadPose: (payload: AvatarPoseUploadRequest) =>
      ipcRenderer.invoke('avatar-pose:upload', payload) as Promise<AvatarPoseUploadResult>,
    generatePose: (payload: AvatarPoseGenerationRequest) =>
      ipcRenderer.invoke('avatar-pose:generate', payload) as Promise<AvatarPoseUploadResult>,
    deletePose: async (poseId: string) => {
      await ipcRenderer.invoke('avatar-pose:delete', poseId);
    },
    loadPose: async (poseId: string) => {
      return ipcRenderer.invoke('avatar-pose:load', poseId) as Promise<unknown>;
    },
    evaluatePose: (payload: PoseEvaluationRequest) =>
      ipcRenderer.invoke('avatar-pose:evaluate', payload) as Promise<PoseEvaluationResult>,
    refinePose: (payload: PoseEvaluationRequest) =>
      ipcRenderer.invoke('avatar-pose:refine', payload) as Promise<AvatarPoseUploadResult>,
    generateMovementTimeline: (payload: SpeechMovementRequest) =>
      ipcRenderer.invoke('avatar-movement:generate', payload) as Promise<MovementTimeline>,
    generateSinglePose: (payload: StreamingPoseRequest) =>
      ipcRenderer.invoke('avatar-movement:generate-single', payload) as Promise<SinglePoseResult>,
    generateFastPose: (payload: FastPoseRequest) =>
      ipcRenderer.invoke('avatar-movement:generate-fast', payload) as Promise<FastPoseResult>,
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
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:list-servers') as Promise<MCPServerConfig[]>,
    addServer: (config) => ipcRenderer.invoke('mcp:add-server', config) as Promise<MCPServerConfig>,
    updateServer: (id, updates) =>
      ipcRenderer.invoke('mcp:update-server', id, updates) as Promise<MCPServerConfig>,
    deleteServer: (id) => ipcRenderer.invoke('mcp:delete-server', id) as Promise<void>,
    connectServer: (id) => ipcRenderer.invoke('mcp:connect-server', id) as Promise<MCPConnectionResult>,
    disconnectServer: (id) => ipcRenderer.invoke('mcp:disconnect-server', id) as Promise<void>,
    testConnection: (id) => ipcRenderer.invoke('mcp:test-connection', id) as Promise<MCPConnectionResult>,

    listTools: (serverId?) => ipcRenderer.invoke('mcp:list-tools', serverId) as Promise<MCPToolSummary[]>,
    updateToolPreferences: (toolId, prefs) =>
      ipcRenderer.invoke('mcp:update-tool-preferences', toolId, prefs) as Promise<void>,
    executeTool: (toolId, params) =>
      ipcRenderer.invoke('mcp:execute-tool', toolId, params) as Promise<MCPToolResult>,

    onServerStatusChanged: (callback) => {
      const channel = 'mcp:server-status-changed';
      const handler = (_event: unknown, event: ServerStatusEvent) => callback(event);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },

    onToolsDiscovered: (callback) => {
      const channel = 'mcp:tools-discovered';
      const handler = (_event: unknown, serverId: string, count: number) => callback(serverId, count);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },

    getToolDefinitionsForLLM: () => ipcRenderer.invoke('mcp:get-tool-definitions') as Promise<OpenAIFunction[]>,
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
