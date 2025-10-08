import path from 'node:path';
import { z } from 'zod';
import { BuiltinKeyword } from '@picovoice/porcupine-node';
import type { SecretStore } from './secret-store.js';
import type { AudioDevicePreferences, PreferencesStore } from './preferences-store.js';

export type FeatureFlags = Record<string, boolean>;

export interface AppConfig {
  realtimeApiKey: string;
  audioInputDeviceId?: string;
  audioOutputDeviceId?: string;
  featureFlags: FeatureFlags;
  wakeWord: WakeWordConfig;
  metrics: MetricsConfig;
  homeAssistant: HomeAssistantConfig;
}

export interface WakeWordConfig {
  accessKey: string;
  keywordPath: string;
  keywordLabel: string;
  sensitivity: number;
  minConfidence: number;
  cooldownMs: number;
  deviceIndex?: number;
  modelPath?: string;
}

export interface MetricsConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
}

export interface HomeAssistantConfig {
  enabled: boolean;
  baseUrl: string;
  accessToken: string;
  allowedEntities: string[];
  eventTypes: string[];
  reconnectDelaysMs: number[];
  heartbeatIntervalMs: number;
}

export type RendererWakeWordConfig = Omit<WakeWordConfig, 'accessKey'> & {
  hasAccessKey: boolean;
};

export type RendererConfig = Omit<AppConfig, 'realtimeApiKey' | 'wakeWord' | 'homeAssistant'> & {
  hasRealtimeApiKey: boolean;
  wakeWord: RendererWakeWordConfig;
  homeAssistant: RendererHomeAssistantConfig;
};

export type RendererHomeAssistantConfig = Omit<HomeAssistantConfig, 'accessToken'> & {
  hasAccessToken: boolean;
};

export type ConfigSecretKey = 'realtimeApiKey' | 'wakeWordAccessKey' | 'homeAssistantAccessToken';

export interface ConfigManagerOptions {
  secretStore?: SecretStore;
  preferencesStore?: PreferencesStore;
  env?: NodeJS.ProcessEnv;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const FeatureFlagsSchema = z.record(z.string().min(1), z.boolean());

const WakeWordSchema = z.object({
  accessKey: z.string().min(1, 'Porcupine access key is required'),
  keywordPath: z.string().min(1, 'Wake word keyword path is required'),
  keywordLabel: z.string().min(1, 'Wake word keyword label is required'),
  sensitivity: z.number().min(0).max(1),
  minConfidence: z.number().min(0).max(1),
  cooldownMs: z.number().int().min(0),
  deviceIndex: z.number().int().optional(),
  modelPath: z.string().min(1).optional(),
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

const HomeAssistantSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().url(),
  accessToken: z.string(),
  allowedEntities: z.array(z.string().min(1)),
  eventTypes: z.array(z.string().min(1)),
  reconnectDelaysMs: z.array(z.number().int().min(0)).min(1),
  heartbeatIntervalMs: z.number().int().min(1000),
});

const ConfigSchema = z.object({
  realtimeApiKey: z.string().min(1, 'Realtime API key is required'),
  audioInputDeviceId: z.string().optional(),
  audioOutputDeviceId: z.string().optional(),
  featureFlags: FeatureFlagsSchema.default({}),
  wakeWord: WakeWordSchema,
  metrics: MetricsSchema,
  homeAssistant: HomeAssistantSchema,
});

const DEFAULT_SECRET_KEYS: ConfigSecretKey[] = ['realtimeApiKey', 'wakeWordAccessKey', 'homeAssistantAccessToken'];

export class ConfigManager {
  private config: AppConfig | null = null;
  private readonly secretStore?: SecretStore;
  private readonly preferencesStore?: PreferencesStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ConfigManagerOptions = {}) {
    this.secretStore = options.secretStore;
    this.preferencesStore = options.preferencesStore;
    this.env = options.env ?? process.env;
  }

  async load(): Promise<AppConfig> {
    if (this.config) {
      return this.config;
    }

    const realtimeApiKey = await this.resolveRealtimeApiKey();
    const wakeWordAccessKey = await this.resolveWakeWordAccessKey();
    const storedPreferences = (await this.preferencesStore?.load()) ?? {};

    if (!realtimeApiKey) {
      throw new ConfigValidationError(
        'Realtime API key is required. Provide REALTIME_API_KEY in the environment or store it securely.',
      );
    }

    if (!wakeWordAccessKey) {
      throw new ConfigValidationError(
        'Porcupine access key is required. Provide PORCUPINE_ACCESS_KEY in the environment or store it securely.',
      );
    }

    const homeAssistantAccessToken = await this.resolveHomeAssistantAccessToken();

    const parsed = ConfigSchema.parse({
      realtimeApiKey,
      audioInputDeviceId:
        this.normalizeDeviceId(storedPreferences.audioInputDeviceId) ??
        (this.env.AUDIO_INPUT_DEVICE_ID?.trim() || undefined),
      audioOutputDeviceId:
        this.normalizeDeviceId(storedPreferences.audioOutputDeviceId) ??
        (this.env.AUDIO_OUTPUT_DEVICE_ID?.trim() || undefined),
      featureFlags: this.parseFeatureFlags(this.env.FEATURE_FLAGS),
      wakeWord: this.parseWakeWordConfig({ accessKey: wakeWordAccessKey }),
      metrics: this.parseMetricsConfig(),
      homeAssistant: this.parseHomeAssistantConfig({ accessToken: homeAssistantAccessToken }),
    });

    this.config = parsed;
    return parsed;
  }

  async setAudioDevicePreferences(preferences: AudioDevicePreferences): Promise<RendererConfig> {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before updating preferences.');
    }

    const audioInputDeviceId = this.normalizeDeviceId(preferences.audioInputDeviceId);
    const audioOutputDeviceId = this.normalizeDeviceId(preferences.audioOutputDeviceId);

    this.config = {
      ...this.config,
      audioInputDeviceId,
      audioOutputDeviceId,
    };

    await this.preferencesStore?.save({ audioInputDeviceId, audioOutputDeviceId });

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
    const { realtimeApiKey, wakeWord, homeAssistant, ...rest } = config;

    const { accessKey, ...rendererWakeWord } = wakeWord;
    const { accessToken, ...rendererHomeAssistant } = homeAssistant;

    return {
      ...rest,
      hasRealtimeApiKey: Boolean(realtimeApiKey),
      wakeWord: {
        ...rendererWakeWord,
        hasAccessKey: Boolean(accessKey),
      },
      homeAssistant: {
        ...rendererHomeAssistant,
        hasAccessToken: Boolean(accessToken),
      },
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

    if (key === 'wakeWordAccessKey') {
      return config.wakeWord.accessKey;
    }

    if (key === 'homeAssistantAccessToken') {
      return config.homeAssistant.accessToken;
    }

    throw new Error(`Unhandled secret key requested: ${key}`);
  }

  private async resolveRealtimeApiKey(): Promise<string | undefined> {
    const envValue = this.env.REALTIME_API_KEY?.trim();
    if (envValue) {
      return envValue;
    }

    if (!this.secretStore) {
      return undefined;
    }

    const stored = await this.secretStore.getSecret('REALTIME_API_KEY');
    return stored ?? undefined;
  }

  private async resolveWakeWordAccessKey(): Promise<string | undefined> {
    const envValue = this.env.PORCUPINE_ACCESS_KEY?.trim();
    if (envValue) {
      return envValue;
    }

    if (!this.secretStore) {
      return undefined;
    }

    const stored = await this.secretStore.getSecret('PORCUPINE_ACCESS_KEY');
    return stored ?? undefined;
  }

  private async resolveHomeAssistantAccessToken(): Promise<string | undefined> {
    const envValue = this.env.HOME_ASSISTANT_ACCESS_TOKEN?.trim();
    if (envValue) {
      return envValue;
    }

    if (!this.secretStore) {
      return undefined;
    }

    const stored = await this.secretStore.getSecret('HOME_ASSISTANT_ACCESS_TOKEN');
    return stored ?? undefined;
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

  private parseHomeAssistantConfig({ accessToken }: { accessToken?: string }): HomeAssistantConfig {
    const enabled = this.parseBoolean(this.env.HOME_ASSISTANT_ENABLED, false);
    const baseUrl = this.env.HOME_ASSISTANT_BASE_URL?.trim() || 'http://localhost:8123';
    const allowedEntities = this.parseStringList(this.env.HOME_ASSISTANT_ALLOWED_ENTITIES, []);
    const eventTypes = this.parseStringList(this.env.HOME_ASSISTANT_EVENT_TYPES, ['state_changed']);
    const reconnectDelays = this.parseNumberList(
      this.env.HOME_ASSISTANT_RECONNECT_DELAYS_MS,
      [1000, 5000, 15000],
      'HOME_ASSISTANT_RECONNECT_DELAYS_MS',
    );
    const heartbeatIntervalMs = this.parseInteger({
      name: 'HOME_ASSISTANT_HEARTBEAT_MS',
      raw: this.env.HOME_ASSISTANT_HEARTBEAT_MS,
      defaultValue: 30000,
      min: 1000,
    });

    const token = accessToken?.trim() ?? '';

    if (enabled) {
      if (!baseUrl) {
        throw new ConfigValidationError(
          'HOME_ASSISTANT_BASE_URL is required when Home Assistant integration is enabled.',
        );
      }

      if (!token) {
        throw new ConfigValidationError(
          'Home Assistant access token is required when the integration is enabled.',
        );
      }

      if (allowedEntities.length === 0) {
        throw new ConfigValidationError(
          'HOME_ASSISTANT_ALLOWED_ENTITIES must include at least one entity when the integration is enabled.',
        );
      }

      if (eventTypes.length === 0) {
        throw new ConfigValidationError(
          'HOME_ASSISTANT_EVENT_TYPES must include at least one event when the integration is enabled.',
        );
      }
    }

    return HomeAssistantSchema.parse({
      enabled,
      baseUrl,
      accessToken: token,
      allowedEntities,
      eventTypes,
      reconnectDelaysMs: reconnectDelays,
      heartbeatIntervalMs,
    });
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
      const parsed = JSON.parse(trimmed);
      return FeatureFlagsSchema.parse(parsed);
    } catch (error) {
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

  private parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
    if (raw === undefined || raw === null) {
      return defaultValue;
    }

    const normalized = raw.trim().toLowerCase();
    if (!normalized) {
      return defaultValue;
    }

    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
      return false;
    }

    return defaultValue;
  }

  private parseStringList(raw: string | undefined, defaultValue: string[]): string[] {
    if (!raw) {
      return defaultValue;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((value) => String(value).trim()).filter((value) => value.length > 0);
        }
      } catch {
        // fall through to comma parsing
      }
    }

    return trimmed
      .split(',')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  private parseNumberList(raw: string | undefined, defaultValue: number[], name?: string): number[] {
    if (!raw || !raw.trim()) {
      return defaultValue;
    }

    const tokens = this.parseStringList(raw, []);
    if (tokens.length === 0) {
      return defaultValue;
    }

    const numbers: number[] = [];
    for (const token of tokens) {
      const value = Number.parseInt(token, 10);
      if (!Number.isFinite(value) || value < 0) {
        throw new ConfigValidationError(
          `${name ?? 'Value list'} must contain only non-negative integers.`,
        );
      }
      numbers.push(value);
    }

    return numbers;
  }

  private normalizeDeviceId(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private parseWakeWordConfig({ accessKey }: { accessKey: string }): WakeWordConfig {
    const keywordPath = this.resolveKeywordPath();
    const keywordLabel = this.resolveKeywordLabel(keywordPath);

    const sensitivity = this.parseNumberInRange({
      name: 'WAKE_WORD_SENSITIVITY',
      raw: this.env.WAKE_WORD_SENSITIVITY,
      defaultValue: 0.6,
      min: 0,
      max: 1,
    });

    const minConfidence = this.parseNumberInRange({
      name: 'WAKE_WORD_MIN_CONFIDENCE',
      raw: this.env.WAKE_WORD_MIN_CONFIDENCE,
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

    const modelPath = this.env.WAKE_WORD_MODEL_PATH?.trim() || undefined;

    return WakeWordSchema.parse({
      accessKey,
      keywordPath,
      keywordLabel,
      sensitivity,
      minConfidence,
      cooldownMs,
      deviceIndex,
      modelPath,
    });
  }

  private resolveKeywordPath(): string {
    const explicitPath = this.env.WAKE_WORD_KEYWORD_PATH?.trim();
    if (explicitPath) {
      return path.resolve(explicitPath);
    }

    const builtin = this.env.WAKE_WORD_BUILTIN?.trim();
    const keyword = this.resolveBuiltinKeyword(builtin);
    return keyword;
  }

  private resolveKeywordLabel(keywordPath: string): string {
    const label = this.env.WAKE_WORD_KEYWORD_LABEL?.trim();
    if (label) {
      return label;
    }

    const builtinKeyword = this.getBuiltinKeywordIfValid(keywordPath);
    if (builtinKeyword) {
      return this.formatKeywordLabel(builtinKeyword);
    }

    const base = path.basename(keywordPath);
    const withoutExtension = base.replace(path.extname(base), '');
    return withoutExtension;
  }

  private resolveBuiltinKeyword(input: string | undefined): BuiltinKeyword {
    if (!input) {
      return BuiltinKeyword.PORCUPINE;
    }

    const normalized = input.trim().toLowerCase();
    const match = (Object.values(BuiltinKeyword) as string[]).find((keyword) => keyword.toLowerCase() === normalized);

    if (!match) {
      throw new ConfigValidationError(`Unknown wake word builtin keyword: ${input}`);
    }

    return match as BuiltinKeyword;
  }

  private getBuiltinKeywordIfValid(keywordPath: string): BuiltinKeyword | null {
    if ((Object.values(BuiltinKeyword) as string[]).includes(keywordPath as BuiltinKeyword)) {
      return keywordPath as BuiltinKeyword;
    }

    return null;
  }

  private formatKeywordLabel(keyword: BuiltinKeyword): string {
    return keyword
      .split(' ')
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
