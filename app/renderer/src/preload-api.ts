import type { CivitaiLookup } from '../../main/src/avatar/generation/civitai.js';
import type { HfLookup } from '../../main/src/local-llm/huggingface.js';
import type { LlmDownload, LocalLlmList } from '../../main/src/local-llm/llm-library.js';
import type { ModelDownload } from '../../main/src/avatar/generation/model-downloads.js';
import type { BackgroundBridge } from '../../main/src/backgrounds/types.js';
import type { ConfigSecretKey, ModelRoutingView, RendererConfig } from '../../main/src/config/config-manager.js';
import type { ModelRoute, ServerType, UseId } from '../../main/src/config/model-routing.js';
import type { ServerProbe } from '../../main/src/config/model-server-probe.js';
import type { AudioDevicePreferences } from '../../main/src/config/preferences-store.js';
import type { ProviderSettingsPatch } from '../../main/src/config/provider-settings.js';
import type {
  ConversationAppendMessagePayload,
  ConversationHistory,
  ConversationMessage,
  ConversationSession,
} from '../../main/src/conversation/types.js';
import type { LatencyMetricName } from '../../main/src/metrics/types.js';
import type {
  WakeWordDetectionEvent,
  WakeWordOption,
  WakeWordTrainingStatus,
} from '../../main/src/wake-word/types.js';
import type { PushToTalkStatus, TalkTriggerEvent } from '../../main/src/talk/types.js';
import type { RealtimeEphemeralTokenRequest, RealtimeEphemeralTokenResponse } from '../../main/src/realtime/types.js';
import type {
  LocalVoiceEvent,
  LocalVoiceRespondRequest,
  LocalVoiceRespondResult,
  LocalVoiceStatus,
  LocalVoiceTranscribeResult,
} from '../../main/src/local-voice/types.js';
import type {
  MCPConnectionResult,
  MCPServerConfig,
  MCPServerConfigInput,
  MCPToolSummary,
} from '../../main/src/mcp/types.js';
import type { AvatarBridge } from './avatar/types.js';
import type { CameraDetectionEvent } from './avatar/behavior-cues.js';
import type { MemoryEngineBridge } from '../../main/src/memory-engine/bridge-types.js';

export interface ConfigBridge {
  get(): Promise<RendererConfig>;
  getSecret(key: ConfigSecretKey): Promise<string>;
  setAudioDevicePreferences(preferences: AudioDevicePreferences): Promise<RendererConfig>;
  setSecret(key: ConfigSecretKey, value: string): Promise<RendererConfig>;
  testSecret(key: ConfigSecretKey): Promise<{ ok: boolean; message?: string }>;
  clearSecret?(key: ConfigSecretKey): Promise<RendererConfig>;
  setProviderSettings?(patch: ProviderSettingsPatch): Promise<RendererConfig>;
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

export interface PreloadApi {
  backgrounds?: BackgroundBridge;
  config: ConfigBridge;
  models?: ModelsBridge;
  realtime: RealtimeBridge;
  localVoice?: LocalVoiceBridge;
  wakeWord: WakeWordBridge;
  talk?: TalkBridge;
  conversation?: ConversationBridge;
  metrics?: MetricsBridge;
  avatar?: AvatarBridge;
  camera?: CameraBridge;
  mcp?: McpBridge;
  memoryEngine?: MemoryEngineBridge;
  ping(): string;
  __bridgeReady?: boolean;
  __bridgeVersion?: string;
}

/** MCP servers and the tools the assistant can call (the parts the settings use). */
export interface McpBridge {
  listServers(): Promise<MCPServerConfig[]>;
  addServer(config: MCPServerConfigInput): Promise<MCPServerConfig>;
  updateServer(id: string, updates: Partial<MCPServerConfigInput>): Promise<MCPServerConfig>;
  deleteServer(id: string): Promise<void>;
  connectServer(id: string): Promise<MCPConnectionResult>;
  disconnectServer(id: string): Promise<void>;
  listTools(serverId?: string): Promise<MCPToolSummary[]>;
  updateToolPreferences(toolId: string, prefs: { enabled?: boolean; confirmationLevel?: string }): Promise<void>;
  onServerStatusChanged?(callback: (event: unknown) => void): () => void;
  onToolsDiscovered?(callback: (serverId: string, count: number) => void): () => void;
  getToolDefinitionsForLLM?(): Promise<{ name: string; description: string }[]>;
}

export interface CameraBridge {
  onDetection(listener: (event: CameraDetectionEvent) => void): () => void;
  emitDetection(event: CameraDetectionEvent): Promise<void>;
}

export function getPreloadApi(): PreloadApi | undefined {
  return (window as unknown as { aiembodied?: PreloadApi }).aiembodied;
}
