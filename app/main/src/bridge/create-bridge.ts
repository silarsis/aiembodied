/**
 * The renderer bridge (`window.aiembodied`), built from a transport.
 *
 * One list of every call and event the page can use, with no Electron import. The Electron preload builds it on
 * `ipcRenderer`; the web satellite builds the very same API on the room link (renderer/src/web-satellite). Keeping
 * one list means a new channel cannot be wired for one and forgotten for the other.
 */
import type { BackgroundBridge } from '../backgrounds/types.js';
import type { ConfigSecretKey, ModelRoutingView, RendererConfig } from '../config/config-manager.js';
import type { ModelRoute, ServerType, UseId } from '../config/model-routing.js';
import type { ServerProbe } from '../config/model-server-probe.js';
import type { BaseModelSuggestions, CivitaiLookup } from '../avatar/generation/civitai.js';
import type { HfLookup } from '../local-llm/huggingface.js';
import type { LocalLlmSettings } from '../local-llm/llm-settings.js';
import type { LlmDownload, LocalLlmList } from '../local-llm/llm-library.js';
import type { VisionStatus } from '../local-vision/vision-model.js';
import type { ModelDownload } from '../avatar/generation/model-downloads.js';
import type { AudioDevicePreferences } from '../config/preferences-store.js';
import type { ProviderSettingsPatch } from '../config/provider-settings.js';
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
} from '../avatar/types.js';
import type {
  ConversationAppendMessagePayload,
  ConversationHistory,
  ConversationMessage,
  ConversationSession,
} from '../conversation/types.js';
import type {
  WakeWordDetectionEvent,
  WakeWordOption,
  WakeWordTrainingStatus,
} from '../wake-word/types.js';
import type { PushToTalkStatus, TalkTriggerEvent } from '../talk/types.js';
import type { DeviceGateBridge, DeviceGateState, SatelliteBridge, SatelliteStatus } from '../satellite/bridge-types.js';
import type { LatencyMetricName } from '../metrics/types.js';
import type { RealtimeEphemeralTokenRequest, RealtimeEphemeralTokenResponse } from '../realtime/types.js';
import type {
  LocalVoiceEvent,
  LocalVoiceRespondRequest,
  LocalVoiceRespondResult,
  LocalVoiceStatus,
  LocalVoiceSystemStatus,
  LocalVoiceTranscribeResult,
  SpeakingVoiceOptions,
} from '../local-voice/types.js';
import type { ApprovalsBridge, ApprovalView } from '../tools/approvals-ipc.js';
import type { SpeechTtsEngine } from '../local-voice/speech-service-client.js';
import type {
  MCPServerConfig,
  MCPServerConfigInput,
  MCPToolSummary,
  MCPConnectionResult,
  MCPToolResult,
} from '../mcp/types.js';
import type { OpenAIFunction } from '../tools/tool-registry.js';
import type { MemoryEngineBridge } from '../memory-engine/bridge-types.js';
import type { SwitchboardBridge } from '../switchboard/bridge-types.js';
import type { AvatarProfile } from '../avatars/avatar-registry.js';
import type { AvatarIdlePersona, AvatarsBridge } from '../avatars/bridge-types.js';
import type { PresenceBridge } from '../presence/bridge-types.js';
import type { FloorBridge } from '../floor/bridge-types.js';
import type { PlacesBridge, PlacesSnapshot } from '../places/bridge-types.js';
import type { RoomHubBridge, RoomHubStatus } from '../room-hub/bridge-types.js';
import type { GpuMemoryBridge } from '../diagnostics/gpu-memory.js';
import type { CodingBridge, CodingBusy, CodingBusyBridge, CodingTasksBridge, RunnerEvent } from '../coding/bridge-types.js';
import type { CodingStatus, CodingView } from '../coding/coding-service.js';

/** What the bridge needs from the outside world: ask for an answer, and hear events. */
export interface BridgeTransport {
  /** Resolves with the answer. `any` as in Electron's own `ipcRenderer.invoke`: the typed API above says what it is. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  /** Listens for an event pushed on a channel. The listener gets the event's arguments. Returns the unsubscribe function. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(channel: string, listener: (...args: any[]) => void): () => void;
  /** One-way message, for transports that have one. */
  send?(channel: string, ...args: unknown[]): void;
}

export function cloneBinaryPayload(
  payload: unknown,
  context: { id: string; errorMessage: string },
  logError?: (message: string, meta?: Record<string, unknown>) => void,
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

  logError?.(context.errorMessage, { id: context.id, payloadType: typeof payload });
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
  /** A speech service's text-to-speech engines and models (null: it is down or too old). */
  speechEngines?(serverId: string): Promise<SpeechTtsEngine[] | null>;
  /** Download a Kitten model or Piper voice on a speech service; returns the updated list. */
  speechDownload?(serverId: string, engine: string, model: string): Promise<SpeechTtsEngine[] | null>;
  cancelDownload?(id: string): Promise<ModelDownload[]>;
  comfyAddon?(serverId: string): Promise<{ installed: boolean; folder: string }>;
  /** Thinking models from Hugging Face for this PC's llama-server. */
  hfLookup?(ref: string): Promise<HfLookup>;
  hfDownload?(repo: string, quant: string, use: boolean): Promise<LlmDownload>;
  hfDownloads?(): Promise<LlmDownload[]>;
  hfCancel?(id: string): Promise<LlmDownload[]>;
  /** The local vision model for Describe the avatar: download status, start a download (default model, or a link / owner/repo[:QUANT]), cancel. */
  visionStatus?(): Promise<VisionStatus>;
  visionDownload?(ref?: string): Promise<VisionStatus>;
  visionCancel?(): Promise<VisionStatus>;
  localLlms?(): Promise<LocalLlmList>;
  /**
   * Run a downloaded model for Thinking (null: llama-server's default) and restart llama-server.
   * With settings, the slots and per-slot context are saved first.
   */
  useLocalLlm?(id: string | null, settings?: Partial<LocalLlmSettings>): Promise<{ message: string; library: LocalLlmList; models: ModelRoutingView }>;
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
  switchboard?: SwitchboardBridge;
  presence?: PresenceBridge;
  floor?: FloorBridge;
  places?: PlacesBridge;
  roomHub?: RoomHubBridge;
  satellite?: SatelliteBridge;
  deviceGate?: DeviceGateBridge;
  avatars?: AvatarsBridge;
  coding?: CodingBridge;
  codingTasks?: CodingTasksBridge;
  codingBusy?: CodingBusyBridge;
  approvals?: ApprovalsBridge;
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
  /** Record an announcement made without a running conversation (the update note and Echo's reply). */
  announce(entry: { note?: string; reply?: string; ts?: number }): Promise<ConversationMessage[]>;
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
  /** `avatarId` picks whose reply is stopped (default: echo). */
  cancel(requestId?: string, avatarId?: string): Promise<void>;
  resetHistory(avatarId?: string): Promise<void>;
  /** The voices the active character can pick for the engine that speaks now. */
  /** The voices the speaking engine offers; `selected` is the named avatar's pick (the active character's without one). */
  getVoiceOptions?(avatarId?: string): Promise<SpeakingVoiceOptions>;
  /** Updates for Echo that are waiting to be spoken (from the coding agent). */
  systemStatus?(avatarId?: string): Promise<LocalVoiceSystemStatus>;
  /** An update is ready: run a system turn if the conversation is idle. */
  onSystemReady?(listener: (info?: { urgent: boolean; avatarId?: string }) => void): () => void;
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
  /** The character's voice for `engine` (kokoro, kitten, piper); without one, its OpenAI voice. */
  getVoicePreference(engine?: string, avatarId?: string): Promise<string | null>;
  setVoicePreference(voice: string, engine?: string, avatarId?: string): Promise<void>;
  /** The character's own personality prompt; null until it has one. */
  getPromptPreference(avatarId?: string): Promise<string | null>;
  setPromptPreference(prompt: string, avatarId?: string): Promise<void>;
  /** What the character likes to do when nobody is talking (at most 500 characters); empty until set. */
  getIdleHabits(avatarId?: string): Promise<string>;
  setIdleHabits(habits: string, avatarId?: string): Promise<void>;
  listAnimations(): Promise<AvatarAnimationSummary[]>;
  uploadAnimation(request: AvatarAnimationUploadRequest): Promise<AvatarAnimationUploadResult>;
  generateAnimation(request: AvatarAnimationGenerationRequest): Promise<AvatarAnimationUploadResult>;
  getMotionStatus(): Promise<AvatarMotionStatus>;
  streamMotion(request: AvatarMotionStreamRequest): Promise<AvatarMotionStreamResult>;
  /** Stops a running motion stream; its promise rejects. */
  cancelMotion(streamId: string): Promise<void>;
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

export function createBridge(
  transport: BridgeTransport,
  options: { logError?: (message: string, meta?: Record<string, unknown>) => void } = {},
): PreloadApi & { __bridgeReady: boolean; __bridgeVersion: string } {
  const cloneBinary = (payload: unknown, context: { id: string; errorMessage: string }): ArrayBuffer => cloneBinaryPayload(payload, context, options.logError);
  const api: PreloadApi & { __bridgeReady: boolean; __bridgeVersion: string } = {
    config: {
      get: () => transport.invoke('config:get') as Promise<RendererConfig>,
      getSecret: (key) => transport.invoke('config:get-secret', key) as Promise<string>,
      setSecret: (key, value) =>
        transport.invoke('config:set-secret', { key, value }) as Promise<RendererConfig>,
      testSecret: (key) =>
        transport.invoke('config:test-secret', key) as Promise<{ ok: boolean; message?: string }>,
      clearSecret: (key) => transport.invoke('config:clear-secret', key) as Promise<RendererConfig>,
      setProviderSettings: (patch) => transport.invoke('config:set-providers', patch) as Promise<RendererConfig>,
      setAudioDevicePreferences: (preferences) =>
        transport.invoke('config:set-audio-devices', preferences) as Promise<RendererConfig>,
    },
    models: {
      get: () => transport.invoke('models:get') as Promise<ModelRoutingView>,
      probe: (target) => transport.invoke('models:probe', target) as Promise<ServerProbe>,
      saveServer: (server) => transport.invoke('models:save-server', server) as Promise<{ id: string; models: ModelRoutingView }>,
      removeServer: (id) => transport.invoke('models:remove-server', id) as Promise<ModelRoutingView>,
      setRoute: (use, route) => transport.invoke('models:set-route', { use, route }) as Promise<ModelRoutingView>,
      setKey: (serverId, key) => transport.invoke('models:set-key', { serverId, key }) as Promise<ModelRoutingView>,
      civitaiLookup: (ref, versionId) => transport.invoke('models:civitai-lookup', { ref, versionId }) as Promise<CivitaiLookup>,
      download: (serverId, ref, versionId) => transport.invoke('models:download', { serverId, ref, versionId }) as Promise<ModelDownload>,
      downloads: () => transport.invoke('models:downloads') as Promise<ModelDownload[]>,
      speechEngines: (serverId) => transport.invoke('models:speech-engines', serverId) as Promise<SpeechTtsEngine[] | null>,
      speechDownload: (serverId, engine, model) =>
        transport.invoke('models:speech-download', { serverId, engine, model }) as Promise<SpeechTtsEngine[] | null>,
      cancelDownload: (id) => transport.invoke('models:cancel-download', id) as Promise<ModelDownload[]>,
      comfyAddon: (serverId) => transport.invoke('models:comfy-addon', serverId) as Promise<{ installed: boolean; folder: string }>,
      hfLookup: (ref) => transport.invoke('models:hf-lookup', ref) as Promise<HfLookup>,
      hfDownload: (repo, quant, use) => transport.invoke('models:hf-download', { repo, quant, use }) as Promise<LlmDownload>,
      hfDownloads: () => transport.invoke('models:hf-downloads') as Promise<LlmDownload[]>,
      hfCancel: (id) => transport.invoke('models:hf-cancel', id) as Promise<LlmDownload[]>,
      visionStatus: () => transport.invoke('models:vision-status') as Promise<VisionStatus>,
      visionDownload: (ref) => transport.invoke('models:vision-download', ref) as Promise<VisionStatus>,
      visionCancel: () => transport.invoke('models:vision-cancel') as Promise<VisionStatus>,
      localLlms: () => transport.invoke('models:local-llms') as Promise<LocalLlmList>,
      useLocalLlm: (id, settings) => transport.invoke('models:use-local-llm', id, settings) as Promise<{ message: string; library: LocalLlmList; models: ModelRoutingView }>,
      deleteLocalLlm: (id) => transport.invoke('models:delete-local-llm', id) as Promise<LocalLlmList>,
    },
    realtime: {
      mintEphemeralToken: (request) =>
        transport.invoke('realtime:mint-ephemeral-token', request) as Promise<RealtimeEphemeralTokenResponse>,
    },
    localVoice: {
      getStatus: () => transport.invoke('local-voice:status') as Promise<LocalVoiceStatus>,
      transcribe: (wav) => transport.invoke('local-voice:transcribe', wav) as Promise<LocalVoiceTranscribeResult>,
      respond: (request) => transport.invoke('local-voice:respond', request) as Promise<LocalVoiceRespondResult>,
      cancel: async (requestId, avatarId) => {
        await (avatarId === undefined
          ? transport.invoke('local-voice:cancel', requestId)
          : transport.invoke('local-voice:cancel', requestId, avatarId));
      },
      resetHistory: async (avatarId) => {
        await (avatarId === undefined ? transport.invoke('local-voice:reset') : transport.invoke('local-voice:reset', avatarId));
      },
      getVoiceOptions: (avatarId) =>
        (avatarId ? transport.invoke('local-voice:voice-options', avatarId) : transport.invoke('local-voice:voice-options')) as Promise<SpeakingVoiceOptions>,
      systemStatus: (avatarId) =>
        (avatarId === undefined
          ? transport.invoke('local-voice:system-status')
          : transport.invoke('local-voice:system-status', avatarId)) as Promise<LocalVoiceSystemStatus>,
      onSystemReady: (listener) => {
        const channel = 'local-voice:system-ready';
        const handler = (info?: { urgent?: boolean; avatarId?: string }) =>
          listener({
            urgent: info?.urgent === true,
            ...(typeof info?.avatarId === 'string' && info.avatarId ? { avatarId: info.avatarId } : {}),
          });
        return transport.on(channel, handler);
      },
      onEvent: (listener) => {
        const channel = 'local-voice:event';
        const handler = (payload: LocalVoiceEvent) => listener(payload);
        return transport.on(channel, handler);
      },
    },
    wakeWord: {
      setListeningEnabled: async (enabled: boolean) => { await transport.invoke('wake-word:set-listening', enabled); },
      onWake: (listener) => {
        const channel = 'wake-word:event';
        const handler = (payload: WakeWordDetectionEvent) => listener(payload);
        return transport.on(channel, handler);
      },
      onPeak: (listener) => {
        const channel = 'wake-word:peak';
        const handler = (payload: WakeWordDetectionEvent) => listener(payload);
        return transport.on(channel, handler);
      },
      list: () => transport.invoke('wake-word:list') as Promise<WakeWordOption[]>,
      getTrainingStatus: () => transport.invoke('wake-word:get-training-status') as Promise<WakeWordTrainingStatus>,
      train: (phrase, options) =>
        transport.invoke('wake-word:train', { phrase, quick: options?.quick === true }) as Promise<WakeWordTrainingStatus>,
      cancelTraining: () => transport.invoke('wake-word:cancel-training') as Promise<WakeWordTrainingStatus>,
      onTrainingStatus: (listener) => {
        const channel = 'wake-word:training-status';
        const handler = (payload: WakeWordTrainingStatus) => listener(payload);
        return transport.on(channel, handler);
      },
    },
    talk: {
      onTrigger: (listener) => {
        const channel = 'talk:trigger';
        const handler = (payload: TalkTriggerEvent) => listener(payload);
        return transport.on(channel, handler);
      },
      getShortcutStatus: () => transport.invoke('talk:get-shortcut-status') as Promise<PushToTalkStatus>,
      onShortcutStatus: (listener) => {
        const channel = 'talk:shortcut-status';
        const handler = (payload: PushToTalkStatus) => listener(payload);
        return transport.on(channel, handler);
      },
    },
    conversation: {
      getHistory: () => transport.invoke('conversation:get-history') as Promise<ConversationHistory>,
      appendMessage: (message) =>
        transport.invoke('conversation:append-message', message) as Promise<ConversationMessage>,
      announce: (entry) => transport.invoke('conversation:announce', entry) as Promise<ConversationMessage[]>,
      onSessionStarted: (listener) => {
        const channel = 'conversation:session-started';
        const handler = (payload: ConversationSession) => listener(payload);
        return transport.on(channel, handler);
      },
      onMessageAppended: (listener) => {
        const channel = 'conversation:message-appended';
        const handler = (payload: ConversationMessage) => listener(payload);
        return transport.on(channel, handler);
      },
    },
    metrics: {
      observeLatency: async (metric, valueMs) => {
        await transport.invoke('metrics:observe-latency', { metric, valueMs });
      },
    },
    backgrounds: {
      list: () => transport.invoke('background:list'),
      getActive: () => transport.invoke('background:get-active'),
      setActive: (id) => transport.invoke('background:set-active', id),
      load: (id) => transport.invoke('background:load', id),
      generate: (prompt) => transport.invoke('background:generate', prompt),
      delete: (id) => transport.invoke('background:delete', id),
      listRooms: () => transport.invoke('background:list-rooms'),
      loadRoom: (id) => transport.invoke('background:load-room', id),
      generateRoom: (description) => transport.invoke('rooms:generate', description),
      cancelRoomGeneration: () => transport.invoke('rooms:cancel-generate'),
      deleteRoom: (id) => transport.invoke('rooms:delete', id),
      onRoomProgress: (listener) => {
        const channel = 'rooms:generate-progress';
        const handler = (payload: Parameters<typeof listener>[0]) => listener(payload);
        return transport.on(channel, handler);
      },
      getIdleSettings: () => transport.invoke('rooms:idle-settings:get'),
      setIdleSettings: (settings) => transport.invoke('rooms:idle-settings:set', settings),
      pickIdle: (context) => transport.invoke('rooms:idle-pick', context),
      getObjectSettings: () => transport.invoke('rooms:object-settings:get'),
      setObjectSettings: (settings) => transport.invoke('rooms:object-settings:set', settings),
      listGeneratedObjects: () => transport.invoke('rooms:generated:list'),
      deleteGeneratedObject: (id) => transport.invoke('rooms:generated:delete', id),
      getMakingRoom: () => transport.invoke('rooms:making'),
      onRoomUpdated: (listener) => {
        const channel = 'rooms:updated';
        const handler = (roomId: string) => listener(roomId);
        return transport.on(channel, handler);
      },
    },
    avatar: {
      listModels: () => transport.invoke('avatar-model:list') as Promise<AvatarModelSummary[]>,
      getActiveModel: () => transport.invoke('avatar-model:get-active') as Promise<AvatarModelSummary | null>,
      setActiveModel: (modelId) =>
        transport.invoke('avatar-model:set-active', modelId) as Promise<AvatarModelSummary | null>,
      getVoicePreference: (engine, avatarId) =>
        (avatarId === undefined
          ? transport.invoke('avatar:voice:get-preference', engine)
          : transport.invoke('avatar:voice:get-preference', engine, avatarId)) as Promise<string | null>,
      setVoicePreference: (voice, engine, avatarId) =>
        (avatarId === undefined
          ? transport.invoke('avatar:voice:set-preference', voice, engine)
          : transport.invoke('avatar:voice:set-preference', voice, engine, avatarId)) as Promise<void>,
      getPromptPreference: (avatarId) =>
        (avatarId === undefined
          ? transport.invoke('avatar:prompt:get-preference')
          : transport.invoke('avatar:prompt:get-preference', avatarId)) as Promise<string | null>,
      setPromptPreference: (prompt, avatarId) =>
        (avatarId === undefined
          ? transport.invoke('avatar:prompt:set-preference', prompt)
          : transport.invoke('avatar:prompt:set-preference', prompt, avatarId)) as Promise<void>,
      getIdleHabits: (avatarId) =>
        (avatarId === undefined
          ? transport.invoke('avatar:idle-habits:get')
          : transport.invoke('avatar:idle-habits:get', avatarId)) as Promise<string>,
      setIdleHabits: (habits, avatarId) =>
        (avatarId === undefined
          ? transport.invoke('avatar:idle-habits:set', habits)
          : transport.invoke('avatar:idle-habits:set', habits, avatarId)) as Promise<void>,
      uploadModel: (payload) =>
        transport.invoke('avatar-model:upload', payload) as Promise<AvatarModelUploadResult>,
      deleteModel: async (modelId) => {
        await transport.invoke('avatar-model:delete', modelId);
      },
      loadModelBinary: async (modelId) => {
        const payload: unknown = await transport.invoke('avatar-model:load', modelId);
        return cloneBinary(payload, {
          id: modelId,
          errorMessage: 'Unexpected VRM binary payload received from main process.',
        });
      },
      updateModelThumbnail: (modelId, thumbnailDataUrl) =>
        transport.invoke('avatar-model:update-thumbnail', {
          modelId,
          thumbnailDataUrl,
        }) as Promise<AvatarModelSummary | null>,
      updateModelDescription: (modelId, description) =>
        transport.invoke('avatar-model:update-description', {
          modelId,
          description,
        }) as Promise<AvatarModelSummary | null>,
      generateModelDescription: (thumbnailDataUrl) =>
        transport.invoke('avatar-model:generate-description', {
          thumbnailDataUrl,
        }) as Promise<string>,
      listAnimations: () => transport.invoke('avatar-animation:list') as Promise<AvatarAnimationSummary[]>,
      uploadAnimation: (payload) =>
        transport.invoke('avatar-animation:upload', payload) as Promise<AvatarAnimationUploadResult>,
      generateAnimation: (payload: AvatarAnimationGenerationRequest) =>
        transport.invoke('avatar-animation:generate', payload) as Promise<AvatarAnimationUploadResult>,
      getMotionStatus: () => transport.invoke('avatar-motion:status') as Promise<AvatarMotionStatus>,
      streamMotion: (payload: AvatarMotionStreamRequest) =>
        transport.invoke('avatar-motion:stream', payload) as Promise<AvatarMotionStreamResult>,
      cancelMotion: async (streamId) => {
        await transport.invoke('avatar-motion:cancel', streamId);
      },
      onMotionChunk: (listener) => {
        const channel = 'avatar-motion:chunk';
        const handler = (payload: AvatarMotionChunkEvent) => listener(payload);
        return transport.on(channel, handler);
      },
      deleteAnimation: async (animationId) => {
        await transport.invoke('avatar-animation:delete', animationId);
      },
      renameAnimation: async (animationId, newName) =>
        transport.invoke('avatar-animation:rename', animationId, newName) as Promise<AvatarAnimationSummary>,
      loadAnimationBinary: async (animationId) => {
        const payload: unknown = await transport.invoke('avatar-animation:load', animationId);
        return cloneBinary(payload, {
          id: animationId,
          errorMessage: 'Unexpected VRMA binary payload received from main process.',
        });
      },
      triggerBehaviorCue: async (cue) => {
        await transport.invoke('avatar:trigger-behavior', cue);
      },
      listPoses: () => transport.invoke('avatar-pose:list') as Promise<AvatarPoseSummary[]>,
      uploadPose: (payload: AvatarPoseUploadRequest) =>
        transport.invoke('avatar-pose:upload', payload) as Promise<AvatarPoseUploadResult>,
      generatePose: (payload: AvatarPoseGenerationRequest) =>
        transport.invoke('avatar-pose:generate', payload) as Promise<AvatarPoseUploadResult>,
      deletePose: async (poseId: string) => {
        await transport.invoke('avatar-pose:delete', poseId);
      },
      loadPose: async (poseId: string) => {
        return transport.invoke('avatar-pose:load', poseId) as Promise<unknown>;
      },
      evaluatePose: (payload: PoseEvaluationRequest) =>
        transport.invoke('avatar-pose:evaluate', payload) as Promise<PoseEvaluationResult>,
      refinePose: (payload: PoseEvaluationRequest) =>
        transport.invoke('avatar-pose:refine', payload) as Promise<AvatarPoseUploadResult>,
      listAvatarImageModels: () => transport.invoke('avatar:image-models') as Promise<AvatarImageModelSelection>,
      setAvatarImageModel: async (id: string) => { await transport.invoke('avatar:image-model-select', id); },
      setAvatarImageLoras: async (choices: AvatarLoraChoice[]) => { await transport.invoke('avatar:image-loras-select', choices); },
      suggestBaseModels: (request: { baseModel?: string; family?: string }) =>
        transport.invoke('avatar:base-model-suggestions', request) as Promise<BaseModelSuggestions>,
      downloadBaseModel: (serverId: string, ref: string) => transport.invoke('models:download', { serverId, ref }) as Promise<ModelDownload>,
      listModelDownloads: () => transport.invoke('models:downloads') as Promise<ModelDownload[]>,
      generateAvatar: (payload: AvatarGenerationRequest) =>
        transport.invoke('avatar:generation-start', payload) as Promise<AvatarGenerationJob>,
      confirmAvatarConcept: async (jobId: string, confirmation?: AvatarGenerationConfirmation) => { await transport.invoke('avatar:generation-confirm-concept', jobId, ...(confirmation ? [confirmation] : [])); },
      getAvatarGenerationStatus: (jobId: string) =>
        transport.invoke('avatar:generation-status', jobId) as Promise<AvatarGenerationStatus>,
      loadGeneratedAvatarPreview: async (jobId: string) => {
        const payload: unknown = await transport.invoke('avatar:generation-preview', jobId);
        return cloneBinary(payload, {
          id: jobId,
          errorMessage: 'Unexpected generated VRM preview payload received from main process.',
        });
      },
      acceptGeneratedAvatar: (jobId: string) =>
        transport.invoke('avatar:generation-accept', jobId) as Promise<AvatarGenerationAcceptance>,
      rejectGeneratedAvatar: async (jobId: string) => {
        await transport.invoke('avatar:generation-reject', jobId);
      },
      listAvatarGenerationJobs: () =>
        transport.invoke('avatar:generation-list') as Promise<AvatarGenerationStatus[]>,
      removeAvatarBackground: async (jobId: string) => { await transport.invoke('avatar:generation-remove-background', jobId); },
      restoreAvatarBackground: async (jobId: string) => { await transport.invoke('avatar:generation-restore-background', jobId); },
      redrawAvatarViews: async (jobId: string) => { await transport.invoke('avatar:generation-redraw-views', jobId); },
      cancelAvatarGeneration: async (jobId: string) => {
        await transport.invoke('avatar:generation-cancel', jobId);
      },
      listAvatarCharacterModels: () =>
        transport.invoke('avatar:character-models') as Promise<AvatarCharacterModelSelection>,
      setAvatarCharacterModel: async (stage: 'geometry' | 'rig', id: string) => {
        await transport.invoke('avatar:character-model-select', stage, id);
      },
    },
    camera: {
      onDetection: (listener) => {
        const channel = 'camera:detection';
        const handler = (payload: CameraDetectionEvent) => listener(payload);
        return transport.on(channel, handler);
      },
      emitDetection: async (event) => {
        await transport.invoke('camera:emit-detection', event);
      },
    },
    switchboard: {
      status: () => transport.invoke('switchboard:status'),
    },
    avatars: {
      list: () => transport.invoke('avatars:list') as Promise<AvatarProfile[]>,
      add: (input) => transport.invoke('avatars:add', input) as Promise<AvatarProfile>,
      update: (id, changes) => transport.invoke('avatars:update', id, changes) as Promise<AvatarProfile>,
      remove: async (id) => {
        await transport.invoke('avatars:remove', id);
      },
      setTagInstructions: async (instructions) => {
        await transport.invoke('avatars:set-tag-instructions', instructions);
      },
      idlePersonas: () => transport.invoke('avatars:idle-personas') as Promise<Record<string, AvatarIdlePersona>>,
    },
    presence: {
      update: (payload) => transport.invoke('presence:update', payload),
      getDoNotDisturb: () => transport.invoke('presence:get-dnd'),
      setDoNotDisturb: (enabled) => transport.invoke('presence:set-dnd', enabled),
    },
    floor: {
      getHearChatter: () => transport.invoke('floor:get-hear-chatter'),
      setHearChatter: (enabled) => transport.invoke('floor:set-hear-chatter', enabled),
      interrupt: async () => {
        await transport.invoke('floor:interrupt');
      },
    },
    places: {
      snapshot: () => transport.invoke('places:snapshot') as Promise<PlacesSnapshot>,
      onChanged: (listener) => {
        const channel = 'places:changed';
        const handler = (snapshot: PlacesSnapshot) => listener(snapshot);
        return transport.on(channel, handler);
      },
      move: (avatarId, placeRef, reason) =>
        (reason === undefined ? transport.invoke('places:move', avatarId, placeRef) : transport.invoke('places:move', avatarId, placeRef, reason)) as Promise<{ ok: boolean; reason?: string }>,
      arrived: async (avatarId) => {
        await transport.invoke('places:arrived', avatarId);
      },
      summon: () => transport.invoke('places:summon'),
      canWander: (avatarId: string, placeRef: string, speaking?: boolean) => transport.invoke('places:can-wander', avatarId, placeRef, speaking === true) as Promise<{ ok: boolean; reason?: string }>,
    },
    roomHub: {
      status: () => transport.invoke('room-hub:status') as Promise<RoomHubStatus>,
      onChanged: (listener) => {
        const channel = 'room-hub:changed';
        const handler = (status: RoomHubStatus) => listener(status);
        return transport.on(channel, handler);
      },
      startPairing: (placeName) => transport.invoke('room-hub:start-pairing', placeName),
      cancelPairing: async () => {
        await transport.invoke('room-hub:cancel-pairing');
      },
      revoke: (deviceId) => transport.invoke('room-hub:revoke', deviceId) as Promise<boolean>,
      rename: (placeId, name) => transport.invoke('room-hub:rename', placeId, name),
      setRoom: (placeId, room) => transport.invoke('room-hub:set-room', placeId, room) as Promise<boolean>,
      setCamera: (placeId, on) => transport.invoke('room-hub:set-camera', placeId, on) as Promise<boolean>,
      setDoorbell: (placeId, on) => transport.invoke('room-hub:set-doorbell', placeId, on) as Promise<boolean>,
    },
    satellite: {
      status: () => transport.invoke('satellite:status') as Promise<SatelliteStatus>,
      onStatus: (listener) => {
        const channel = 'satellite:status';
        const handler = (status: SatelliteStatus) => listener(status);
        return transport.on(channel, handler);
      },
      pair: (input) => transport.invoke('satellite:pair', input) as Promise<SatelliteStatus>,
      forget: () => transport.invoke('satellite:forget') as Promise<SatelliteStatus>,
      startAtLogin: () => transport.invoke('satellite:start-at-login') as Promise<boolean>,
      setStartAtLogin: (on) => transport.invoke('satellite:start-at-login', on) as Promise<boolean>,
      reportTurn: async (timing) => {
        await transport.invoke('satellite:turn-timing', timing);
      },
    },
    deviceGate: {
      get: () => transport.invoke('device-gate:get') as Promise<DeviceGateState>,
      onChanged: (listener) => {
        const channel = 'device-gate:changed';
        const handler = (state: DeviceGateState) => listener(state);
        return transport.on(channel, handler);
      },
      captureStopped: async () => {
        await transport.invoke('device-gate:capture-stopped');
      },
      setOpen: (open) => transport.invoke('device-gate:set-open', open) as Promise<DeviceGateState>,
    },
    gpuMemory: {
      read: () => transport.invoke('diagnostics:gpu-memory'),
    },
    coding: {
      get: () => transport.invoke('coding:get') as Promise<CodingView>,
      set: (coding) => transport.invoke('coding:set', coding) as Promise<CodingView>,
      status: () => transport.invoke('coding:status') as Promise<CodingStatus>,
      pickGguf: () => transport.invoke('coding:pick-gguf') as Promise<string | null>,
      pickFolder: () => transport.invoke('coding:pick-folder') as Promise<string | null>,
      suggestChecks: (workspaceId) => transport.invoke('coding:suggest-checks', workspaceId) as Promise<string | null>,
    },
    codingTasks: {
      list: () => transport.invoke('coding:tasks'),
      get: (id) => transport.invoke('coding:task', id),
      diff: (id) => transport.invoke('coding:diff', id),
      start: (request) => transport.invoke('coding:start-task', request),
      answer: (id, answer) => transport.invoke('coding:answer-task', id, answer),
      followUp: (id, message) => transport.invoke('coding:follow-up', id, message),
      cancel: (id) => transport.invoke('coding:cancel-task', id),
      discard: (id) => transport.invoke('coding:discard-task', id),
      apply: (id) => transport.invoke('coding:apply-task', id),
      onEvent: (listener) => {
        const channel = 'coding:task-event';
        const handler = (payload: RunnerEvent) => listener(payload);
        return transport.on(channel, handler);
      },
    },
    codingBusy: {
      onChanged: (listener) => {
        const channel = 'coding:busy';
        const handler = (payload: CodingBusy) => listener(payload);
        return transport.on(channel, handler);
      },
    },
    approvals: {
      list: () => transport.invoke('approvals:list'),
      approve: (id) => transport.invoke('approvals:approve', id),
      decline: (id) => transport.invoke('approvals:decline', id),
      onChanged: (listener) => {
        const channel = 'approvals:changed';
        const handler = (payload: ApprovalView[]) => listener(payload);
        return transport.on(channel, handler);
      },
    },
    memoryEngine: {
      status: () => transport.invoke('memory-engine:status'),
      search: (query, period) => transport.invoke('memory-engine:search', { query, ...period }),
      timeline: (from, to) => transport.invoke('memory-engine:timeline', { from, to }),
      memory: (id, around) => transport.invoke('memory-engine:memory', { id, around }),
      facts: (options) => transport.invoke('memory-engine:facts', options ?? {}),
      addFact: (fact) => transport.invoke('memory-engine:add-fact', fact),
      updateFact: (id, patch) => transport.invoke('memory-engine:update-fact', { id, patch }),
      reviewFacts: (ids) => transport.invoke('memory-engine:review-facts', ids),
      deleteFact: (id) => transport.invoke('memory-engine:delete-fact', id),
      forgetSession: (id) => transport.invoke('memory-engine:forget-session', id),
      recallLog: (limit) => transport.invoke('memory-engine:recall-log', { limit }),
      runSummaries: () => transport.invoke('memory-engine:run-summaries'),
    },
    mcp: {
      listServers: () => transport.invoke('mcp:list-servers') as Promise<MCPServerConfig[]>,
      addServer: (config) => transport.invoke('mcp:add-server', config) as Promise<MCPServerConfig>,
      updateServer: (id, updates) =>
        transport.invoke('mcp:update-server', id, updates) as Promise<MCPServerConfig>,
      deleteServer: (id) => transport.invoke('mcp:delete-server', id) as Promise<void>,
      connectServer: (id) => transport.invoke('mcp:connect-server', id) as Promise<MCPConnectionResult>,
      disconnectServer: (id) => transport.invoke('mcp:disconnect-server', id) as Promise<void>,
      testConnection: (id) => transport.invoke('mcp:test-connection', id) as Promise<MCPConnectionResult>,

      listTools: (serverId?) => transport.invoke('mcp:list-tools', serverId) as Promise<MCPToolSummary[]>,
      updateToolPreferences: (toolId, prefs) =>
        transport.invoke('mcp:update-tool-preferences', toolId, prefs) as Promise<void>,
      executeTool: (toolId, params) =>
        transport.invoke('mcp:execute-tool', toolId, params) as Promise<MCPToolResult>,

      onServerStatusChanged: (callback) => {
        const channel = 'mcp:server-status-changed';
        const handler = (event: ServerStatusEvent) => callback(event);
        return transport.on(channel, handler);
      },

      onToolsDiscovered: (callback) => {
        const channel = 'mcp:tools-discovered';
        const handler = (serverId: string, count: number) => callback(serverId, count);
        return transport.on(channel, handler);
      },

      getToolDefinitionsForLLM: () => transport.invoke('mcp:get-tool-definitions') as Promise<OpenAIFunction[]>,
    },
    app: {
      quit: async () => {
        await transport.invoke('app:quit');
      },
    },
    ping: () => 'pong',
    __bridgeReady: true,
    __bridgeVersion: '1.0.0',
  };
  return api;
}
