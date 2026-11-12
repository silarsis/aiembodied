import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BUILTIN_WAKE_WORD_MODELS } from '../wake-word/open-wake-word.js';
import { wakeWordLabel } from '../wake-word/wake-word-library.js';
import { DEFAULT_WEB_SEARCH_PROVIDER } from '../tools/web-search.js';
import { DEFAULT_CODING_CONFIG, sanitizeCodingConfig, seedCodingConfig, type CodingConfig } from '../coding/config.js';
import type { SecretStore } from './secret-store.js';
import type { AudioDevicePreferences, PreferencesStore } from './preferences-store.js';
import {
  describeProviders,
  mergeProviderPatch,
  resolveProviderSettings,
  sanitizeProviderPatch,
  type ProviderSettings,
  type ProviderSettingsPatch,
} from './provider-settings.js';
import {
  ADDABLE_SERVER_TYPES,
  BUILT_IN_SERVER_IDS,
  builtInServers,
  defaultRoutes,
  resolveModelRouting,
  sanitizeStoredModels,
  splitDatabasePassword,
  type ModelRoute,
  type ModelRouting,
  type ServerType,
  type StoredModels,
  type UseId,
} from './model-routing.js';

type ConfigLogger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

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

export type RendererConfig = Omit<AppConfig, 'realtimeApiKey' | 'wakeWord' | 'comfyUiBaseUrl' | 'webSearch' | 'models' | 'coding'> & {
  hasRealtimeApiKey: boolean;
  /** True when the key comes from an environment variable, which the Settings page cannot change. */
  realtimeApiKeyFromEnv?: boolean;
  wakeWord: RendererWakeWordConfig;
};

export type ConfigSecretKey = 'realtimeApiKey';

type OpenAIModelsClient = {
  models?: {
    list?: (params: { limit?: number }) => Promise<unknown>;
  };
};

type OpenAIClientFactory = (apiKey: string) => unknown;

export interface ConfigManagerOptions {
  secretStore?: SecretStore;
  preferencesStore?: PreferencesStore;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  logger?: ConfigLogger;
  openAIClientFactory?: OpenAIClientFactory;
  /** The app's own checkout: the first coding workspace. */
  repoRoot?: string;
  pathExists?: (file: string) => boolean;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const FeatureFlagsSchema = z.record(z.string().min(1), z.boolean());

const WakeWordSchema = z.object({
  model: z.string().min(1, 'Wake word model is required'),
  keywordLabel: z.string().min(1, 'Wake word keyword label is required'),
  threshold: z.number().min(0).max(1),
  cooldownMs: z.number().int().min(0),
  deviceIndex: z.number().int().optional(),
});

const MetricsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  path: z
    .string()
    .min(1)
    .transform((value) => (value.startsWith('/') ? value : `/${value}`)),
});

const RealtimeApiKeySchema = z.string().min(1, 'Realtime API key is required');

const DEFAULT_SECRET_KEYS: ConfigSecretKey[] = ['realtimeApiKey'];
const DEFAULT_WAKE_WORD_MODEL = 'hey_echo';

/** A builtin model name ("Hey Mycroft" -> hey_mycroft) or an absolute .onnx path; undefined otherwise. */
export function normalizeWakeWordModel(raw: string): string | undefined {
  const trimmed = raw.trim();
  const builtin = BUILTIN_WAKE_WORD_MODELS.find((name) => name === trimmed.toLowerCase().replace(/[\s-]+/g, '_'));
  if (builtin) {
    return builtin;
  }
  return trimmed.toLowerCase().endsWith('.onnx') ? path.resolve(trimmed) : undefined;
}

const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_CONVERSATION_BACKEND: ConversationBackend = 'local';
/** The OpenAI key is read from the first of these that is set, before the secret store. */
const API_KEY_ENV_NAMES = ['REALTIME_API_KEY', 'realtime_api_key', 'OPENAI_API_KEY'];
/** Where a server's API key is kept in the secret store. */
const serverSecretName = (id: string) => `MODEL_SERVER_KEY:${id}`;
/** Online accounts whose key can also come from an environment variable, which wins. */
const ACCOUNT_KEYS: Record<string, { env: string; secret: string }> = {
  [BUILT_IN_SERVER_IDS.brave]: { env: 'BRAVE_SEARCH_API_KEY', secret: 'BRAVE_SEARCH_API_KEY' },
  [BUILT_IN_SERVER_IDS.anthropic]: { env: 'ANTHROPIC_API_KEY', secret: serverSecretName(BUILT_IN_SERVER_IDS.anthropic) },
  [BUILT_IN_SERVER_IDS.github]: { env: 'GITHUB_TOKEN', secret: serverSecretName(BUILT_IN_SERVER_IDS.github) },
  [BUILT_IN_SERVER_IDS.civitai]: { env: 'CIVITAI_API_KEY', secret: 'CIVITAI_API_KEY' },
  [BUILT_IN_SERVER_IDS.huggingface]: { env: 'HF_TOKEN', secret: 'HUGGINGFACE_TOKEN' },
};

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

export class ConfigManager {
  private config: AppConfig | null = null;
  private readonly secretStore?: SecretStore;
  private readonly preferencesStore?: PreferencesStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn?: typeof fetch;
  private readonly secretTestTimeoutMs = 5000;
  private readonly logger: ConfigLogger;
  private readonly openAIClientFactory?: OpenAIClientFactory;
  /** The backend the user picked in the UI, kept apart from the env default so it is only saved once chosen. */
  private storedConversationBackend?: ConversationBackend;
  /** Only the provider settings the user changed; env and defaults fill in the rest. */
  private storedProviders: ProviderSettingsPatch = {};
  /** The wake word from the environment, before the Settings page's choice is applied. */
  private envWakeWord: WakeWordConfig | null = null;
  private apiKeyFromEnv = false;
  /** Saved servers and routes; built-in defaults fill in the rest. */
  private storedModels: StoredModels = {};
  /** API keys of added servers and Brave, by server id. OpenAI's is `realtimeApiKey`. */
  private serverKeys = new Map<string, string>();
  private readonly keysFromEnv = new Set<string>();
  /** The coding section as saved (or seeded); undefined until there is one. */
  private storedCoding?: CodingConfig;
  private readonly repoRoot?: string;
  private readonly pathExists: (file: string) => boolean;

  constructor(options: ConfigManagerOptions = {}) {
    this.secretStore = options.secretStore;
    this.preferencesStore = options.preferencesStore;
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined);
    this.logger = options.logger ?? console;
    this.openAIClientFactory = options.openAIClientFactory;
    this.repoRoot = options.repoRoot;
    this.pathExists = options.pathExists ?? existsSync;
  }

  async load(): Promise<AppConfig> {
    if (this.config) {
      this.logger.debug('Configuration already loaded. Returning cached state.');
      return this.config;
    }

    this.logger.info('Loading configuration from environment and secret stores.');

    const realtimeApiKey = await this.resolveRealtimeApiKey();
    const storedPreferences = (await this.preferencesStore?.load()) ?? {};

    const audioInputDeviceId =
      this.normalizeDeviceId(storedPreferences.audioInputDeviceId) ??
      this.normalizeDeviceId(this.env.AUDIO_INPUT_DEVICE_ID);
    const audioOutputDeviceId =
      this.normalizeDeviceId(storedPreferences.audioOutputDeviceId) ??
      this.normalizeDeviceId(this.env.AUDIO_OUTPUT_DEVICE_ID);

    this.storedConversationBackend = storedPreferences.conversationBackend;
    this.storedProviders = storedPreferences.providers ?? {};
    this.envWakeWord = this.parseWakeWordConfig();
    const providers = resolveProviderSettings(this.env, this.storedProviders);
    const wakeWord = this.applyWakeWordSettings(this.envWakeWord, providers);
    this.storedModels = sanitizeStoredModels(storedPreferences.models);
    this.storedCoding = sanitizeCodingConfig(storedPreferences.coding);
    let seededCoding = false;
    if (!this.storedCoding && this.repoRoot) {
      // The first time: the app's own repository is the first workspace.
      this.storedCoding = seedCodingConfig(this.repoRoot, this.pathExists) ?? undefined;
      seededCoding = Boolean(this.storedCoding);
    }
    const comfyUiBaseUrl = this.env.COMFYUI_BASE_URL?.trim() || DEFAULT_COMFYUI_BASE_URL;
    await this.loadServerKeys();

    const config: AppConfig = {
      realtimeApiKey: realtimeApiKey ?? '',
      comfyUiBaseUrl,
      conversationBackend: storedPreferences.conversationBackend ?? this.parseConversationBackend(),
      providers,
      models: this.resolveModels(providers, comfyUiBaseUrl),
      coding: structuredClone(this.storedCoding ?? DEFAULT_CODING_CONFIG),
      webSearch: {
        provider: this.env.WEB_SEARCH_PROVIDER?.trim() || DEFAULT_WEB_SEARCH_PROVIDER,
        searxngUrl: this.env.SEARXNG_URL?.trim() || undefined,
        braveApiKey: this.serverKeys.get(BUILT_IN_SERVER_IDS.brave),
      },
      audioInputDeviceId,
      audioOutputDeviceId,
      realtimeModel: this.normalizeDeviceId(storedPreferences.realtimeModel),
      realtimeVoice: this.normalizeDeviceId(storedPreferences.realtimeVoice),
      sessionInstructions: typeof storedPreferences.sessionInstructions === 'string'
        ? storedPreferences.sessionInstructions
        : undefined,
      vadTurnDetection: storedPreferences.vadTurnDetection,
      vadThreshold: typeof storedPreferences.vadThreshold === 'number' ? storedPreferences.vadThreshold : undefined,
      vadSilenceDurationMs: typeof storedPreferences.vadSilenceDurationMs === 'number' ? storedPreferences.vadSilenceDurationMs : undefined,
      vadMinSpeechDurationMs: typeof storedPreferences.vadMinSpeechDurationMs === 'number' ? storedPreferences.vadMinSpeechDurationMs : undefined,
      featureFlags: this.parseFeatureFlags(this.env.FEATURE_FLAGS),
      wakeWord,
      metrics: this.parseMetricsConfig(),
    };

    this.config = config;
    if (seededCoding && this.preferencesStore) {
      await this.preferencesStore.save({ ...storedPreferences, coding: this.storedCoding });
    }
    this.logger.info('Configuration loaded.', {
      hasRealtimeApiKey: Boolean(config.realtimeApiKey),
      conversationBackend: config.conversationBackend,
      providers: describeProviders(config.providers),
      wakeWordModel: config.wakeWord.model,
      audioInputConfigured: Boolean(config.audioInputDeviceId),
      audioOutputConfigured: Boolean(config.audioOutputDeviceId),
      featureFlagCount: Object.keys(config.featureFlags ?? {}).length,
    });
    return config;
  }

  async setAudioDevicePreferences(preferences: AudioDevicePreferences): Promise<RendererConfig> {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before updating preferences.');
    }

    const audioInputDeviceId = this.normalizeDeviceId(preferences.audioInputDeviceId);
    const audioOutputDeviceId = this.normalizeDeviceId(preferences.audioOutputDeviceId);
    const realtimeModel = this.normalizeDeviceId(preferences.realtimeModel);
    const realtimeVoice = this.normalizeDeviceId(preferences.realtimeVoice);
    const sessionInstructions = typeof preferences.sessionInstructions === 'string' ? preferences.sessionInstructions.trim() : undefined;
    const vadTurnDetection = preferences.vadTurnDetection === 'server_vad' ? 'server_vad' : preferences.vadTurnDetection === 'none' ? 'none' : undefined;
    const vadThreshold = typeof preferences.vadThreshold === 'number' ? preferences.vadThreshold : undefined;
    const vadSilenceDurationMs = typeof preferences.vadSilenceDurationMs === 'number' ? preferences.vadSilenceDurationMs : undefined;
    const vadMinSpeechDurationMs = typeof preferences.vadMinSpeechDurationMs === 'number' ? preferences.vadMinSpeechDurationMs : undefined;
    if (preferences.conversationBackend === 'local' || preferences.conversationBackend === 'openai') {
      this.storedConversationBackend = preferences.conversationBackend;
    }
    const conversationBackend = this.storedConversationBackend;

    this.config = {
      ...this.config,
      audioInputDeviceId,
      audioOutputDeviceId,
      ...(typeof realtimeModel === 'string' ? { realtimeModel } : {}),
      ...(typeof realtimeVoice === 'string' ? { realtimeVoice } : {}),
      ...(typeof sessionInstructions === 'string' && sessionInstructions.length > 0
        ? { sessionInstructions }
        : {}),
      ...(vadTurnDetection ? { vadTurnDetection } : {}),
      ...(typeof vadThreshold === 'number' ? { vadThreshold } : {}),
      ...(typeof vadSilenceDurationMs === 'number' ? { vadSilenceDurationMs } : {}),
      ...(typeof vadMinSpeechDurationMs === 'number' ? { vadMinSpeechDurationMs } : {}),
      ...(conversationBackend ? { conversationBackend } : {}),
    };

    await this.preferencesStore?.save({
      audioInputDeviceId,
      audioOutputDeviceId,
      realtimeModel,
      realtimeVoice,
      sessionInstructions,
      vadTurnDetection,
      vadThreshold,
      vadSilenceDurationMs,
      vadMinSpeechDurationMs,
      conversationBackend,
      ...(Object.keys(this.storedProviders).length > 0 ? { providers: this.storedProviders } : {}),
      ...(Object.keys(this.storedModels).length > 0 ? { models: this.storedModels } : {}),
      ...(this.storedCoding ? { coding: this.storedCoding } : {}),
    });

    return this.getRendererConfig();
  }

  /** Apply and save a change from the Settings page; returns the new renderer config. */
  async setProviderSettings(patch: ProviderSettingsPatch): Promise<RendererConfig> {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before updating provider settings.');
    }

    this.storedProviders = mergeProviderPatch(this.storedProviders, sanitizeProviderPatch(patch));
    const providers = resolveProviderSettings(this.env, this.storedProviders);
    const wakeWord = this.applyWakeWordSettings(this.envWakeWord ?? this.config.wakeWord, providers);
    this.config = { ...this.config, providers, wakeWord, models: this.resolveModels(providers, this.config.comfyUiBaseUrl) };

    if (this.preferencesStore) {
      const saved = await this.preferencesStore.load();
      await this.preferencesStore.save({ ...saved, providers: this.storedProviders });
    }
    this.logger.info('Provider settings updated.', describeProviders(providers));
    return this.getRendererConfig();
  }

  /** Servers and routes for the Models and servers pop-up. */
  getModelRoutingView(): ModelRoutingView {
    const { models } = this.getConfig();
    return {
      servers: models.servers.map((server) => ({
        ...server,
        hasKey: Boolean(this.getServerKey(server.id)),
        ...(server.id === BUILT_IN_SERVER_IDS.openai && this.apiKeyFromEnv ? { keyFromEnv: true } : {}),
        ...(this.keysFromEnv.has(server.id) ? { keyFromEnv: true } : {}),
      })),
      routes: structuredClone(models.routes),
    };
  }

  /** The coding settings (runner, workspaces, coder model file). */
  getCoding(): CodingConfig {
    return structuredClone(this.getConfig().coding);
  }

  /** Save new coding settings; an unknown runner falls back to the built-in one. */
  async setCoding(next: unknown): Promise<CodingConfig> {
    const config = this.getConfig();
    const coding = sanitizeCodingConfig(next);
    if (!coding) throw new Error('Those coding settings could not be saved.');
    if (!config.models.servers.some((server) => server.id === coding.runner && server.type === 'coder')) {
      coding.runner = DEFAULT_CODING_CONFIG.runner;
    }
    this.storedCoding = coding;
    this.config = { ...config, coding };
    if (this.preferencesStore) {
      const saved = await this.preferencesStore.load();
      await this.preferencesStore.save({ ...saved, coding });
    }
    this.logger.info('Coding settings updated.', { runner: coding.runner, workspaces: coding.workspaces.length });
    return structuredClone(coding);
  }

  /** The API key to send to a server, if it has one. */
  getServerKey(id: string): string | undefined {
    if (id === BUILT_IN_SERVER_IDS.openai) return this.config?.realtimeApiKey || undefined;
    return this.serverKeys.get(id);
  }

  /** Add a server (no id) or change one; returns its id. A built-in server keeps its type. */
  async saveModelServer(entry: { id?: string; name?: string; type?: ServerType; url?: string }): Promise<string> {
    const config = this.getConfig();
    const existing = entry.id ? config.models.servers.find((server) => server.id === entry.id) : undefined;
    if (entry.id && !existing) throw new Error('That server no longer exists.');
    const name = entry.name?.trim();
    const type = existing?.type ?? entry.type;
    let url = entry.url?.trim();
    let password: string | undefined;
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(
          type === 'memory'
            ? 'Enter the database address as a URL, such as postgresql://postgres@db.example.supabase.co:5432/postgres.'
            : 'Enter the server address as a URL, such as http://192.168.1.20:8188.',
        );
      }
      if (type === 'memory') {
        if ((parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') || !parsed.hostname) {
          throw new Error('Database addresses look like postgresql://user@host:5432/database.');
        }
        // A pasted connection string often carries the password: keep it in the key store instead.
        ({ url, password } = splitDatabasePassword(url));
      } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Server addresses start with http:// or https://.');
      }
    }
    if (!existing) {
      if (!entry.type || !ADDABLE_SERVER_TYPES.includes(entry.type)) throw new Error('Choose what kind of server this is.');
      if (!url) throw new Error('Enter the server address.');
    }
    const id = existing?.id ?? `server-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const servers = (this.storedModels.servers ?? []).filter((server) => server.id !== id);
    const previous = this.storedModels.servers?.find((server) => server.id === id);
    servers.push({
      id,
      ...(name ? { name } : previous?.name ? { name: previous.name } : {}),
      ...(existing?.builtIn ? {} : { type: existing?.type ?? entry.type }),
      ...(url ? { url } : previous?.url ? { url: previous.url } : {}),
    });
    this.storedModels = { ...this.storedModels, servers };
    await this.applyModelChange();
    if (password) await this.setServerKey(id, password);
    return id;
  }

  /** Remove an added server. Uses that pointed at it go back to their defaults. */
  async removeModelServer(id: string): Promise<void> {
    const server = this.getConfig().models.servers.find((entry) => entry.id === id);
    if (!server) return;
    if (server.builtIn) throw new Error('Built-in servers can be changed but not removed.');
    this.storedModels = { ...this.storedModels, servers: (this.storedModels.servers ?? []).filter((entry) => entry.id !== id) };
    if (this.serverKeys.has(id)) {
      this.serverKeys.delete(id);
      await this.secretStore?.deleteSecret(serverSecretName(id)).catch(() => undefined);
    }
    await this.applyModelChange();
  }

  /** Point a use at a server (and model, backups). An unusable choice is refused. */
  async setModelRoute(use: UseId, route: ModelRoute): Promise<void> {
    const stored = sanitizeStoredModels({ routes: { [use]: route } }).routes?.[use];
    if (!stored) throw new Error('That choice could not be saved.');
    const before = this.getConfig().models;
    const trial = resolveModelRouting(before.servers, before.routes, { routes: { [use]: stored } });
    if (trial.routes[use].server !== stored.server) throw new Error("That server can't do this job.");
    this.storedModels = { ...this.storedModels, routes: { ...this.storedModels.routes, [use]: stored } };
    await this.applyModelChange();
  }

  /** Save or (with an empty value) remove a server's API key. OpenAI's is the realtime API key. */
  async setServerKey(id: string, value: string): Promise<void> {
    const key = value.trim();
    if (id === BUILT_IN_SERVER_IDS.openai) {
      if (key) await this.setSecret('realtimeApiKey', key);
      else await this.clearSecret('realtimeApiKey');
      return;
    }
    const server = this.getConfig().models.servers.find((entry) => entry.id === id);
    if (!server) throw new Error('That server no longer exists.');
    if (!this.secretStore) throw new Error('Secret store is not configured. Unable to persist secrets securely.');
    const name = ACCOUNT_KEYS[id]?.secret ?? serverSecretName(id);
    if (key) {
      await this.secretStore.setSecret(name, key);
      this.serverKeys.set(id, key);
    } else {
      await this.secretStore.deleteSecret(name);
      if (!this.keysFromEnv.has(id)) this.serverKeys.delete(id);
    }
    if (id === BUILT_IN_SERVER_IDS.brave && this.config) {
      this.config = { ...this.config, webSearch: { ...this.config.webSearch, braveApiKey: this.serverKeys.get(id) } };
    }
    this.logger.info('Model server key updated.', { server: id, set: Boolean(key) });
  }

  private resolveModels(providers: ProviderSettings, comfyUiBaseUrl: string): ModelRouting {
    const builtIns = builtInServers({
      providers,
      comfyUiBaseUrl,
      searxngUrl: this.env.SEARXNG_URL?.trim() || undefined,
      coderRunnerUrl: this.env.CODING_RUNNER_URL?.trim() || undefined,
      coderLlmUrl: this.env.CODER_LLM_URL?.trim() || undefined,
      layaUrl: this.env.LAYA_URL?.trim() || undefined,
    });
    const defaults = defaultRoutes(providers, this.env.WEB_SEARCH_PROVIDER?.trim() || DEFAULT_WEB_SEARCH_PROVIDER);
    return resolveModelRouting(builtIns, defaults, this.storedModels);
  }

  private async applyModelChange(): Promise<void> {
    const config = this.getConfig();
    this.config = { ...config, models: this.resolveModels(config.providers, config.comfyUiBaseUrl) };
    if (this.preferencesStore) {
      const saved = await this.preferencesStore.load();
      await this.preferencesStore.save({ ...saved, models: this.storedModels });
    }
    this.logger.info('Model servers updated.', {
      servers: this.config.models.servers.length,
      routes: Object.fromEntries(Object.entries(this.config.models.routes).map(([use, route]) => [use, route.server])),
    });
  }

  private async loadServerKeys(): Promise<void> {
    this.serverKeys.clear();
    this.keysFromEnv.clear();
    const store = this.secretStore;
    const read = async (name: string) => (store ? await store.getSecret(name).catch(() => null) : null);
    for (const [id, names] of Object.entries(ACCOUNT_KEYS)) {
      const fromEnv = this.env[names.env]?.trim();
      if (fromEnv) this.keysFromEnv.add(id);
      const key = fromEnv || (await read(names.secret));
      if (key) this.serverKeys.set(id, key);
    }
    for (const server of this.storedModels.servers ?? []) {
      if (Object.values(BUILT_IN_SERVER_IDS).includes(server.id as never)) continue;
      const key = await read(serverSecretName(server.id));
      if (key) this.serverKeys.set(server.id, key);
    }
  }

  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before accessing the config.');
    }

    return this.config;
  }

  getRendererConfig(): RendererConfig {
    const config = this.getConfig();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { realtimeApiKey, wakeWord, comfyUiBaseUrl, webSearch, models, ...rest } = config;

    return {
      ...rest,
      providers: structuredClone(config.providers),
      hasRealtimeApiKey: Boolean(realtimeApiKey),
      realtimeApiKeyFromEnv: this.apiKeyFromEnv,
      wakeWord: { ...wakeWord },
    };
  }

  async getSecret(key: ConfigSecretKey): Promise<string> {
    if (!DEFAULT_SECRET_KEYS.includes(key)) {
      throw new Error(`Unknown secret key requested: ${key}`);
    }

    const config = this.getConfig();
    if (key === 'realtimeApiKey') {
      return config.realtimeApiKey;
    }

    throw new Error(`Unhandled secret key requested: ${key}`);
  }

  async setSecret(key: ConfigSecretKey, value: string): Promise<RendererConfig> {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before updating secrets.');
    }

    const trimmed = typeof value === 'string' ? value.trim() : '';

    if (key === 'realtimeApiKey') {
      const parsed = RealtimeApiKeySchema.parse(trimmed);
      await this.persistSecret('REALTIME_API_KEY', parsed);
      this.config = {
        ...this.config,
        realtimeApiKey: parsed,
      };
      this.logger.info('Realtime API key updated.', { length: parsed.length });
      return this.getRendererConfig();
    }


    throw new Error(`Unhandled secret key update requested: ${key}`);
  }

  /** Remove a saved key from the secret store. A key set by an environment variable stays. */
  async clearSecret(key: ConfigSecretKey): Promise<RendererConfig> {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before updating secrets.');
    }
    if (key !== 'realtimeApiKey') {
      throw new Error(`Unhandled secret key removal requested: ${key}`);
    }
    if (!this.secretStore) {
      throw new Error('Secret store is not configured.');
    }

    await this.secretStore.deleteSecret('REALTIME_API_KEY');
    if (!this.apiKeyFromEnv) {
      this.config = { ...this.config, realtimeApiKey: '' };
    }
    this.logger.info('Saved OpenAI API key removed.', { stillSetByEnv: this.apiKeyFromEnv });
    return this.getRendererConfig();
  }

  async testSecret(key: ConfigSecretKey): Promise<{ ok: boolean; message?: string }> {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before testing secrets.');
    }

    if (key === 'realtimeApiKey') {
      if (!this.config.realtimeApiKey) {
        return { ok: false, message: 'Realtime API key is not configured.' };
      }
      this.logger.debug('Testing realtime API key.');
      return this.testRealtimeKey(this.config.realtimeApiKey);
    }


    throw new Error(`Unhandled secret test requested: ${key}`);
  }

  private async resolveRealtimeApiKey(): Promise<string | undefined> {
    this.logger.debug('Resolving realtime API key from environment variables.', { keys: API_KEY_ENV_NAMES });
    const envValue = this.readSecretFromEnv(API_KEY_ENV_NAMES);
    this.apiKeyFromEnv = Boolean(envValue);
    if (envValue) {
      this.logger.debug('Realtime API key resolved from environment variables.', {
        length: envValue.length,
      });
      return envValue;
    }

    this.logger.debug('Realtime API key not found in environment.', {
      hasSecretStore: Boolean(this.secretStore),
    });
    if (!this.secretStore) {
      this.logger.warn('Realtime API key unavailable: secret store is not configured.');
      return undefined;
    }

    const stored = await this.secretStore.getSecret('REALTIME_API_KEY');
    if (stored) {
      this.logger.debug('Realtime API key resolved from secret store.', { length: stored.length });
    } else {
      this.logger.warn('Realtime API key not found in secret store.');
    }
    return stored ?? undefined;
  }


  private readSecretFromEnv(keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.env[key];
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }

    return undefined;
  }

  private async persistSecret(key: string, value: string): Promise<void> {
    if (!this.secretStore) {
      throw new Error('Secret store is not configured. Unable to persist secrets securely.');
    }

    await this.secretStore.setSecret(key, value);
  }

  private createTimeoutSignal(): AbortSignal | undefined {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(this.secretTestTimeoutMs);
    }

    if (typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.secretTestTimeoutMs);
      if (typeof timeout === 'object' && typeof (timeout as NodeJS.Timeout).unref === 'function') {
        (timeout as NodeJS.Timeout).unref();
      }
      return controller.signal;
    }

    return undefined;
  }

  private async testRealtimeKey(key: string): Promise<{ ok: boolean; message?: string }> {
    const clientFactory = this.openAIClientFactory;
    if (!clientFactory) {
      return { ok: false, message: 'Secret testing is unavailable: no OpenAI client configured.' };
    }
    try {
      const client = clientFactory(key) as OpenAIModelsClient;
      const listModels = client?.models?.list;
      if (typeof listModels !== 'function') {
        return {
          ok: false,
          message: 'Secret testing is unavailable: OpenAI client does not support model listing.',
        };
      }
      await listModels({ limit: 1 });
      return { ok: true, message: 'Realtime API key verified successfully.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error while testing realtime API key.';
      return { ok: false, message };
    }
  }


  private parseConversationBackend(): ConversationBackend {
    const raw = this.env.CONVERSATION_BACKEND?.trim().toLowerCase();
    if (!raw) {
      return DEFAULT_CONVERSATION_BACKEND;
    }
    if (raw === 'local' || raw === 'openai') {
      return raw;
    }
    throw new ConfigValidationError(`CONVERSATION_BACKEND must be "local" or "openai", not "${raw}".`);
  }

  private parseMetricsConfig(): MetricsConfig {
    const enabledValue = this.env.METRICS_ENABLED?.trim();
    const enabled = enabledValue ? ['1', 'true', 'yes', 'on'].includes(enabledValue.toLowerCase()) : false;
    const host = this.env.METRICS_HOST?.trim() || '127.0.0.1';
    const path = this.env.METRICS_PATH?.trim() || '/metrics';
    const portValue = this.env.METRICS_PORT?.trim();
    const port = portValue ? Number.parseInt(portValue, 10) : 9477;

    if (Number.isNaN(port)) {
      throw new ConfigValidationError('METRICS_PORT must be a valid integer if specified.');
    }

    return MetricsSchema.parse({ enabled, host, port, path });
  }

  private parseFeatureFlags(raw: string | undefined): FeatureFlags {
    if (!raw) {
      return {};
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);
      return FeatureFlagsSchema.parse(parsed);
    } catch {
      // fall back to comma-separated parsing
    }

    const flags: FeatureFlags = {};
    for (const token of trimmed.split(',')) {
      const segment = token.trim();
      if (!segment) {
        continue;
      }

      const [rawKey, rawValue] = segment.split('=');
      const key = rawKey?.trim();
      if (!key) {
        continue;
      }

      const value = rawValue?.trim().toLowerCase();
      flags[key] = value === undefined || value === '' ? true : ['1', 'true', 'on', 'yes', 'enabled'].includes(value);
    }

    return FeatureFlagsSchema.parse(flags);
  }

  private normalizeDeviceId(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private parseWakeWordConfig(): WakeWordConfig {
    const model = this.resolveWakeWordModel();
    const keywordLabel = this.env.WAKE_WORD_KEYWORD_LABEL?.trim() || this.formatKeywordLabel(model);

    const threshold = this.parseNumberInRange({
      name: 'WAKE_WORD_THRESHOLD',
      raw: this.env.WAKE_WORD_THRESHOLD,
      defaultValue: 0.5,
      min: 0,
      max: 1,
    });

    const cooldownMs = this.parseInteger({
      name: 'WAKE_WORD_COOLDOWN_MS',
      raw: this.env.WAKE_WORD_COOLDOWN_MS,
      defaultValue: 1500,
      min: 0,
    });

    const deviceIndex = this.parseOptionalInteger({
      name: 'WAKE_WORD_DEVICE_INDEX',
      raw: this.env.WAKE_WORD_DEVICE_INDEX,
    });

    return WakeWordSchema.parse({ model, keywordLabel, threshold, cooldownMs, deviceIndex });
  }

  /** WAKE_WORD_MODEL is a builtin openWakeWord model name or a path to a custom .onnx model. */
  private resolveWakeWordModel(): string {
    const raw = this.env.WAKE_WORD_MODEL?.trim();
    if (!raw) {
      return DEFAULT_WAKE_WORD_MODEL;
    }

    const model = normalizeWakeWordModel(raw);
    if (model) {
      return model;
    }

    throw new ConfigValidationError(
      `Unknown wake word model: ${raw}. Use one of ${BUILTIN_WAKE_WORD_MODELS.join(', ')} or a path to an .onnx model.`,
    );
  }

  /**
   * The wake word the Settings page chose (`providers.wakeWord`, which starts from the env), over
   * the env config. A saved model that is no longer valid falls back to the env one. Also writes
   * the model in use back into `providers`, so the page shows what is running.
   */
  private applyWakeWordSettings(base: WakeWordConfig, providers: ProviderSettings): WakeWordConfig {
    const requested = normalizeWakeWordModel(providers.wakeWord.model);
    if (!requested) {
      this.logger.warn('Saved wake word model is not valid; using the default.', { model: providers.wakeWord.model });
    }
    const model = requested ?? base.model;
    providers.wakeWord = { ...providers.wakeWord, model };
    return {
      ...base,
      model,
      keywordLabel: model === base.model ? base.keywordLabel : this.formatKeywordLabel(model),
      threshold: providers.wakeWord.threshold,
    };
  }

  private formatKeywordLabel(model: string): string {
    return wakeWordLabel(model);
  }

  private parseNumberInRange({
    name,
    raw,
    defaultValue,
    min,
    max,
  }: {
    name: string;
    raw: string | undefined;
    defaultValue: number;
    min: number;
    max: number;
  }): number {
    if (raw === undefined || raw === '') {
      return defaultValue;
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new ConfigValidationError(`${name} must be a number.`);
    }

    if (value < min || value > max) {
      throw new ConfigValidationError(`${name} must be between ${min} and ${max}.`);
    }

    return value;
  }

  private parseInteger({
    name,
    raw,
    defaultValue,
    min,
  }: {
    name: string;
    raw: string | undefined;
    defaultValue: number;
    min: number;
  }): number {
    if (raw === undefined || raw === '') {
      return defaultValue;
    }

    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) {
      throw new ConfigValidationError(`${name} must be an integer.`);
    }

    if (value < min) {
      throw new ConfigValidationError(`${name} must be greater than or equal to ${min}.`);
    }

    return value;
  }

  private parseOptionalInteger({
    name,
    raw,
  }: {
    name: string;
    raw: string | undefined;
  }): number | undefined {
    if (raw === undefined || raw === '') {
      return undefined;
    }

    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) {
      throw new ConfigValidationError(`${name} must be an integer.`);
    }

    return value;
  }
}
