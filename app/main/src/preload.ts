import type { BackgroundBridge } from './backgrounds/types.js';
import { contextBridge, ipcRenderer } from 'electron';
import type { ConfigSecretKey, ModelRoutingView, RendererConfig } from './config/config-manager.js';
import type { ModelRoute, ServerType, UseId } from './config/model-routing.js';
import type { ServerProbe } from './config/model-server-probe.js';
import type { BaseModelSuggestions, CivitaiLookup } from './avatar/generation/civitai.js';
import type { HfLookup } from './local-llm/huggingface.js';
import type { LlmDownload, LocalLlmList } from './local-llm/llm-library.js';
import type { ModelDownload } from './avatar/generation/model-downloads.js';
import type { AudioDevicePreferences } from './config/preferences-store.js';
import type { ProviderSettingsPatch } from './config/provider-settings.js';
import type {
  AvatarModelSummary,
  AvatarModelUploadRequest,
  AvatarModelUploadResult,
  AvatarAnimationSummary,
  AvatarAnimationUploadRequest,
  AvatarAnimationUploadResult,
  AvatarAnimationGenerationRequest,
  AvatarMotionChunkEvent,
  AvatarMotionStatus,
  AvatarMotionStreamRequest,
  AvatarMotionStreamResult,
  AvatarPoseSummary,
  AvatarPoseUploadRequest,
  AvatarPoseUploadResult,
  AvatarPoseGenerationRequest,
  PoseEvaluationRequest,
  PoseEvaluationResult,
  AvatarImageModelSelection,
  AvatarLoraChoice,
  AvatarCharacterModelSelection,
  AvatarGenerationRequest,
  AvatarGenerationJob,
  AvatarGenerationStatus,
  AvatarGenerationConfirmation,
  AvatarGenerationAcceptance,
} from './avatar/types.js';
import type {
  ConversationAppendMessagePayload,
  ConversationHistory,
  ConversationMessage,
  ConversationSession,
} from './conversation/types.js';
import type {
  WakeWordDetectionEvent,
  WakeWordOption,
  WakeWordTrainingStatus,
} from './wake-word/types.js';
import type { PushToTalkStatus, TalkTriggerEvent } from './talk/types.js';
import type { LatencyMetricName } from './metrics/types.js';
import type { RealtimeEphemeralTokenRequest, RealtimeEphemeralTokenResponse } from './realtime/types.js';
import type {
  LocalVoiceEvent,
  LocalVoiceRespondRequest,
  LocalVoiceRespondResult,
  LocalVoiceStatus,
  LocalVoiceTranscribeResult,
} from './local-voice/types.js';
import type {
  MCPServerConfig,
  MCPServerConfigInput,
  MCPToolSummary,
  MCPConnectionResult,
  MCPToolResult,
} from './mcp/types.js';
import type { OpenAIFunction } from './tools/tool-registry.js';
import type { MemoryEngineBridge } from './memory-engine/bridge-types.js';
import type { GpuMemoryBridge } from './diagnostics/gpu-memory.js';

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
  clearSecret(key: ConfigSecretKey): Promise<RendererConfig>;
  setProviderSettings(patch: ProviderSettingsPatch): Promise<RendererConfig>;
}

/** The Models and servers pop-up. Keys are sent in, never read back. */
export interface ModelsBridge {
  get(): Promise<ModelRoutingView>;
  probe(target: { serverId: string } | { draft: { type: ServerType; url: string; key?: string } }): Promise<ServerProbe>;
  saveServer(server: { id?: string; name?: string; type?: ServerType; url?: string; key?: string }): Promise<{ id: string; models: ModelRoutingView }>;
  removeServer(id: string): Promise<ModelRoutingView>;
  setRoute(use: UseId, route: ModelRoute): Promise<ModelRoutingView>;
  setKey(serverId: string, key: string): Promise<ModelRoutingView>;
  civitaiLookup?(ref: string, versionId?: number): Promise<CivitaiLookup>;
  download?(serverId: string, ref: string, versionId?: number): Promise<ModelDownload>;
  downloads?(): Promise<ModelDownload[]>;
  cancelDownload?(id: string): Promise<ModelDownload[]>;
  comfyAddon?(serverId: string): Promise<{ installed: boolean; folder: string }>;
  /** Thinking models from Hugging Face for this PC's llama-server. */
  hfLookup?(ref: string): Promise<HfLookup>;
  hfDownload?(repo: string, quant: string, use: boolean): Promise<LlmDownload>;
  hfDownloads?(): Promise<LlmDownload[]>;
  hfCancel?(id: string): Promise<LlmDownload[]>;
  localLlms?(): Promise<LocalLlmList>;
  /** Run a downloaded model for Thinking (null: llama-server's default) and restart llama-server. */
  useLocalLlm?(id: string | null): Promise<{ message: string; library: LocalLlmList; models: ModelRoutingView }>;
  deleteLocalLlm?(id: string): Promise<LocalLlmList>;
}

export interface PreloadApi {
  backgrounds?: BackgroundBridge;
  models?: ModelsBridge;
  config: ConfigBridge;
  realtime: RealtimeBridge;
  localVoice?: LocalVoiceBridge;
  wakeWord: WakeWordBridge;
  talk?: TalkBridge;
  conversation?: ConversationBridge;
  metrics?: MetricsBridge;
  avatar?: AvatarBridge;
  camera?: CameraBridge;
  mcp: MCPBridge;
  memoryEngine?: MemoryEngineBridge;
  gpuMemory?: GpuMemoryBridge;
  app?: AppBridge;
  ping(): string;
  __bridgeReady?: boolean;
  __bridgeVersion?: string;
}

export interface WakeWordBridge {
  setListeningEnabled?(enabled: boolean): Promise<void>;
  onWake(listener: (event: WakeWordDetectionEvent) => void): () => void;
  /** Peak score of each burst of activity, including near misses below the threshold. */
  onPeak?(listener: (event: WakeWordDetectionEvent) => void): () => void;
  /** The bundled wake words and the ones trained in the app. */
  list?(): Promise<WakeWordOption[]>;
  getTrainingStatus?(): Promise<WakeWordTrainingStatus>;
  /** Start training a new wake word in WSL; it takes a few hours and carries on if the app closes. */
  train?(phrase: string, options?: { quick?: boolean }): Promise<WakeWordTrainingStatus>;
  cancelTraining?(): Promise<WakeWordTrainingStatus>;
  onTrainingStatus?(listener: (status: WakeWordTrainingStatus) => void): () => void;
}

export interface TalkBridge {
  /** The global push-to-talk key was pressed. */
  onTrigger(listener: (event: TalkTriggerEvent) => void): () => void;
  getShortcutStatus(): Promise<PushToTalkStatus>;
  onShortcutStatus(listener: (status: PushToTalkStatus) => void): () => void;
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

export interface LocalVoiceBridge {
  getStatus(): Promise<LocalVoiceStatus>;
  /** Transcribe one utterance (16-bit PCM WAV). */
  transcribe(wav: ArrayBuffer): Promise<LocalVoiceTranscribeResult>;
  /** Generate and speak a reply; sentences arrive through onEvent before this resolves. */
  respond(request: LocalVoiceRespondRequest): Promise<LocalVoiceRespondResult>;
  cancel(requestId?: string): Promise<void>;
  resetHistory(): Promise<void>;
  onEvent(listener: (event: LocalVoiceEvent) => void): () => void;
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
  getVoicePreference(): Promise<string | null>;
  setVoicePreference(voice: string): Promise<void>;
  listAnimations(): Promise<AvatarAnimationSummary[]>;
  uploadAnimation(request: AvatarAnimationUploadRequest): Promise<AvatarAnimationUploadResult>;
  generateAnimation(request: AvatarAnimationGenerationRequest): Promise<AvatarAnimationUploadResult>;
  getMotionStatus(): Promise<AvatarMotionStatus>;
  streamMotion(request: AvatarMotionStreamRequest): Promise<AvatarMotionStreamResult>;
  onMotionChunk(listener: (chunk: AvatarMotionChunkEvent) => void): () => void;
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
  listAvatarImageModels(): Promise<AvatarImageModelSelection>;
  setAvatarImageModel(id: string): Promise<void>;
  setAvatarImageLoras(choices: AvatarLoraChoice[]): Promise<void>;
  suggestBaseModels(request: { baseModel?: string; family?: string }): Promise<BaseModelSuggestions>;
  downloadBaseModel(serverId: string, ref: string): Promise<ModelDownload>;
  listModelDownloads(): Promise<ModelDownload[]>;
  generateAvatar(request: AvatarGenerationRequest): Promise<AvatarGenerationJob>;
  getAvatarGenerationStatus(jobId: string): Promise<AvatarGenerationStatus>;
  confirmAvatarConcept(jobId: string, confirmation?: AvatarGenerationConfirmation): Promise<void>;
  loadGeneratedAvatarPreview(jobId: string): Promise<ArrayBuffer>;
  acceptGeneratedAvatar(jobId: string): Promise<AvatarGenerationAcceptance>;
  rejectGeneratedAvatar(jobId: string): Promise<void>;
  listAvatarGenerationJobs(): Promise<AvatarGenerationStatus[]>;
  cancelAvatarGeneration(jobId: string): Promise<void>;
  removeAvatarBackground(jobId: string): Promise<void>;
  restoreAvatarBackground(jobId: string): Promise<void>;
  redrawAvatarViews(jobId: string): Promise<void>;
  listAvatarCharacterModels(): Promise<AvatarCharacterModelSelection>;
  setAvatarCharacterModel(stage: 'geometry' | 'rig', id: string): Promise<void>;
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

export interface AppBridge {
  quit(): Promise<void>;
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
    clearSecret: (key) => ipcRenderer.invoke('config:clear-secret', key) as Promise<RendererConfig>,
    setProviderSettings: (patch) => ipcRenderer.invoke('config:set-providers', patch) as Promise<RendererConfig>,
    setAudioDevicePreferences: (preferences) =>
      ipcRenderer.invoke('config:set-audio-devices', preferences) as Promise<RendererConfig>,
  },
  models: {
    get: () => ipcRenderer.invoke('models:get') as Promise<ModelRoutingView>,
    probe: (target) => ipcRenderer.invoke('models:probe', target) as Promise<ServerProbe>,
    saveServer: (server) => ipcRenderer.invoke('models:save-server', server) as Promise<{ id: string; models: ModelRoutingView }>,
    removeServer: (id) => ipcRenderer.invoke('models:remove-server', id) as Promise<ModelRoutingView>,
    setRoute: (use, route) => ipcRenderer.invoke('models:set-route', { use, route }) as Promise<ModelRoutingView>,
    setKey: (serverId, key) => ipcRenderer.invoke('models:set-key', { serverId, key }) as Promise<ModelRoutingView>,
    civitaiLookup: (ref, versionId) => ipcRenderer.invoke('models:civitai-lookup', { ref, versionId }) as Promise<CivitaiLookup>,
    download: (serverId, ref, versionId) => ipcRenderer.invoke('models:download', { serverId, ref, versionId }) as Promise<ModelDownload>,
    downloads: () => ipcRenderer.invoke('models:downloads') as Promise<ModelDownload[]>,
    cancelDownload: (id) => ipcRenderer.invoke('models:cancel-download', id) as Promise<ModelDownload[]>,
    comfyAddon: (serverId) => ipcRenderer.invoke('models:comfy-addon', serverId) as Promise<{ installed: boolean; folder: string }>,
    hfLookup: (ref) => ipcRenderer.invoke('models:hf-lookup', ref) as Promise<HfLookup>,
    hfDownload: (repo, quant, use) => ipcRenderer.invoke('models:hf-download', { repo, quant, use }) as Promise<LlmDownload>,
    hfDownloads: () => ipcRenderer.invoke('models:hf-downloads') as Promise<LlmDownload[]>,
    hfCancel: (id) => ipcRenderer.invoke('models:hf-cancel', id) as Promise<LlmDownload[]>,
    localLlms: () => ipcRenderer.invoke('models:local-llms') as Promise<LocalLlmList>,
    useLocalLlm: (id) => ipcRenderer.invoke('models:use-local-llm', id) as Promise<{ message: string; library: LocalLlmList; models: ModelRoutingView }>,
    deleteLocalLlm: (id) => ipcRenderer.invoke('models:delete-local-llm', id) as Promise<LocalLlmList>,
  },
  realtime: {
    mintEphemeralToken: (request) =>
      ipcRenderer.invoke('realtime:mint-ephemeral-token', request) as Promise<RealtimeEphemeralTokenResponse>,
  },
  localVoice: {
    getStatus: () => ipcRenderer.invoke('local-voice:status') as Promise<LocalVoiceStatus>,
    transcribe: (wav) => ipcRenderer.invoke('local-voice:transcribe', wav) as Promise<LocalVoiceTranscribeResult>,
    respond: (request) => ipcRenderer.invoke('local-voice:respond', request) as Promise<LocalVoiceRespondResult>,
    cancel: async (requestId) => {
      await ipcRenderer.invoke('local-voice:cancel', requestId);
    },
    resetHistory: async () => {
      await ipcRenderer.invoke('local-voice:reset');
    },
    onEvent: (listener) => {
      const channel = 'local-voice:event';
      const handler = (_event: unknown, payload: LocalVoiceEvent) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
  },
  wakeWord: {
    setListeningEnabled: async (enabled: boolean) => { await ipcRenderer.invoke('wake-word:set-listening', enabled); },
    onWake: (listener) => {
      const channel = 'wake-word:event';
      const handler = (_event: unknown, payload: WakeWordDetectionEvent) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
    onPeak: (listener) => {
      const channel = 'wake-word:peak';
      const handler = (_event: unknown, payload: WakeWordDetectionEvent) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
    list: () => ipcRenderer.invoke('wake-word:list') as Promise<WakeWordOption[]>,
    getTrainingStatus: () => ipcRenderer.invoke('wake-word:get-training-status') as Promise<WakeWordTrainingStatus>,
    train: (phrase, options) =>
      ipcRenderer.invoke('wake-word:train', { phrase, quick: options?.quick === true }) as Promise<WakeWordTrainingStatus>,
    cancelTraining: () => ipcRenderer.invoke('wake-word:cancel-training') as Promise<WakeWordTrainingStatus>,
    onTrainingStatus: (listener) => {
      const channel = 'wake-word:training-status';
      const handler = (_event: unknown, payload: WakeWordTrainingStatus) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
  },
  talk: {
    onTrigger: (listener) => {
      const channel = 'talk:trigger';
      const handler = (_event: unknown, payload: TalkTriggerEvent) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
    getShortcutStatus: () => ipcRenderer.invoke('talk:get-shortcut-status') as Promise<PushToTalkStatus>,
    onShortcutStatus: (listener) => {
      const channel = 'talk:shortcut-status';
      const handler = (_event: unknown, payload: PushToTalkStatus) => listener(payload);
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
  backgrounds: {
    list: () => ipcRenderer.invoke('background:list'),
    getActive: () => ipcRenderer.invoke('background:get-active'),
    setActive: (id) => ipcRenderer.invoke('background:set-active', id),
    load: (id) => ipcRenderer.invoke('background:load', id),
    generate: (prompt) => ipcRenderer.invoke('background:generate', prompt),
    delete: (id) => ipcRenderer.invoke('background:delete', id),
  },
  avatar: {
    listModels: () => ipcRenderer.invoke('avatar-model:list') as Promise<AvatarModelSummary[]>,
    getActiveModel: () => ipcRenderer.invoke('avatar-model:get-active') as Promise<AvatarModelSummary | null>,
    setActiveModel: (modelId) =>
      ipcRenderer.invoke('avatar-model:set-active', modelId) as Promise<AvatarModelSummary | null>,
    getVoicePreference: () => ipcRenderer.invoke('avatar:voice:get-preference') as Promise<string | null>,
    setVoicePreference: (voice) => ipcRenderer.invoke('avatar:voice:set-preference', voice) as Promise<void>,
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
    getMotionStatus: () => ipcRenderer.invoke('avatar-motion:status') as Promise<AvatarMotionStatus>,
    streamMotion: (payload: AvatarMotionStreamRequest) =>
      ipcRenderer.invoke('avatar-motion:stream', payload) as Promise<AvatarMotionStreamResult>,
    onMotionChunk: (listener) => {
      const channel = 'avatar-motion:chunk';
      const handler = (_event: unknown, payload: AvatarMotionChunkEvent) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
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
    listAvatarImageModels: () => ipcRenderer.invoke('avatar:image-models') as Promise<AvatarImageModelSelection>,
    setAvatarImageModel: async (id: string) => { await ipcRenderer.invoke('avatar:image-model-select', id); },
    setAvatarImageLoras: async (choices: AvatarLoraChoice[]) => { await ipcRenderer.invoke('avatar:image-loras-select', choices); },
    suggestBaseModels: (request: { baseModel?: string; family?: string }) =>
      ipcRenderer.invoke('avatar:base-model-suggestions', request) as Promise<BaseModelSuggestions>,
    downloadBaseModel: (serverId: string, ref: string) => ipcRenderer.invoke('models:download', { serverId, ref }) as Promise<ModelDownload>,
    listModelDownloads: () => ipcRenderer.invoke('models:downloads') as Promise<ModelDownload[]>,
    generateAvatar: (payload: AvatarGenerationRequest) =>
      ipcRenderer.invoke('avatar:generation-start', payload) as Promise<AvatarGenerationJob>,
    confirmAvatarConcept: async (jobId: string, confirmation?: AvatarGenerationConfirmation) => { await ipcRenderer.invoke('avatar:generation-confirm-concept', jobId, ...(confirmation ? [confirmation] : [])); },
    getAvatarGenerationStatus: (jobId: string) =>
      ipcRenderer.invoke('avatar:generation-status', jobId) as Promise<AvatarGenerationStatus>,
    loadGeneratedAvatarPreview: async (jobId: string) => {
      const payload: unknown = await ipcRenderer.invoke('avatar:generation-preview', jobId);
      return cloneBinaryPayload(payload, {
        id: jobId,
        errorMessage: 'Unexpected generated VRM preview payload received from main process.',
      });
    },
    acceptGeneratedAvatar: (jobId: string) =>
      ipcRenderer.invoke('avatar:generation-accept', jobId) as Promise<AvatarGenerationAcceptance>,
    rejectGeneratedAvatar: async (jobId: string) => {
      await ipcRenderer.invoke('avatar:generation-reject', jobId);
    },
    listAvatarGenerationJobs: () =>
      ipcRenderer.invoke('avatar:generation-list') as Promise<AvatarGenerationStatus[]>,
    removeAvatarBackground: async (jobId: string) => { await ipcRenderer.invoke('avatar:generation-remove-background', jobId); },
    restoreAvatarBackground: async (jobId: string) => { await ipcRenderer.invoke('avatar:generation-restore-background', jobId); },
    redrawAvatarViews: async (jobId: string) => { await ipcRenderer.invoke('avatar:generation-redraw-views', jobId); },
    cancelAvatarGeneration: async (jobId: string) => {
      await ipcRenderer.invoke('avatar:generation-cancel', jobId);
    },
    listAvatarCharacterModels: () =>
      ipcRenderer.invoke('avatar:character-models') as Promise<AvatarCharacterModelSelection>,
    setAvatarCharacterModel: async (stage: 'geometry' | 'rig', id: string) => {
      await ipcRenderer.invoke('avatar:character-model-select', stage, id);
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
  gpuMemory: {
    read: () => ipcRenderer.invoke('diagnostics:gpu-memory'),
  },
  memoryEngine: {
    status: () => ipcRenderer.invoke('memory-engine:status'),
    search: (query, period) => ipcRenderer.invoke('memory-engine:search', { query, ...period }),
    timeline: (from, to) => ipcRenderer.invoke('memory-engine:timeline', { from, to }),
    memory: (id, around) => ipcRenderer.invoke('memory-engine:memory', { id, around }),
    facts: (options) => ipcRenderer.invoke('memory-engine:facts', options ?? {}),
    addFact: (fact) => ipcRenderer.invoke('memory-engine:add-fact', fact),
    updateFact: (id, patch) => ipcRenderer.invoke('memory-engine:update-fact', { id, patch }),
    reviewFacts: (ids) => ipcRenderer.invoke('memory-engine:review-facts', ids),
    deleteFact: (id) => ipcRenderer.invoke('memory-engine:delete-fact', id),
    forgetSession: (id) => ipcRenderer.invoke('memory-engine:forget-session', id),
    recallLog: (limit) => ipcRenderer.invoke('memory-engine:recall-log', { limit }),
    runSummaries: () => ipcRenderer.invoke('memory-engine:run-summaries'),
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
  app: {
    quit: async () => {
      await ipcRenderer.invoke('app:quit');
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
