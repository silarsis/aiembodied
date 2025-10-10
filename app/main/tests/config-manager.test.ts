import { describe, expect, it, vi } from 'vitest';
import { ConfigManager, ConfigValidationError } from '../src/config/config-manager.js';
import { InMemoryPreferencesStore } from '../src/config/preferences-store.js';
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

    expect(config.audioInputDeviceId).toBe('input-device');
    expect(config.audioOutputDeviceId).toBe('output-device');
  });

  it('prefers stored preferences over environment configuration', async () => {
    const preferencesStore = new InMemoryPreferencesStore();
    await preferencesStore.save({
      audioInputDeviceId: 'preferred-input',
      audioOutputDeviceId: 'preferred-output',
    });

    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'test-api-key',
        PORCUPINE_ACCESS_KEY: 'porcupine-key',
        AUDIO_INPUT_DEVICE_ID: 'env-input',
        AUDIO_OUTPUT_DEVICE_ID: 'env-output',
        FEATURE_FLAGS: '{"transcriptOverlay": false}',
        WAKE_WORD_BUILTIN: 'porcupine',
        WAKE_WORD_SENSITIVITY: '0.55',
        WAKE_WORD_MIN_CONFIDENCE: '0.75',
        WAKE_WORD_COOLDOWN_MS: '2500',
        WAKE_WORD_DEVICE_INDEX: '2',
      } as NodeJS.ProcessEnv,
      preferencesStore,
    });

    const config = await manager.load();

    expect(config.audioInputDeviceId).toBe('preferred-input');
    expect(config.audioOutputDeviceId).toBe('preferred-output');

    const rendererConfig = manager.getRendererConfig();
    expect(rendererConfig.audioInputDeviceId).toBe('preferred-input');
    expect(rendererConfig.audioOutputDeviceId).toBe('preferred-output');

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

  it('parses metrics configuration from environment variables', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'key',
        PORCUPINE_ACCESS_KEY: 'wake-key',
        METRICS_ENABLED: 'true',
        METRICS_HOST: '0.0.0.0',
        METRICS_PORT: '9100',
        METRICS_PATH: 'metrics-endpoint',
      } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();
    expect(config.metrics).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 9100,
      path: '/metrics-endpoint',
    });
  });

  it('throws a validation error when the wake word access key is missing', async () => {
    const manager = new ConfigManager({
      env: { REALTIME_API_KEY: 'key' } as NodeJS.ProcessEnv,
    });

    await expect(manager.load()).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('loads with an empty realtime api key and marks the renderer config as unconfigured', async () => {
    const manager = new ConfigManager({
      env: { PORCUPINE_ACCESS_KEY: 'wake-key' } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();
    expect(config.realtimeApiKey).toBe('');
    const rendererConfig = manager.getRendererConfig();
    expect(rendererConfig.hasRealtimeApiKey).toBe(false);
  });

  it('reads realtime api keys from case-insensitive environment variables', async () => {
    const manager = new ConfigManager({
      env: {
        realtime_api_key: 'lower-key',
        PORCUPINE_ACCESS_KEY: 'wake-key',
        WAKE_WORD_BUILTIN: 'porcupine',
      } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();
    expect(config.realtimeApiKey).toBe('lower-key');
    const rendererConfig = manager.getRendererConfig();
    expect(rendererConfig.hasRealtimeApiKey).toBe(true);
  });

  it('reads api secrets from lowercase .env keys and trims whitespace', async () => {
    const manager = new ConfigManager({
      env: {
        realtime_api_key: ' \trealtime-key \n',
        porcupine_access_key: '  porcupine-key  ',
        WAKE_WORD_BUILTIN: 'porcupine',
      } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();

    expect(config.realtimeApiKey).toBe('realtime-key');
    expect(config.wakeWord.accessKey).toBe('porcupine-key');
    expect(config.wakeWord.keywordPath).toBe('porcupine');
    expect(config.wakeWord.keywordLabel).toBe('Porcupine');
  });

  it('logs secret resolution steps without leaking secret values', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const env = {
      REALTIME_API_KEY: 'rt-secret-value',
      PORCUPINE_ACCESS_KEY: 'wake-secret-value',
      WAKE_WORD_BUILTIN: 'porcupine',
    } as NodeJS.ProcessEnv;

    const manager = new ConfigManager({ env, logger });

    await manager.load();

    expect(logger.debug).toHaveBeenCalledWith(
      'Realtime API key resolved from environment variables.',
      expect.objectContaining({ length: env.REALTIME_API_KEY.length }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Wake word access key resolved from environment variables.',
      expect.objectContaining({ length: env.PORCUPINE_ACCESS_KEY.length }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Configuration loaded.',
      expect.objectContaining({
        hasRealtimeApiKey: true,
        wakeWordHasAccessKey: true,
      }),
    );

    for (const call of [...logger.debug.mock.calls, ...logger.info.mock.calls]) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(env.REALTIME_API_KEY);
      expect(serialized).not.toContain(env.PORCUPINE_ACCESS_KEY);
    }
  });

  it('updates and persists audio device preferences', async () => {
    const preferencesStore = new InMemoryPreferencesStore();
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'api',
        PORCUPINE_ACCESS_KEY: 'wake',
        WAKE_WORD_BUILTIN: 'porcupine',
      } as NodeJS.ProcessEnv,
      preferencesStore,
    });

    await manager.load();

    const rendererConfig = await manager.setAudioDevicePreferences({
      audioInputDeviceId: 'microphone-1',
      audioOutputDeviceId: 'speakers-2',
    });

    expect(rendererConfig.audioInputDeviceId).toBe('microphone-1');
    expect(rendererConfig.audioOutputDeviceId).toBe('speakers-2');

    const stored = await preferencesStore.load();
    expect(stored).toEqual({
      audioInputDeviceId: 'microphone-1',
      audioOutputDeviceId: 'speakers-2',
    });
  });

  it('updates secrets securely and refreshes renderer config state', async () => {
    const secretStore = new InMemorySecretStore();
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'initial-key',
        PORCUPINE_ACCESS_KEY: 'initial-wake',
        WAKE_WORD_BUILTIN: 'porcupine',
      } as NodeJS.ProcessEnv,
      secretStore,
    });

    await manager.load();

    const rendererConfig = await manager.setSecret('realtimeApiKey', ' updated-key ');
    expect(rendererConfig.hasRealtimeApiKey).toBe(true);
    await expect(secretStore.getSecret('REALTIME_API_KEY')).resolves.toBe('updated-key');
    await expect(manager.getSecret('realtimeApiKey')).resolves.toBe('updated-key');

    const updatedConfig = await manager.setSecret('wakeWordAccessKey', '\tnew-porcupine-key\n');
    expect(updatedConfig.wakeWord.hasAccessKey).toBe(true);
    await expect(secretStore.getSecret('PORCUPINE_ACCESS_KEY')).resolves.toBe('new-porcupine-key');
    await expect(manager.getSecret('wakeWordAccessKey')).resolves.toBe('new-porcupine-key');
  });

  it('throws when attempting to persist secrets without a configured store', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'initial',
        PORCUPINE_ACCESS_KEY: 'wake',
        WAKE_WORD_BUILTIN: 'porcupine',
      } as NodeJS.ProcessEnv,
    });

    await manager.load();

    await expect(manager.setSecret('realtimeApiKey', 'next')).rejects.toThrow('Secret store is not configured');
  });

  it('tests realtime api keys using the configured HTTP client', async () => {
    const secretStore = new InMemorySecretStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'live-key',
        PORCUPINE_ACCESS_KEY: 'wake',
        WAKE_WORD_BUILTIN: 'porcupine',
      } as NodeJS.ProcessEnv,
      secretStore,
      fetchFn: fetchMock,
    });

    await manager.load();

    const result = await manager.testSecret('realtimeApiKey');
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer live-key' }),
    }));
    expect(result).toEqual({ ok: true, message: 'Realtime API key verified successfully.' });
  });

  it('returns a helpful error when testing an unconfigured realtime api key', async () => {
    const fetchMock = vi.fn();
    const manager = new ConfigManager({
      env: { PORCUPINE_ACCESS_KEY: 'wake-key' } as NodeJS.ProcessEnv,
      fetchFn: fetchMock,
    });

    await manager.load();

    const result = await manager.testSecret('realtimeApiKey');
    expect(result).toEqual({ ok: false, message: 'Realtime API key is not configured.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports HTTP failures when validating wake word access keys', async () => {
    const secretStore = new InMemorySecretStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'api',
        PORCUPINE_ACCESS_KEY: 'wake',
        WAKE_WORD_BUILTIN: 'porcupine',
      } as NodeJS.ProcessEnv,
      secretStore,
      fetchFn: fetchMock,
    });

    await manager.load();

    const result = await manager.testSecret('wakeWordAccessKey');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.picovoice.ai/api/v1/porcupine/validate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer wake' }),
      }),
    );
    expect(result).toEqual({ ok: false, message: 'Wake word service responded with HTTP 401' });
  });
});
