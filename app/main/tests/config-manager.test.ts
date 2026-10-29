import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigManager, ConfigValidationError } from '../src/config/config-manager.js';
import { InMemoryPreferencesStore } from '../src/config/preferences-store.js';
import { InMemorySecretStore } from '../src/config/secret-store.js';

describe('ConfigManager', () => {
  it('validates and returns configuration from environment variables', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'test-api-key',
        COMFYUI_BASE_URL: 'http://comfy.local:8000',
        AUDIO_INPUT_DEVICE_ID: 'input-device',
        AUDIO_OUTPUT_DEVICE_ID: 'output-device',
        FEATURE_FLAGS: '{"transcriptOverlay": false}',
        WAKE_WORD_MODEL: 'alexa',
        WAKE_WORD_THRESHOLD: '0.55',
        WAKE_WORD_COOLDOWN_MS: '2500',
        WAKE_WORD_DEVICE_INDEX: '2',
      } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();

    expect(config.audioInputDeviceId).toBe('input-device');
    expect(config.audioOutputDeviceId).toBe('output-device');
    expect(config.comfyUiBaseUrl).toBe('http://comfy.local:8000');
    expect(config.wakeWord).toEqual({
      model: 'alexa',
      keywordLabel: 'Alexa',
      threshold: 0.55,
      cooldownMs: 2500,
      deviceIndex: 2,
    });
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
        AUDIO_INPUT_DEVICE_ID: 'env-input',
        AUDIO_OUTPUT_DEVICE_ID: 'env-output',
        FEATURE_FLAGS: '{"transcriptOverlay": false}',
        WAKE_WORD_MODEL: 'alexa',
        WAKE_WORD_THRESHOLD: '0.55',
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
  });

  it('falls back to secret store when environment variable is missing', async () => {
    const secretStore = new InMemorySecretStore();
    await secretStore.setSecret('REALTIME_API_KEY', 'stored-key');

    const manager = new ConfigManager({
      env: { WAKE_WORD_MODEL: 'Hey Mycroft' } as NodeJS.ProcessEnv,
      secretStore,
    });

    const config = await manager.load();
    expect(config.realtimeApiKey).toBe('stored-key');
    expect(config.comfyUiBaseUrl).toBe('http://127.0.0.1:8188');
    expect(config.wakeWord.model).toBe('hey_mycroft');
    expect(config.wakeWord.keywordLabel).toBe('Hey Mycroft');
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

  it('parses metrics configuration from environment variables', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'key',
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

  it('defaults to the bundled hey_jarvis wake word model', async () => {
    const manager = new ConfigManager({ env: {} as NodeJS.ProcessEnv });

    const config = await manager.load();
    expect(config.wakeWord).toEqual({
      model: 'hey_jarvis',
      keywordLabel: 'Hey Jarvis',
      threshold: 0.5,
      cooldownMs: 1500,
      deviceIndex: undefined,
    });
    expect(manager.getRendererConfig().wakeWord.model).toBe('hey_jarvis');
  });

  it('accepts a custom openWakeWord model path and derives its label', async () => {
    const manager = new ConfigManager({
      env: { WAKE_WORD_MODEL: 'models/hey_echo_v0.2.onnx' } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();
    expect(config.wakeWord.model).toBe(path.resolve('models/hey_echo_v0.2.onnx'));
    expect(config.wakeWord.keywordLabel).toBe('Hey Echo');
  });

  it('throws a validation error for an unknown wake word model', async () => {
    const manager = new ConfigManager({
      env: { WAKE_WORD_MODEL: 'bumblebee' } as NodeJS.ProcessEnv,
    });

    await expect(manager.load()).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('loads with an empty realtime api key and marks the renderer config as unconfigured', async () => {
    const manager = new ConfigManager({
      env: {} as NodeJS.ProcessEnv,
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
      } as NodeJS.ProcessEnv,
    });

    const config = await manager.load();

    expect(config.realtimeApiKey).toBe('realtime-key');
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
    } as NodeJS.ProcessEnv;

    const manager = new ConfigManager({ env, logger });

    await manager.load();

    expect(logger.debug).toHaveBeenCalledWith(
      'Realtime API key resolved from environment variables.',
      expect.objectContaining({ length: env.REALTIME_API_KEY.length }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Configuration loaded.',
      expect.objectContaining({
        hasRealtimeApiKey: true,
        wakeWordModel: 'hey_jarvis',
      }),
    );

    for (const call of [...logger.debug.mock.calls, ...logger.info.mock.calls]) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(env.REALTIME_API_KEY);
    }
  });

  it('updates and persists audio device preferences', async () => {
    const preferencesStore = new InMemoryPreferencesStore();
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'api',
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
      } as NodeJS.ProcessEnv,
      secretStore,
    });

    await manager.load();

    const rendererConfig = await manager.setSecret('realtimeApiKey', ' updated-key ');
    expect(rendererConfig.hasRealtimeApiKey).toBe(true);
    await expect(secretStore.getSecret('REALTIME_API_KEY')).resolves.toBe('updated-key');
    await expect(manager.getSecret('realtimeApiKey')).resolves.toBe('updated-key');
  });

  it('throws when attempting to persist secrets without a configured store', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'initial',
      } as NodeJS.ProcessEnv,
    });

    await manager.load();

    await expect(manager.setSecret('realtimeApiKey', 'next')).rejects.toThrow('Secret store is not configured');
  });

  it('tests realtime api keys using the configured OpenAI client', async () => {
    const secretStore = new InMemorySecretStore();
    const modelsList = vi.fn().mockResolvedValue({ data: [] });
    const openAIClientFactory = vi.fn().mockReturnValue({
      models: {
        list: modelsList,
      },
    });
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'live-key',
      } as NodeJS.ProcessEnv,
      secretStore,
      openAIClientFactory,
    });

    await manager.load();

    const result = await manager.testSecret('realtimeApiKey');
    expect(openAIClientFactory).toHaveBeenCalledWith('live-key');
    expect(modelsList).toHaveBeenCalledWith({ limit: 1 });
    expect(result).toEqual({ ok: true, message: 'Realtime API key verified successfully.' });
  });

  it('returns a helpful error when testing an unconfigured realtime api key', async () => {
    const fetchMock = vi.fn();
    const manager = new ConfigManager({
      env: {} as NodeJS.ProcessEnv,
      fetchFn: fetchMock,
    });

    await manager.load();

    const result = await manager.testSecret('realtimeApiKey');
    expect(result).toEqual({ ok: false, message: 'Realtime API key is not configured.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports when no OpenAI client is available for realtime key testing', async () => {
    const manager = new ConfigManager({
      env: {
        REALTIME_API_KEY: 'configured-key',
      } as NodeJS.ProcessEnv,
    });

    await manager.load();

    const result = await manager.testSecret('realtimeApiKey');
    expect(result).toEqual({ ok: false, message: 'Secret testing is unavailable: no OpenAI client configured.' });
  });

  it('defaults the conversation to the local LLM and lets env or a saved choice override it', async () => {
    const defaults = await new ConfigManager({ env: {} as NodeJS.ProcessEnv }).load();
    expect(defaults.conversationBackend).toBe('local');
    expect(defaults.localConversation).toEqual({
      llmBaseUrl: 'http://127.0.0.1:1234/v1',
      llmModel: 'qwen-next-flash',
      speechServiceUrl: 'http://127.0.0.1:8192',
      voice: undefined,
      webSearchProvider: undefined,
      searxngUrl: undefined,
      braveSearchApiKey: undefined,
    });

    const fromEnv = await new ConfigManager({ env: { CONVERSATION_BACKEND: 'OpenAI' } as NodeJS.ProcessEnv }).load();
    expect(fromEnv.conversationBackend).toBe('openai');

    await expect(
      new ConfigManager({ env: { CONVERSATION_BACKEND: 'cloud' } as NodeJS.ProcessEnv }).load(),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('keeps a chosen conversation backend when other preferences are saved', async () => {
    const preferencesStore = new InMemoryPreferencesStore();
    const manager = new ConfigManager({ env: {} as NodeJS.ProcessEnv, preferencesStore });
    await manager.load();

    const chosen = await manager.setAudioDevicePreferences({ conversationBackend: 'openai' });
    expect(chosen.conversationBackend).toBe('openai');
    const later = await manager.setAudioDevicePreferences({ audioInputDeviceId: 'mic-2' });
    expect(later.conversationBackend).toBe('openai');
    expect((await preferencesStore.load()).conversationBackend).toBe('openai');
    expect(later).not.toHaveProperty('localConversation');
  });
});
