import { describe, expect, it } from 'vitest';
import { ConfigManager, ConfigValidationError } from '../src/config/config-manager.js';
import { InMemorySecretStore } from '../src/config/secret-store.js';

describe('ConfigManager', () => {
  it('validates and returns configuration from environment variables', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'test-api-key',
        AUDIO_INPUT_DEVICE_ID: 'input-device',
        AUDIO_OUTPUT_DEVICE_ID: 'output-device',
        FEATURE_FLAGS: '{"transcriptOverlay": false}',
      } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();

    expect(config).toEqual({
      realtimeApiKey: 'test-api-key',
      audioInputDeviceId: 'input-device',
      audioOutputDeviceId: 'output-device',
      featureFlags: { transcriptOverlay: false },
    });

    expect(manager.getRendererConfig()).toEqual({
      audioInputDeviceId: 'input-device',
      audioOutputDeviceId: 'output-device',
      featureFlags: { transcriptOverlay: false },
      hasRealtimeApiKey: true,
    });

    await expect(manager.getSecret('realtimeApiKey')).resolves.toBe('test-api-key');
  });

  it('falls back to secret store when environment variable is missing', async () => {
    const secretStore = new InMemorySecretStore();
    await secretStore.setSecret('REALTIME_API_KEY', 'stored-key');

    const manager = new ConfigManager({
      env: {} as NodeJS.ProcessEnv,
      secretStore,
    });

    const config = await manager.load();
    expect(config.realtimeApiKey).toBe('stored-key');
  });

  it('parses comma separated feature flags', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'key',
        FEATURE_FLAGS: 'transcriptOverlay=false,avatarIdle=true,invalid',
      } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();
    expect(config.featureFlags).toEqual({
      transcriptOverlay: false,
      avatarIdle: true,
      invalid: true,
    });
  });

  it('throws a validation error when the realtime api key is missing', async () => {
    const manager = new ConfigManager({ env: {} as NodeJS.ProcessEnv });
    await expect(manager.load()).rejects.toBeInstanceOf(ConfigValidationError);
  });
});
