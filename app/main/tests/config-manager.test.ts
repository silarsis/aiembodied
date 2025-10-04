import { describe, expect, it } from 'vitest';
import { ConfigManager, ConfigValidationError } from '../src/config/config-manager.js';
import { InMemorySecretStore } from '../src/config/secret-store.js';

describe('ConfigManager', () => {
  it('validates and returns configuration from environment variables', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'test-api-key',
        PORCUPINE_ACCESS_KEY: 'porcupine-key',
        AUDIO_INPUT_DEVICE_ID: 'input-device',
        AUDIO_OUTPUT_DEVICE_ID: 'output-device',
        FEATURE_FLAGS: '{"transcriptOverlay": false}',
        WAKE_WORD_BUILTIN: 'porcupine',
        WAKE_WORD_SENSITIVITY: '0.55',
        WAKE_WORD_MIN_CONFIDENCE: '0.75',
        WAKE_WORD_COOLDOWN_MS: '2500',
        WAKE_WORD_DEVICE_INDEX: '2',
      } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();

    expect(config).toEqual({
      realtimeApiKey: 'test-api-key',
      audioInputDeviceId: 'input-device',
      audioOutputDeviceId: 'output-device',
      featureFlags: { transcriptOverlay: false },
      wakeWord: {
        accessKey: 'porcupine-key',
        keywordPath: 'porcupine',
        keywordLabel: 'Porcupine',
        sensitivity: 0.55,
        minConfidence: 0.75,
        cooldownMs: 2500,
        deviceIndex: 2,
        modelPath: undefined,
      },
    });

    expect(manager.getRendererConfig()).toEqual({
      audioInputDeviceId: 'input-device',
      audioOutputDeviceId: 'output-device',
      featureFlags: { transcriptOverlay: false },
      hasRealtimeApiKey: true,
      wakeWord: {
        keywordPath: 'porcupine',
        keywordLabel: 'Porcupine',
        sensitivity: 0.55,
        minConfidence: 0.75,
        cooldownMs: 2500,
        deviceIndex: 2,
        modelPath: undefined,
        hasAccessKey: true,
      },
    });

    await expect(manager.getSecret('realtimeApiKey')).resolves.toBe('test-api-key');
    await expect(manager.getSecret('wakeWordAccessKey')).resolves.toBe('porcupine-key');
  });

  it('falls back to secret store when environment variable is missing', async () => {
    const secretStore = new InMemorySecretStore();
    await secretStore.setSecret('REALTIME_API_KEY', 'stored-key');
    await secretStore.setSecret('PORCUPINE_ACCESS_KEY', 'porcupine-secret');

    const manager = new ConfigManager({
      env: { WAKE_WORD_BUILTIN: 'bumblebee' } as NodeJS.ProcessEnv,
      secretStore,
    });

    const config = await manager.load();
    expect(config.realtimeApiKey).toBe('stored-key');
    expect(config.wakeWord.accessKey).toBe('porcupine-secret');
    expect(config.wakeWord.keywordPath).toBe('bumblebee');
    expect(config.wakeWord.keywordLabel).toBe('Bumblebee');
  });

  it('parses comma separated feature flags', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'key',
        PORCUPINE_ACCESS_KEY: 'wake-key',
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
    const manager = new ConfigManager({
      env: { PORCUPINE_ACCESS_KEY: 'wake-key' } as NodeJS.ProcessEnv,
    });
    await expect(manager.load()).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('throws a validation error when the wake word access key is missing', async () => {
    const manager = new ConfigManager({
      env: { REALTIME_API_KEY: 'key' } as NodeJS.ProcessEnv,
    });

    await expect(manager.load()).rejects.toBeInstanceOf(ConfigValidationError);
  });
});
