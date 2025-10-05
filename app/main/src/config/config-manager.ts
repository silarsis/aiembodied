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

export type RendererWakeWordConfig = Omit<WakeWordConfig, 'accessKey'> & {
  hasAccessKey: boolean;
};

export type RendererConfig = Omit<AppConfig, 'realtimeApiKey' | 'wakeWord'> & {
  hasRealtimeApiKey: boolean;
  wakeWord: RendererWakeWordConfig;
};

export type ConfigSecretKey = 'realtimeApiKey' | 'wakeWordAccessKey';

export interface ConfigManagerOptions {
  secretStore?: SecretStore;
  preferencesStore?: PreferencesStore;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  realtimeTestEndpoint?: string;
  wakeWordTestEndpoint?: string;
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

const RealtimeApiKeySchema = z.string().min(1, 'Realtime API key is required');
const WakeWordAccessKeySchema = z.string().min(1, 'Porcupine access key is required');

const ConfigSchema = z.object({
  realtimeApiKey: RealtimeApiKeySchema,
  audioInputDeviceId: z.string().optional(),
  audioOutputDeviceId: z.string().optional(),
  featureFlags: FeatureFlagsSchema.default({}),
  wakeWord: WakeWordSchema,
  metrics: MetricsSchema,
});

const DEFAULT_SECRET_KEYS: ConfigSecretKey[] = ['realtimeApiKey', 'wakeWordAccessKey'];

export class ConfigManager {
  private config: AppConfig | null = null;
  private readonly secretStore?: SecretStore;
  private readonly preferencesStore?: PreferencesStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn?: typeof fetch;
  private readonly realtimeTestEndpoint: string;
  private readonly wakeWordTestEndpoint: string;
  private readonly secretTestTimeoutMs = 5000;

  constructor(options: ConfigManagerOptions = {}) {
    this.secretStore = options.secretStore;
    this.preferencesStore = options.preferencesStore;
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined);
    this.realtimeTestEndpoint = options.realtimeTestEndpoint ?? 'https://api.openai.com/v1/models';
    this.wakeWordTestEndpoint = options.wakeWordTestEndpoint ??
      'https://api.picovoice.ai/api/v1/porcupine/validate';
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
    const { realtimeApiKey, wakeWord, ...rest } = config;

    const { accessKey, ...rendererWakeWord } = wakeWord;

    return {
      ...rest,
      hasRealtimeApiKey: Boolean(realtimeApiKey),
      wakeWord: {
        ...rendererWakeWord,
        hasAccessKey: Boolean(accessKey),
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
      return this.getRendererConfig();
    }

    if (key === 'wakeWordAccessKey') {
      const parsed = WakeWordAccessKeySchema.parse(trimmed);
      await this.persistSecret('PORCUPINE_ACCESS_KEY', parsed);
      this.config = {
        ...this.config,
        wakeWord: {
          ...this.config.wakeWord,
          accessKey: parsed,
        },
      };
      return this.getRendererConfig();
    }

    throw new Error(`Unhandled secret key update requested: ${key}`);
  }

  async testSecret(key: ConfigSecretKey): Promise<{ ok: boolean; message?: string }> {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before testing secrets.');
    }

    const fetchFn = this.fetchFn;
    if (!fetchFn) {
      return { ok: false, message: 'Secret testing is unavailable: no HTTP client configured.' };
    }

    if (key === 'realtimeApiKey') {
      return this.testRealtimeKey(fetchFn, this.config.realtimeApiKey);
    }

    if (key === 'wakeWordAccessKey') {
      return this.testWakeWordKey(fetchFn, this.config.wakeWord.accessKey);
    }

    throw new Error(`Unhandled secret test requested: ${key}`);
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

  private async testRealtimeKey(fetchFn: typeof fetch, key: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const response = await fetchFn(this.realtimeTestEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
        },
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        return {
          ok: false,
          message: `Realtime API responded with HTTP ${response.status}`,
        };
      }

      return { ok: true, message: 'Realtime API key verified successfully.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error while testing realtime API key.';
      return { ok: false, message };
    }
  }

  private async testWakeWordKey(fetchFn: typeof fetch, key: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const response = await fetchFn(this.wakeWordTestEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operation: 'validate' }),
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        return {
          ok: false,
          message: `Wake word service responded with HTTP ${response.status}`,
        };
      }

      return { ok: true, message: 'Porcupine access key verified successfully.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error while testing Porcupine access key.';
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
