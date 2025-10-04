import { z } from 'zod';
import type { SecretStore } from './secret-store.js';

export type FeatureFlags = Record<string, boolean>;

export interface AppConfig {
  realtimeApiKey: string;
  audioInputDeviceId?: string;
  audioOutputDeviceId?: string;
  featureFlags: FeatureFlags;
}

export type RendererConfig = Omit<AppConfig, 'realtimeApiKey'> & {
  hasRealtimeApiKey: boolean;
};

export type ConfigSecretKey = 'realtimeApiKey';

export interface ConfigManagerOptions {
  secretStore?: SecretStore;
  env?: NodeJS.ProcessEnv;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const FeatureFlagsSchema = z.record(z.string().min(1), z.boolean());

const ConfigSchema = z.object({
  realtimeApiKey: z.string().min(1, 'Realtime API key is required'),
  audioInputDeviceId: z.string().optional(),
  audioOutputDeviceId: z.string().optional(),
  featureFlags: FeatureFlagsSchema.default({}),
});

const DEFAULT_SECRET_KEYS: ConfigSecretKey[] = ['realtimeApiKey'];

export class ConfigManager {
  private config: AppConfig | null = null;
  private readonly secretStore?: SecretStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ConfigManagerOptions = {}) {
    this.secretStore = options.secretStore;
    this.env = options.env ?? process.env;
  }

  async load(): Promise<AppConfig> {
    if (this.config) {
      return this.config;
    }

    const realtimeApiKey = await this.resolveRealtimeApiKey();

    if (!realtimeApiKey) {
      throw new ConfigValidationError(
        'Realtime API key is required. Provide REALTIME_API_KEY in the environment or store it securely.',
      );
    }

    const parsed = ConfigSchema.parse({
      realtimeApiKey,
      audioInputDeviceId: this.env.AUDIO_INPUT_DEVICE_ID?.trim() || undefined,
      audioOutputDeviceId: this.env.AUDIO_OUTPUT_DEVICE_ID?.trim() || undefined,
      featureFlags: this.parseFeatureFlags(this.env.FEATURE_FLAGS),
    });

    this.config = parsed;
    return parsed;
  }

  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('ConfigManager.load() must be called before accessing the config.');
    }

    return this.config;
  }

  getRendererConfig(): RendererConfig {
    const config = this.getConfig();
    const { realtimeApiKey, ...rest } = config;

    return {
      ...rest,
      hasRealtimeApiKey: Boolean(realtimeApiKey),
    };
  }

  async getSecret(key: ConfigSecretKey): Promise<string> {
    if (!DEFAULT_SECRET_KEYS.includes(key)) {
      throw new Error(`Unknown secret key requested: ${key}`);
    }

    const config = this.getConfig();
    return config.realtimeApiKey;
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
}
