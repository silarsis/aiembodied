import path from 'node:path';
import { z } from 'zod';
import { BUILTIN_WAKE_WORD_MODELS } from '../wake-word/open-wake-word.js';
import type { SecretStore } from './secret-store.js';
import type { AudioDevicePreferences, PreferencesStore } from './preferences-store.js';

type ConfigLogger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

export type FeatureFlags = Record<string, boolean>;

export interface AppConfig {
  realtimeApiKey: string;
  comfyUiBaseUrl: string;
  motionServiceUrl: string;
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
  /** openWakeWord builtin model name (e.g. hey_jarvis) or an absolute path to a custom .onnx model. */
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

export type RendererConfig = Omit<AppConfig, 'realtimeApiKey' | 'wakeWord' | 'comfyUiBaseUrl' | 'motionServiceUrl'> & {
  hasRealtimeApiKey: boolean;
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
const DEFAULT_WAKE_WORD_MODEL = 'hey_jarvis';

const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_MOTION_SERVICE_URL = 'http://127.0.0.1:8190';

export class ConfigManager {
  private config: AppConfig | null = null;
  private readonly secretStore?: SecretStore;
  private readonly preferencesStore?: PreferencesStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn?: typeof fetch;
  private readonly secretTestTimeoutMs = 5000;
  private readonly logger: ConfigLogger;
  private readonly openAIClientFactory?: OpenAIClientFactory;

  constructor(options: ConfigManagerOptions = {}) {
    this.secretStore = options.secretStore;
    this.preferencesStore = options.preferencesStore;
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined);
    this.logger = options.logger ?? console;
    this.openAIClientFactory = options.openAIClientFactory;
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

    const config: AppConfig = {
      realtimeApiKey: realtimeApiKey ?? '',
      comfyUiBaseUrl: this.env.COMFYUI_BASE_URL?.trim() || DEFAULT_COMFYUI_BASE_URL,
      motionServiceUrl: this.env.MOTION_SERVICE_URL?.trim() || DEFAULT_MOTION_SERVICE_URL,
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
      wakeWord: this.parseWakeWordConfig(),
      metrics: this.parseMetricsConfig(),
    };

    this.config = config;
    this.logger.info('Configuration loaded.', {
      hasRealtimeApiKey: Boolean(config.realtimeApiKey),
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
    });

    return this.getRendererConfig();
  }

  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before accessing the config.');
    }

    return this.config;
  }

  getRendererConfig(): RendererConfig {
    const config = this.getConfig();
    // comfyUiBaseUrl and motionServiceUrl are main-process only.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { realtimeApiKey, wakeWord, comfyUiBaseUrl, motionServiceUrl, ...rest } = config;

    return {
      ...rest,
      hasRealtimeApiKey: Boolean(realtimeApiKey),
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
    this.logger.debug('Resolving realtime API key from environment variables.', {
      keys: ['REALTIME_API_KEY', 'realtime_api_key'],
    });
    const envValue = this.readSecretFromEnv(['REALTIME_API_KEY', 'realtime_api_key']);
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

    const builtin = BUILTIN_WAKE_WORD_MODELS.find((name) => name === raw.toLowerCase().replace(/[\s-]+/g, '_'));
    if (builtin) {
      return builtin;
    }

    if (raw.toLowerCase().endsWith('.onnx')) {
      return path.resolve(raw);
    }

    throw new ConfigValidationError(
      `Unknown wake word model: ${raw}. Use one of ${BUILTIN_WAKE_WORD_MODELS.join(', ')} or a path to an .onnx model.`,
    );
  }

  private formatKeywordLabel(model: string): string {
    const base = path.basename(model).replace(/\.onnx$/i, '').replace(/_v\d+(\.\d+)*$/, '');
    return base
      .split(/[_\s-]+/)
      .filter((segment) => segment.length > 0)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ');
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
