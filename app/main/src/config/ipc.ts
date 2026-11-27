import { ipcMain } from 'electron';
import { ConfigManager } from './config-manager.js';
import type { ConfigSecretKey, RendererConfig } from '../shared/config/config-manager-types.js';
import type {
  RealtimeEphemeralTokenRequest,
  RealtimeEphemeralTokenResponse,
} from '../shared/realtime/types.js';
import type { ProviderSettingsPatch } from '../shared/config/provider-settings.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';
import type { Logger } from 'winston';

export interface ConfigIpcOptions {
  handle: HandleIpc;
  logger: Logger;
  manager: ConfigManager;
  applyProviderSettings: () => Promise<void>;
  refreshPoseGenerationService: () => Promise<void>;
}

export function registerConfigIpc(options: ConfigIpcOptions): void {
  const { handle, logger, manager, applyProviderSettings, refreshPoseGenerationService } = options;

  const configChannels = [
    'config:get',
    'config:get-secret',
    'config:set-secret',
    'config:test-secret',
    'config:set-audio-devices',
    'config:clear-secret',
    'config:set-providers',
  ] as const;

  logger.info('Initializing configuration bridge IPC handlers.', {
    channels: [...configChannels],
  });

  const summarizeRendererConfig = (config: RendererConfig) => ({
    hasRealtimeApiKey: config.hasRealtimeApiKey,
    wakeWordModel: config.wakeWord?.model ?? null,
    audioInputConfigured: Boolean(config.audioInputDeviceId),
    audioOutputConfigured: Boolean(config.audioOutputDeviceId),
    realtimeModel: config.realtimeModel ?? null,
    realtimeVoice: config.realtimeVoice ?? null,
    hasInstructions: Boolean(config.sessionInstructions && config.sessionInstructions.length > 0),
    vad: {
      turnDetection: config.vadTurnDetection ?? 'none',
      threshold: typeof config.vadThreshold === 'number' ? config.vadThreshold : null,
      silenceMs:
        typeof config.vadSilenceDurationMs === 'number' ? config.vadSilenceDurationMs : null,
      minSpeechMs:
        typeof config.vadMinSpeechDurationMs === 'number' ? config.vadMinSpeechDurationMs : null,
    },
    featureFlagKeys: Object.keys(config.featureFlags ?? {}),
  });

  const sanitizePayload = (
    channel: (typeof configChannels)[number],
    args: unknown[],
  ): Record<string, unknown> | undefined => {
    if (channel === 'config:set-secret') {
      const [payload] = args as [{ key?: ConfigSecretKey; value?: string } | undefined];
      return {
        key: payload?.key,
        valueLength: typeof payload?.value === 'string' ? payload.value.trim().length : undefined,
      };
    }

    if (
      channel === 'config:get-secret' ||
      channel === 'config:test-secret' ||
      channel === 'config:clear-secret'
    ) {
      const [key] = args as [ConfigSecretKey | undefined];
      return { key };
    }

    if (channel === 'config:set-audio-devices') {
      const [preferences] = args as [
        | {
            audioInputDeviceId?: string | null;
            audioOutputDeviceId?: string | null;
            realtimeModel?: string | null;
            realtimeVoice?: string | null;
            sessionInstructions?: string | null;
            vadTurnDetection?: 'none' | 'server_vad' | null;
            vadThreshold?: number | null;
            vadSilenceDurationMs?: number | null;
            vadMinSpeechDurationMs?: number | null;
          }
        | undefined,
      ];
      return {
        hasInput: Boolean(preferences?.audioInputDeviceId),
        hasOutput: Boolean(preferences?.audioOutputDeviceId),
        hasModel: Boolean(preferences?.realtimeModel),
        hasVoice: Boolean(preferences?.realtimeVoice),
        hasInstructions: Boolean(preferences?.sessionInstructions),
        vad: {
          turnDetection: preferences?.vadTurnDetection ?? null,
          threshold: typeof preferences?.vadThreshold === 'number',
          silenceMs: typeof preferences?.vadSilenceDurationMs === 'number',
          minSpeechMs: typeof preferences?.vadMinSpeechDurationMs === 'number',
        },
      };
    }

    return undefined;
  };

  const sanitizeResult = (
    channel: (typeof configChannels)[number],
    result: unknown,
    args: unknown[],
  ): Record<string, unknown> | undefined => {
    if (
      channel === 'config:get' ||
      channel === 'config:set-secret' ||
      channel === 'config:set-audio-devices' ||
      channel === 'config:clear-secret' ||
      channel === 'config:set-providers'
    ) {
      if (result && typeof result === 'object') {
        return summarizeRendererConfig(result as RendererConfig);
      }
      return undefined;
    }

    if (channel === 'config:get-secret') {
      const [key] = args as [ConfigSecretKey | undefined];
      return {
        key,
        length: typeof result === 'string' ? result.length : undefined,
        present: typeof result === 'string' ? result.length > 0 : false,
      };
    }

    if (channel === 'config:test-secret') {
      if (result && typeof result === 'object' && 'ok' in result) {
        return {
          ok: Boolean((result as { ok: boolean }).ok),
          hasMessage: Boolean((result as { message?: string }).message),
        };
      }
    }

    return undefined;
  };

  const registerConfigHandler = (
    channel: (typeof configChannels)[number],
    handler: Parameters<(typeof ipcMain)['handle']>[1],
  ) => {
    logger.debug('Registering configuration IPC handler.', { channel });

    const instrumentedHandler: Parameters<(typeof ipcMain)['handle']>[1] = async (
      event,
      ...args
    ) => {
      logger.debug('Configuration IPC handler invoked.', {
        channel,
        payload: sanitizePayload(channel, args),
      });

      try {
        const result: unknown = await (
          handler as (event: unknown, ...args: unknown[]) => Promise<unknown>
        )(event, ...args);
        logger.debug('Configuration IPC handler completed.', {
          channel,
          result: sanitizeResult(channel, result, args),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error('Configuration IPC handler failed.', {
          channel,
          message,
          ...(stack ? { stack } : {}),
        });
        throw error;
      }
    };

    try {
      handle(channel, instrumentedHandler);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to register configuration IPC handler.', {
        channel,
        message,
        ...(stack ? { stack } : {}),
      });
      throw error;
    }
  };

  registerConfigHandler('config:get', () => manager.getRendererConfig());
  registerConfigHandler('config:get-secret', (_event, key: ConfigSecretKey) =>
    manager.getSecret(key),
  );
  registerConfigHandler(
    'config:set-secret',
    async (_event, payload: { key: ConfigSecretKey; value: string }) => {
      const nextConfig = await manager.setSecret(payload.key, payload.value);

      if (payload.key === 'realtimeApiKey') {
        await applyProviderSettings();
        await refreshPoseGenerationService();
      }

      return nextConfig;
    },
  );
  registerConfigHandler('config:clear-secret', async (_event, key: ConfigSecretKey) => {
    const nextConfig = await manager.clearSecret(key);
    await applyProviderSettings();
    await refreshPoseGenerationService();
    return nextConfig;
  });
  registerConfigHandler('config:set-providers', async (_event, patch: ProviderSettingsPatch) => {
    const nextConfig = await manager.setProviderSettings(patch ?? {});
    await applyProviderSettings();
    return nextConfig;
  });
  registerConfigHandler('config:test-secret', (_event, key: ConfigSecretKey) =>
    manager.testSecret(key),
  );
  registerConfigHandler('config:set-audio-devices', (_event, preferences) =>
    manager.setAudioDevicePreferences(preferences),
  );

  handle(
    'realtime:mint-ephemeral-token',
    async (_event, payload: RealtimeEphemeralTokenRequest) => {
      if (
        !payload ||
        typeof payload !== 'object' ||
        !payload.session ||
        typeof payload.session !== 'object'
      ) {
        throw new Error('Invalid realtime token request payload received.');
      }

      const apiKey = manager.getConfig().realtimeApiKey?.trim();
      if (!apiKey) {
        throw new Error('Realtime API key is not configured.');
      }

      const session = payload.session as Record<string, unknown>;
      const audio =
        typeof session.audio === 'object' && session.audio
          ? (session.audio as Record<string, unknown>)
          : null;
      const audioOutput =
        audio && typeof audio.output === 'object' && audio.output
          ? (audio.output as Record<string, unknown>)
          : null;
      const voice =
        typeof audioOutput?.voice === 'string' ? (audioOutput.voice as string) : undefined;
      const turnDetection =
        typeof session.turn_detection === 'object' && session.turn_detection
          ? (session.turn_detection as { type?: unknown }).type
          : undefined;
      if (session.turn_detection) {
        delete session.turn_detection;
      }

      if (session.session_parameters) {
        delete session.session_parameters;
      }

      if (audio && typeof audio === 'object' && 'input' in audio) {
        delete (audio as Record<string, unknown>).input;
        if (Object.keys(audio).length === 0) {
          delete session.audio;
        }
      }

      logger.info('Minting realtime ephemeral token.', {
        model: typeof session.model === 'string' ? session.model : undefined,
        voice,
        hasInstructions: Boolean(session.instructions),
        turnDetection: typeof turnDetection === 'string' ? turnDetection : undefined,
        outputModalities: Array.isArray(session.output_modalities)
          ? session.output_modalities
          : undefined,
      });

      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ session }),
      });

      const contentTypeHeader = response.headers?.get?.('content-type') ?? '';
      const normalizedContentType = contentTypeHeader.toLowerCase();
      let responseBody: unknown = null;
      let rawText: string | undefined;

      try {
        if (normalizedContentType.includes('application/json')) {
          responseBody = await response.json();
        } else {
          rawText = await response.text();
        }
      } catch (error) {
        logger.warn('Failed to parse realtime token response body.', {
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (!response.ok) {
        const detail =
          typeof responseBody === 'object' && responseBody && 'error' in responseBody
            ? JSON.stringify((responseBody as { error?: unknown }).error)
            : rawText;
        logger.error('Realtime token request failed.', {
          status: response.status,
          detail: detail ? detail.slice(0, 500) : undefined,
        });
        throw new Error(`Realtime token request failed: HTTP ${response.status}`);
      }

      const value =
        typeof (responseBody as { value?: unknown } | null)?.value === 'string'
          ? ((responseBody as { value?: string }).value as string)
          : undefined;
      if (!value) {
        throw new Error('Realtime token response missing value.');
      }

      const expiresAt =
        typeof (responseBody as { expires_at?: unknown; expiresAt?: unknown } | null)
          ?.expires_at === 'number'
          ? ((responseBody as { expires_at?: number }).expires_at as number)
          : typeof (responseBody as { expiresAt?: unknown } | null)?.expiresAt === 'number'
            ? ((responseBody as { expiresAt?: number }).expiresAt as number)
            : undefined;

      const result: RealtimeEphemeralTokenResponse = {
        value,
        ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
      };

      return result;
    },
  );

  logger.info('Configuration bridge IPC handlers registered.', {
    channels: [...configChannels],
  });
}
