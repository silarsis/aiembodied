import type { ConfigSecretKey, RendererConfig } from '../../main/src/config/config-manager.js';
import type { AudioDevicePreferences } from '../../main/src/config/preferences-store.js';
import type {
  ConversationAppendMessagePayload,
  ConversationHistory,
  ConversationMessage,
  ConversationSession,
} from '../../main/src/conversation/types.js';
import type { LatencyMetricName } from '../../main/src/metrics/types.js';
import type { WakeWordDetectionEvent } from '../../main/src/wake-word/types.js';
import type { AvatarBridge } from './avatar/types.js';
import type { CameraDetectionEvent } from './avatar/behavior-cues.js';

export interface ConfigBridge {
  get(): Promise<RendererConfig>;
  getSecret(key: ConfigSecretKey): Promise<string>;
  setAudioDevicePreferences(preferences: AudioDevicePreferences): Promise<RendererConfig>;
  setSecret(key: ConfigSecretKey, value: string): Promise<RendererConfig>;
  testSecret(key: ConfigSecretKey): Promise<{ ok: boolean; message?: string }>;
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

export interface CameraBridge {
  onDetection(listener: (event: CameraDetectionEvent) => void): () => void;
  emitDetection(event: CameraDetectionEvent): Promise<void>;
}

export function getPreloadApi(): PreloadApi | undefined {
  return (window as unknown as { aiembodied?: PreloadApi }).aiembodied;
}
