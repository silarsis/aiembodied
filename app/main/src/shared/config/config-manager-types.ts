// Types only: shared/ holds what the main process and the renderer both need.
import type { CodingConfig } from '../coding/types.js';
import type { ModelRoute, ModelRouting, ServerType, UseId } from './model-routing.js';
import type { ProviderSettings } from './provider-settings.js';

export type FeatureFlags = Record<string, boolean>;

export type ConversationBackend = 'local' | 'openai';

/** The web_search tool's backends. Main process only: it can hold an API key. */
export interface WebSearchConfig {
  /** WEB_SEARCH_PROVIDER: searxng (default), brave, both in fallback order, or "off". */
  provider: string;
  /** SEARXNG_URL: the SearXNG instance for the searxng provider. */
  searxngUrl?: string;
  /** BRAVE_SEARCH_API_KEY: the Brave Search API token for the brave provider. */
  braveApiKey?: string;
}

export interface AppConfig {
  realtimeApiKey: string;
  comfyUiBaseUrl: string;
  /**
   * Which engine runs the conversation: 'local' is the speech-to-text, language model and
   * text-to-speech pipeline (each part local or OpenAI, see `providers`); 'openai' is OpenAI Realtime.
   */
  conversationBackend: ConversationBackend;
  providers: ProviderSettings;
  /** Which server runs each use (see model-routing.ts). */
  models: ModelRouting;
  /** The coding runner, workspaces and coder model file. */
  coding: CodingConfig;
  webSearch: WebSearchConfig;
  audioInputDeviceId?: string;
  audioOutputDeviceId?: string;
  realtimeModel?: string;
  realtimeVoice?: string;
  sessionInstructions?: string;
  vadTurnDetection?: 'none' | 'server_vad';
  vadThreshold?: number;
  vadSilenceDurationMs?: number;
  vadMinSpeechDurationMs?: number;
  featureFlags: FeatureFlags;
  wakeWord: WakeWordConfig;
  metrics: MetricsConfig;
}

export interface WakeWordConfig {
  /** openWakeWord builtin model name (e.g. hey_echo) or an absolute path to a custom .onnx model. */
  model: string;
  keywordLabel: string;
  /** Score (0..1) a frame must reach to count as a detection. */
  threshold: number;
  cooldownMs: number;
  deviceIndex?: number;
}

export interface MetricsConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
}

export type RendererWakeWordConfig = WakeWordConfig;

export type RendererConfig = Omit<
  AppConfig,
  'realtimeApiKey' | 'wakeWord' | 'comfyUiBaseUrl' | 'webSearch' | 'models' | 'coding'
> & {
  /** 'satellite' on a second desktop that draws one room of bija's world; absent on the full app. */
  role?: 'satellite';
  /** Set on a satellite that is a web page (a browser, or the Android shell's WebView) rather than the Electron app. */
  satelliteKind?: 'browser';
  hasRealtimeApiKey: boolean;
  /** True when the key comes from an environment variable, which the Settings page cannot change. */
  realtimeApiKeyFromEnv?: boolean;
  wakeWord: RendererWakeWordConfig;
};

export type ConfigSecretKey = 'realtimeApiKey';

/** A server as the Models and servers pop-up sees it: no keys, only whether one is set. */
export interface ModelServerView {
  id: string;
  name: string;
  type: ServerType;
  url: string;
  builtIn: boolean;
  managed: boolean;
  hasKey: boolean;
  /** The key comes from an environment variable, so the app cannot change it. */
  keyFromEnv?: boolean;
}

export interface ModelRoutingView {
  servers: ModelServerView[];
  routes: Record<UseId, ModelRoute>;
}
