import type { BackgroundBridge } from '../../main/src/backgrounds/types.js';
import type { ConfigSecretKey, RendererConfig } from '../../main/src/config/config-manager.js';
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
import type { AvatarBridge } from './avatar/types.js';
import type { CompanionSayRequest, CompanionSayResult, CompanionStatus } from '../../main/src/companion/types.js';
import type { CameraDetectionEvent } from './avatar/behavior-cues.js';

export interface ConfigBridge {
  get(): Promise<RendererConfig>;
  getSecret(key: ConfigSecretKey): Promise<string>;
  setAudioDevicePreferences(preferences: AudioDevicePreferences): Promise<RendererConfig>;
  setSecret(key: ConfigSecretKey, value: string): Promise<RendererConfig>;
  testSecret(key: ConfigSecretKey): Promise<{ ok: boolean; message?: string }>;
  clearSecret?(key: ConfigSecretKey): Promise<RendererConfig>;
  setProviderSettings?(patch: ProviderSettingsPatch): Promise<RendererConfig>;
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

export interface CompanionBridge {
  getStatus(): Promise<CompanionStatus>;
  onStatus(listener: (status: CompanionStatus) => void): () => void;
  rotatePairingCode(): Promise<CompanionStatus>;
  forgetDevice(deviceId: string): Promise<CompanionStatus>;
  say(request: CompanionSayRequest): Promise<CompanionSayResult>;
  /** The system prompt the desktop uses, so phone turns get the same persona and avatar tags. */
  setInstructions(instructions: string): Promise<void>;
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
  realtime: RealtimeBridge;
  localVoice?: LocalVoiceBridge;
  wakeWord: WakeWordBridge;
  talk?: TalkBridge;
  companion?: CompanionBridge;
  conversation?: ConversationBridge;
  metrics?: MetricsBridge;
  avatar?: AvatarBridge;
  camera?: CameraBridge;
  ping(): string;
  __bridgeReady?: boolean;
  __bridgeVersion?: string;
}

export interface CameraBridge {
  onDetection(listener: (event: CameraDetectionEvent) => void): () => void;
  emitDetection(event: CameraDetectionEvent): Promise<void>;
}

export function getPreloadApi(): PreloadApi | undefined {
  return (window as unknown as { aiembodied?: PreloadApi }).aiembodied;
}
