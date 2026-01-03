import { app, BrowserWindow, Tray, dialog, ipcMain } from 'electron';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigManager,
  ConfigValidationError,
  type ConfigSecretKey,
  type RendererConfig,
} from './config/config-manager.js';
import { KeytarSecretStore } from './config/keytar-secret-store.js';
import { InMemorySecretStore } from './config/secret-store.js';
import { FilePreferencesStore } from './config/preferences-store.js';
import { initializeLogger } from './logging/logger.js';
import { createAppDiagnostics } from './logging/app-diagnostics.js';
import { CrashGuard } from './crash-guard.js';
import { WakeWordService } from './wake-word/wake-word-service.js';
import { ConversationManager } from './conversation/conversation-manager.js';
import type {
  ConversationAppendMessagePayload,
  ConversationMessage,
  ConversationSession,
} from './conversation/types.js';
import { MemoryStore } from './memory/index.js';
import { PrometheusCollector } from './metrics/prometheus-collector.js';
import type { LatencyObservation } from './metrics/types.js';
import type { RealtimeEphemeralTokenRequest, RealtimeEphemeralTokenResponse } from './realtime/types.js';
import { AutoLaunchManager } from './lifecycle/auto-launch.js';
import { createDevTray } from './lifecycle/dev-tray.js';
import { AvatarModelService } from './avatar/avatar-model-service.js';
import { AvatarAnimationService } from './avatar/avatar-animation-service.js';
import { VrmaGenerationService } from './avatar/vrma-generation-service.js';
import { AvatarPoseService } from './avatar/avatar-pose-service.js';
import { PoseGenerationService } from './avatar/pose-generation-service.js';
import { AvatarDescriptionService } from './avatar/avatar-description-service.js';
import type {
  AvatarModelSummary,
  AvatarModelUploadRequest,
  AvatarModelUploadResult,
  AvatarAnimationSummary,
  AvatarAnimationUploadRequest,
  AvatarAnimationUploadResult,
  AvatarAnimationGenerationRequest,
  AvatarPoseSummary,
  AvatarPoseUploadRequest,
  AvatarPoseGenerationRequest,
} from './avatar/types.js';
import {
  resolvePreloadScriptPath,
  resolveRendererEntryPoint,
  RuntimeResourceNotFoundError,
} from './runtime-paths.js';
import { getOpenAIClient } from './openai/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = app.isPackaged || process.env.NODE_ENV === 'production';
const APP_NAME = 'AI Embodied Assistant';

interface CameraDetectionEventPayload {
  cue: string;
  timestamp?: number;
  confidence?: number;
  provider?: string;
  payload?: Record<string, unknown> | null;
}

if (!isProduction) {
  const repoRoot = path.resolve(__dirname, '../../..');
  dotenv.config({ path: path.join(repoRoot, '.env') });
}

const secretStore = isProduction ? new KeytarSecretStore('aiembodied') : new InMemorySecretStore();
const { logger } = initializeLogger();
// Register a preload diagnostics channel as early as possible to catch messages during renderer bootstrap
try {
  ipcMain.on(
    'diagnostics:preload-log',
    (
      _event,
      payload: { level?: string; message?: string; meta?: Record<string, unknown>; ts?: number },
    ) => {
      const level = (typeof payload?.level === 'string' ? payload.level : 'info').toLowerCase();
      const message = typeof payload?.message === 'string' ? payload.message : 'preload-diagnostics';
      const meta: Record<string, unknown> = {
        from: 'preload',
        ...(payload?.meta ?? {}),
        ...(typeof payload?.ts === 'number' ? { ts: payload.ts } : {}),
      };

      if (level === 'debug') {
        logger.debug(message, meta);
      } else if (level === 'warn') {
        logger.warn(message, meta);
      } else if (level === 'error') {
        logger.error(message, meta);
      } else {
        logger.info(message, meta);
      }
    },
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Logging not yet configured would be unusual here, but fall back to console
  console.warn('Failed to register early preload diagnostics channel', message);
}

const diagnostics = createAppDiagnostics({ logger });
let mainWindow: BrowserWindow | null = null;
let wakeWordService: WakeWordService | null = null;
let memoryStore: MemoryStore | null = null;
let conversationManager: ConversationManager | null = null;
let removeConversationListeners: (() => void) | null = null;
let metricsCollector: PrometheusCollector | null = null;
let autoLaunchManager: AutoLaunchManager | null = null;
let developmentTray: Tray | null = null;
let avatarModelService: AvatarModelService | null = null;
let avatarAnimationService: AvatarAnimationService | null = null;
let avatarPoseService: AvatarPoseService | null = null;
let vrmaGenerationService: VrmaGenerationService | null = null;
let poseGenerationService: PoseGenerationService | null = null;
let avatarDescriptionService: AvatarDescriptionService | null = null;
let currentVrmaApiKey: string | null = null;
let currentDescriptionApiKey: string | null = null;

function emitCameraDetection(event: CameraDetectionEventPayload): boolean {
  const cue = typeof event.cue === 'string' ? event.cue.trim() : '';
  if (!cue) {
    throw new Error('Camera detection payload must include a cue identifier.');
  }

  const timestamp =
    typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : Date.now();

  if (!mainWindow || mainWindow.isDestroyed()) {
    logger.warn('Camera detection event dropped because main window is unavailable.', { cue });
    return false;
  }

  const payload: CameraDetectionEventPayload = {
    cue,
    timestamp,
    confidence: typeof event.confidence === 'number' ? event.confidence : undefined,
    provider: typeof event.provider === 'string' ? event.provider : undefined,
    payload: event.payload ?? null,
  };

  mainWindow.webContents.send('camera:detection', payload);
  logger.info('Camera detection forwarded to renderer.', payload);
  return true;
}

const createWindow = () => {
  let preloadPath: string;
  let rendererEntryPath: string;

  try {
    const preloadResolution = resolvePreloadScriptPath(__dirname);
    preloadPath = preloadResolution.path;
    logger.info('Resolved renderer preload script path.', {
      path: preloadPath,
      attempted: preloadResolution.attempted,
      usedFallback: preloadResolution.usedIndex > 0,
    });

    const rendererResolution = resolveRendererEntryPoint(__dirname);
    rendererEntryPath = rendererResolution.path;
    logger.info('Resolved renderer bundle entry point.', {
      path: rendererEntryPath,
      attempted: rendererResolution.attempted,
      usedFallback: rendererResolution.usedIndex > 0,
    });
  } catch (error) {
    const attempted = error instanceof RuntimeResourceNotFoundError ? error.attempted : undefined;
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to resolve renderer resources.', {
      message,
      ...(attempted ? { attempted } : {}),
    });
    throw error;
  }

  const window = new BrowserWindow({
    width: 1920,
    height: 1080,
    kiosk: isProduction,
    fullscreen: !isProduction,
    fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: '#020617',
    webPreferences: {
      contextIsolation: true,
      preload: preloadPath,
      sandbox: false,
    },
  });

  diagnostics.trackWindow(window);

  // Harden renderer: disallow new windows and external navigation.
  try {
    const wc: unknown = window.webContents as unknown;
    const anyWc = wc as { setWindowOpenHandler?: (handler: () => { action: 'deny' | 'allow' }) => void; on?: (event: string, listener: (...args: unknown[]) => void) => void };
    if (typeof anyWc.setWindowOpenHandler === 'function') {
      anyWc.setWindowOpenHandler(() => {
        logger.warn('Blocked attempt to open a new window from renderer.');
        return { action: 'deny' } as const;
      });
    } else {
      logger.debug('webContents.setWindowOpenHandler unavailable; skipping handler attach.');
    }
    if (typeof anyWc.on === 'function') {
      anyWc.on('will-navigate', (event: unknown, url: unknown) => {
        try {
          (event as { preventDefault?: () => void })?.preventDefault?.();
        } catch (err) {
          // Swallow errors from stubbed event objects in tests
          void err;
        }
        logger.warn('Blocked renderer navigation attempt.', { url });
      });
    } else {
      logger.debug('webContents.on unavailable; skipping will-navigate attach.');
    }
  } catch (err) {
    // Avoid noisy warnings in test environments where webContents may be a stub
    void err;
  }

  if (!isProduction) {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        window.setFullScreen(false);
      }
    });
  }

  window
    .loadFile(rendererEntryPath)
    .then(() => {
      logger.info('Renderer bundle loaded successfully.');
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to load renderer bundle', { message, stack });
    });

  window.on('ready-to-show', () => {
    logger.info('Main window ready to show.');
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  mainWindow = window;
  return window;
};

const crashGuard = new CrashGuard({
  createWindow,
  logger,
});

async function refreshVrmaGenerationService(
  manager: ConfigManager,
  reason: 'startup' | 'secret-update' = 'startup',
): Promise<void> {
  const config = manager.getConfig();
  const nextKey = typeof config.realtimeApiKey === 'string' ? config.realtimeApiKey.trim() : '';

  if (!nextKey) {
    if (reason === 'startup') {
      logger.warn('Realtime API key unavailable; VRMA generation disabled.');
    } else if (vrmaGenerationService || currentVrmaApiKey) {
      logger.warn('Realtime API key removed; VRMA generation disabled.');
    }
    vrmaGenerationService = null;
    currentVrmaApiKey = null;
    return;
  }

  if (!avatarAnimationService) {
    logger.warn('Avatar animation service unavailable; VRMA generation cannot be initialized.');
    vrmaGenerationService = null;
    currentVrmaApiKey = null;
    return;
  }

  if (vrmaGenerationService && currentVrmaApiKey === nextKey) {
    return;
  }

  try {
    vrmaGenerationService = new VrmaGenerationService({
      client: getOpenAIClient(nextKey),
      animationService: avatarAnimationService,
      logger,
    });
    currentVrmaApiKey = nextKey;
    logger.info('VRMA generation service initialized.', { reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to initialize VRMA generation service', { message });
    vrmaGenerationService = null;
    currentVrmaApiKey = null;
  }
}

async function refreshPoseGenerationService(
  manager: ConfigManager,
  reason: 'startup' | 'secret-update' = 'startup',
): Promise<void> {
  const config = manager.getConfig();
  const nextKey = typeof config.realtimeApiKey === 'string' ? config.realtimeApiKey.trim() : '';

  if (!nextKey) {
    poseGenerationService = null;
    return;
  }

  if (!avatarPoseService) {
    poseGenerationService = null;
    return;
  }

  if (poseGenerationService && currentVrmaApiKey === nextKey) {
    return;
  }

  try {
    poseGenerationService = new PoseGenerationService({
      client: getOpenAIClient(nextKey),
      poseService: avatarPoseService,
      logger,
    });
    // Reuse currentVrmaApiKey as it tracks the same key
    if (!currentVrmaApiKey) currentVrmaApiKey = nextKey;
    logger.info('Pose generation service initialized.', { reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to initialize pose generation service', { message });
    poseGenerationService = null;
  }
}

async function refreshAvatarDescriptionService(
  manager: ConfigManager,
  reason: 'startup' | 'secret-update' = 'startup',
): Promise<void> {
  const config = manager.getConfig();
  const nextKey = typeof config.realtimeApiKey === 'string' ? config.realtimeApiKey.trim() : '';

  if (!nextKey) {
    if (reason === 'startup') {
      logger.warn('Realtime API key unavailable; avatar description generation disabled.');
    } else if (avatarDescriptionService || currentDescriptionApiKey) {
      logger.warn('Realtime API key removed; avatar description generation disabled.');
    }
    avatarDescriptionService = null;
    currentDescriptionApiKey = null;
    return;
  }

  if (avatarDescriptionService && currentDescriptionApiKey === nextKey) {
    return;
  }

  try {
    avatarDescriptionService = new AvatarDescriptionService({
      client: getOpenAIClient(nextKey),
      logger,
    });
    currentDescriptionApiKey = nextKey;
    logger.info('Avatar description service initialized.', { reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to initialize avatar description service', { message });
    avatarDescriptionService = null;
    currentDescriptionApiKey = null;
  }
}

function registerIpcHandlers(
  manager: ConfigManager,
  conversation: ConversationManager | null,
  metrics: PrometheusCollector | null,
  avatarModels: AvatarModelService | null,
  avatarAnimations: AvatarAnimationService | null,
  avatarPoses: AvatarPoseService | null,
) {
  // Preload diagnostics bridge: allow preload/renderer to forward logs to main logger
  try {
    ipcMain.on('diagnostics:preload-log', (_event, payload: { level?: string; message?: string; meta?: Record<string, unknown>; ts?: number }) => {
      const level = (typeof payload?.level === 'string' ? payload.level : 'info').toLowerCase();
      const message = typeof payload?.message === 'string' ? payload.message : 'preload-diagnostics';
      const meta: Record<string, unknown> = { from: 'preload', ...(payload?.meta ?? {}), ...(typeof payload?.ts === 'number' ? { ts: payload.ts } : {}) };

      if (level === 'debug') {
        logger.debug(message, meta);
      } else if (level === 'warn') {
        logger.warn(message, meta);
      } else if (level === 'error') {
        logger.error(message, meta);
      } else {
        logger.info(message, meta);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to register preload diagnostics channel', { message });
  }
  const configChannels = [
    'config:get',
    'config:get-secret',
    'config:set-secret',
    'config:test-secret',
    'config:set-audio-devices',
  ] as const;

  logger.info('Initializing configuration bridge IPC handlers.', {
    channels: [...configChannels],
  });

  const summarizeRendererConfig = (config: RendererConfig) => ({
    hasRealtimeApiKey: config.hasRealtimeApiKey,
    wakeWordHasAccessKey: config.wakeWord?.hasAccessKey ?? false,
    audioInputConfigured: Boolean(config.audioInputDeviceId),
    audioOutputConfigured: Boolean(config.audioOutputDeviceId),
    realtimeModel: config.realtimeModel ?? null,
    realtimeVoice: config.realtimeVoice ?? null,
    hasInstructions: Boolean(config.sessionInstructions && config.sessionInstructions.length > 0),
    vad: {
      turnDetection: config.vadTurnDetection ?? 'none',
      threshold: typeof config.vadThreshold === 'number' ? config.vadThreshold : null,
      silenceMs: typeof config.vadSilenceDurationMs === 'number' ? config.vadSilenceDurationMs : null,
      minSpeechMs: typeof config.vadMinSpeechDurationMs === 'number' ? config.vadMinSpeechDurationMs : null,
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

    if (channel === 'config:get-secret' || channel === 'config:test-secret') {
      const [key] = args as [ConfigSecretKey | undefined];
      return { key };
    }

    if (channel === 'config:set-audio-devices') {
      const [preferences] = args as [
        { audioInputDeviceId?: string | null; audioOutputDeviceId?: string | null; realtimeModel?: string | null; realtimeVoice?: string | null; sessionInstructions?: string | null; vadTurnDetection?: 'none' | 'server_vad' | null; vadThreshold?: number | null; vadSilenceDurationMs?: number | null; vadMinSpeechDurationMs?: number | null } | undefined,
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
    if (channel === 'config:get' || channel === 'config:set-secret' || channel === 'config:set-audio-devices') {
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

    const instrumentedHandler: Parameters<(typeof ipcMain)['handle']>[1] = async (event, ...args) => {
      logger.debug('Configuration IPC handler invoked.', {
        channel,
        payload: sanitizePayload(channel, args),
      });

      try {
        const result = await handler(event, ...args);
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
      ipcMain.handle(channel, instrumentedHandler);
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
  registerConfigHandler('config:get-secret', (_event, key: ConfigSecretKey) => manager.getSecret(key));
  registerConfigHandler('config:set-secret', async (_event, payload: { key: ConfigSecretKey; value: string }) => {
    const nextConfig = await manager.setSecret(payload.key, payload.value);

    if (payload.key === 'realtimeApiKey') {
      await refreshVrmaGenerationService(manager, 'secret-update');
      await refreshPoseGenerationService(manager, 'secret-update');
    }

    return nextConfig;
  });
  registerConfigHandler('config:test-secret', (_event, key: ConfigSecretKey) => manager.testSecret(key));
  registerConfigHandler('config:set-audio-devices', (_event, preferences) =>
    manager.setAudioDevicePreferences(preferences),
  );

  ipcMain.handle('realtime:mint-ephemeral-token', async (_event, payload: RealtimeEphemeralTokenRequest) => {
    if (!payload || typeof payload !== 'object' || !payload.session || typeof payload.session !== 'object') {
      throw new Error('Invalid realtime token request payload received.');
    }

    const apiKey = manager.getConfig().realtimeApiKey?.trim();
    if (!apiKey) {
      throw new Error('Realtime API key is not configured.');
    }

    const session = payload.session as Record<string, unknown>;
    const audio = typeof session.audio === 'object' && session.audio ? (session.audio as Record<string, unknown>) : null;
    const audioOutput =
      audio && typeof audio.output === 'object' && audio.output ? (audio.output as Record<string, unknown>) : null;
    const voice = typeof audioOutput?.voice === 'string' ? (audioOutput.voice as string) : undefined;
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
      outputModalities: Array.isArray(session.output_modalities) ? session.output_modalities : undefined,
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
      typeof (responseBody as { expires_at?: unknown; expiresAt?: unknown } | null)?.expires_at === 'number'
        ? ((responseBody as { expires_at?: number }).expires_at as number)
        : typeof (responseBody as { expiresAt?: unknown } | null)?.expiresAt === 'number'
          ? ((responseBody as { expiresAt?: number }).expiresAt as number)
          : undefined;

    const result: RealtimeEphemeralTokenResponse = {
      value,
      ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
    };

    return result;
  });

  logger.info('Configuration bridge IPC handlers registered.', {
    channels: [...configChannels],
  });
  ipcMain.handle('conversation:get-history', () => {
    if (!conversation) {
      throw new Error('Conversation manager is not initialized.');
    }
    return conversation.getHistory();
  });
  ipcMain.handle('conversation:append-message', (_event, payload: ConversationAppendMessagePayload) => {
    if (!conversation) {
      throw new Error('Conversation manager is not initialized.');
    }
    return conversation.appendMessage(payload);
  });
  ipcMain.handle('metrics:observe-latency', (_event, payload: LatencyObservation) => {
    if (!metrics) {
      return false;
    }

    if (!payload || typeof payload.valueMs !== 'number') {
      throw new Error('Invalid latency observation payload received.');
    }

    metrics.observeLatency(payload.metric, payload.valueMs);
    return true;
  });
  ipcMain.handle('avatar-model:list', async () => {
    if (!avatarModels) {
      return [] as AvatarModelSummary[];
    }

    return avatarModels.listModels();
  });
  ipcMain.handle('avatar-model:get-active', async () => {
    if (!avatarModels) {
      return null;
    }

    return avatarModels.getActiveModel();
  });
  ipcMain.handle('avatar-model:set-active', async (_event, modelId: string | null) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    return avatarModels.setActiveModel(modelId);
  });
  ipcMain.handle('avatar-model:upload', async (_event, payload: AvatarModelUploadRequest) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    return avatarModels.uploadModel(payload) as Promise<AvatarModelUploadResult>;
  });
  ipcMain.handle('avatar-model:delete', async (_event, modelId: string) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    await avatarModels.deleteModel(modelId);
    return true;
  });
  ipcMain.handle('avatar-model:load', async (_event, modelId: string) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    return avatarModels.loadModelBinary(modelId);
  });
  ipcMain.handle(
    'avatar-model:update-thumbnail',
    async (_event, payload: { modelId: string; thumbnailDataUrl: string }) => {
      if (!avatarModels) {
        throw new Error('Avatar model service is unavailable.');
      }

      return avatarModels.updateThumbnail(payload.modelId, payload.thumbnailDataUrl);
    },
  );
  ipcMain.handle(
    'avatar-model:update-description',
    async (_event, payload: { modelId: string; description: string }) => {
      if (!avatarModels) {
        throw new Error('Avatar model service is unavailable.');
      }

      return avatarModels.updateDescription(payload.modelId, payload.description);
    },
  );
  ipcMain.handle(
    'avatar-model:generate-description',
    async (_event, payload: { thumbnailDataUrl: string }) => {
      if (!avatarDescriptionService) {
        await refreshAvatarDescriptionService(manager, 'secret-update');
      }
      if (!avatarDescriptionService) {
        throw new Error('Avatar description service is unavailable. Ensure REALTIME_API_KEY is set.');
      }

      return avatarDescriptionService.generateDescription(payload.thumbnailDataUrl);
    },
  );
  ipcMain.handle('avatar-animation:list', async () => {
    if (!avatarAnimations) {
      return [] as AvatarAnimationSummary[];
    }

    return avatarAnimations.listAnimations();
  });
  ipcMain.handle('avatar-animation:upload', async (_event, payload: AvatarAnimationUploadRequest) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    return avatarAnimations.uploadAnimation(payload) as Promise<AvatarAnimationUploadResult>;
  });
  ipcMain.handle('avatar-animation:generate', async (_event, payload: AvatarAnimationGenerationRequest) => {
    if (!vrmaGenerationService) {
      await refreshVrmaGenerationService(manager, 'secret-update');
    }
    if (!vrmaGenerationService) {
      throw new Error('VRMA generation service is unavailable. Ensure REALTIME_API_KEY is set.');
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;
    return vrmaGenerationService.generateAnimation({ ...payload, bones, modelDescription });
  });
  ipcMain.handle('avatar-animation:delete', async (_event, animationId: string) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    await avatarAnimations.deleteAnimation(animationId);
    return true;
  });
  ipcMain.handle('avatar-animation:rename', async (_event, animationId: string, newName: string) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    return avatarAnimations.renameAnimation(animationId, newName);
  });
  ipcMain.handle('avatar-animation:load', async (_event, animationId: string) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    return avatarAnimations.loadAnimationBinary(animationId);
  });
  ipcMain.handle('avatar-pose:list', async () => {
    if (!avatarPoses) {
      return [] as AvatarPoseSummary[];
    }

    return avatarPoses.listPoses();
  });
  ipcMain.handle('avatar-pose:upload', async (_event, payload: AvatarPoseUploadRequest) => {
    if (!avatarPoses) {
      throw new Error('Avatar pose service is unavailable.');
    }

    return avatarPoses.uploadPose(payload);
  });
  ipcMain.handle('avatar-pose:generate', async (_event, payload: AvatarPoseGenerationRequest) => {
    if (!poseGenerationService) {
      await refreshPoseGenerationService(manager, 'secret-update');
    }
    if (!poseGenerationService) {
      throw new Error('Pose generation service is unavailable. Ensure REALTIME_API_KEY is set.');
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const boneHierarchy = avatarModels ? await avatarModels.listActiveModelBoneHierarchy() : {};
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;
    return poseGenerationService.generatePose({ ...payload, bones, boneHierarchy, modelDescription });
  });
  ipcMain.handle('avatar-pose:delete', async (_event, poseId: string) => {
    if (!avatarPoses) {
      throw new Error('Avatar pose service is unavailable.');
    }

    await avatarPoses.deletePose(poseId);
    return true;
  });
  ipcMain.handle('avatar-pose:load', async (_event, poseId: string) => {
    if (!avatarPoses) {
      throw new Error('Avatar pose service is unavailable.');
    }

    return avatarPoses.loadPose(poseId);
  });
  ipcMain.handle('avatar:trigger-behavior', async (_event, cue: string) => {
    const value = typeof cue === 'string' ? cue.trim() : '';
    if (!value) {
      throw new Error('Invalid avatar behavior cue received.');
    }

    logger.info('Avatar behavior cue requested.', { cue: value });
    emitCameraDetection({
      cue: value,
      timestamp: Date.now(),
      confidence: 1,
      provider: 'behavior-trigger',
      payload: { origin: 'avatar:trigger-behavior' },
    });
    return true;
  });
  ipcMain.handle('camera:emit-detection', async (_event, payload: CameraDetectionEventPayload) => {
    if (!payload || typeof payload.cue !== 'string') {
      throw new Error('Invalid camera detection payload received.');
    }

    const cue = payload.cue.trim();
    if (!cue) {
      throw new Error('Camera detection cue cannot be empty.');
    }

    const emitted = emitCameraDetection({
      cue,
      timestamp: payload.timestamp,
      confidence: payload.confidence,
      provider: payload.provider ?? 'camera-bridge',
      payload: payload.payload ?? null,
    });

    return emitted;
  });
}

function focusExistingWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger.warn('Main window missing on second-instance event. Relaunching.');
    const window = createWindow();
    crashGuard.watch(window);
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  logger.warn('Another instance of aiembodied is already running. Quitting.');
  app.quit();
} else {
  logger.info('Primary instance lock acquired.');
  app.on('second-instance', () => {
    focusExistingWindow();
  });
}

app.whenReady().then(async () => {
  const manager = new ConfigManager({
    secretStore,
    preferencesStore: new FilePreferencesStore(path.join(app.getPath('userData'), 'preferences.json')),
    logger,
    openAIClientFactory: getOpenAIClient,
  });

  try {
    memoryStore = new MemoryStore({ filePath: path.join(app.getPath('userData'), 'memory.db') });
    avatarModelService = new AvatarModelService({
      store: memoryStore,
      modelsDirectory: path.join(app.getPath('userData'), 'vrm-models'),
      logger,
    });
    avatarAnimationService = new AvatarAnimationService({
      store: memoryStore,
      animationsDirectory: path.join(app.getPath('userData'), 'vrma-animations'),
      logger,
    });
    avatarPoseService = new AvatarPoseService({
      store: memoryStore,
      posesDirectory: path.join(app.getPath('userData'), 'vrm-poses'),
      logger,
    });
    conversationManager = new ConversationManager({
      store: memoryStore,
      logger,
    });

    // Seed default model if this is the first run
    const defaultModelAssetPath = path.join(__dirname, '../assets/vrm-models/default-avatar.vrm');
    await avatarModelService.seedDefaultModelIfMissing(defaultModelAssetPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database initialization error occurred.';
    logger.error('Failed to initialize memory store', { message });
    dialog.showErrorBox('Database Error', message);
    app.quit();
    return;
  }

  try {
    await manager.load();
  } catch (error) {
    const message =
      error instanceof ConfigValidationError || error instanceof Error
        ? error.message
        : 'Unknown configuration error occurred.';
    logger.error('Configuration validation failed', { message });
    dialog.showErrorBox('Configuration Error', message);
    app.quit();
    return;
  }

  const appConfig = manager.getConfig();

  await refreshVrmaGenerationService(manager);
  await refreshPoseGenerationService(manager);

  autoLaunchManager = new AutoLaunchManager({
    logger,
    appName: APP_NAME,
    appPath: app.getPath('exe'),
  });

  const shouldEnableAutoLaunch = isProduction || process.env.ENABLE_AUTO_LAUNCH === '1';
  const launchEnabled = await autoLaunchManager.sync(shouldEnableAutoLaunch);
  logger.info('Auto-launch synchronization complete.', { enabled: launchEnabled });

  if (!isProduction) {
    try {
      developmentTray = await createDevTray({
        autoLaunchManager,
        logger,
        onQuit: () => {
          app.quit();
        },
        onShowWindow: () => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            const newWindow = createWindow();
            crashGuard.watch(newWindow);
            return;
          }

          focusExistingWindow();
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to create development tray', { message });
    }
  }

  if (appConfig.metrics.enabled) {
    metricsCollector = new PrometheusCollector({
      host: appConfig.metrics.host,
      port: appConfig.metrics.port,
      path: appConfig.metrics.path,
      logger,
    });

    try {
      await metricsCollector.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to start metrics exporter', { message });
      metricsCollector = null;
    }
  }

  wakeWordService = new WakeWordService({
    logger,
    cooldownMs: appConfig.wakeWord.cooldownMs,
    minConfidence: appConfig.wakeWord.minConfidence,
  });

  wakeWordService.on('wake', (event) => {
    logger.info('Wake word detected in main process', {
      keyword: event.keywordLabel,
      confidence: event.confidence,
    });

    let sessionId: string | null = null;
    if (conversationManager) {
      try {
        const session = conversationManager.startSession({ startedAt: event.timestamp });
        sessionId = session.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to start new conversation session', { message });
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('wake-word:event', {
        ...event,
        sessionId: sessionId ?? event.sessionId,
      });
    }
  });

  wakeWordService.on('error', (serviceError) => {
    logger.error('Wake word service error', {
      message: serviceError.message,
      stack: serviceError.stack,
    });
  });

  wakeWordService.on('ready', (info) => {
    logger.info('Wake word service ready', info);
  });

  try {
    wakeWordService.start({
      accessKey: appConfig.wakeWord.accessKey,
      keywordPath: appConfig.wakeWord.keywordPath,
      keywordLabel: appConfig.wakeWord.keywordLabel,
      sensitivity: appConfig.wakeWord.sensitivity,
      modelPath: appConfig.wakeWord.modelPath,
      deviceIndex: appConfig.wakeWord.deviceIndex,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start wake word service', {
      message,
    });
  }

  try {
    registerIpcHandlers(
      manager,
      conversationManager,
      metricsCollector,
      avatarModelService,
      avatarAnimationService,
      avatarPoseService,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown IPC handler registration error occurred.';
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error('Failed to register IPC handlers', {
      message,
      ...(stack ? { stack } : {}),
    });
    dialog.showErrorBox('IPC Error', message);
    app.quit();
    return;
  }

  const configSnapshot = manager.getConfig();
  logger.info('Renderer bridge readiness state.', {
    config: {
      hasRealtimeApiKey: Boolean(configSnapshot.realtimeApiKey),
      hasWakeWordAccessKey: Boolean(configSnapshot.wakeWord.accessKey),
    },
    avatar: { enabled: Boolean(avatarModelService) },
    conversation: { enabled: Boolean(conversationManager) },
    metrics: { enabled: Boolean(metricsCollector) },
  });

  if (conversationManager) {
    const sessionListener = (session: ConversationSession) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('conversation:session-started', session);
      }
    };

    const messageListener = (message: ConversationMessage) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('conversation:message-appended', message);
      }
    };

    conversationManager.on('session-started', sessionListener);
    conversationManager.on('message-appended', messageListener);
    removeConversationListeners = () => {
      conversationManager?.off('session-started', sessionListener);
      conversationManager?.off('message-appended', messageListener);
      removeConversationListeners = null;
    };
  }
  let window: BrowserWindow;
  try {
    window = createWindow();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown renderer bootstrap error occurred while creating the window.';
    logger.error('Failed to create main window.', { message });
    dialog.showErrorBox('Window Creation Error', message);
    app.quit();
    return;
  }
  crashGuard.watch(window);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWindow = createWindow();
      crashGuard.watch(newWindow);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let isAppQuitting = false;

app.on('before-quit', async (event) => {
  if (isAppQuitting) {
    return;
  }

  // Prevent default quit to allow async cleanup
  event.preventDefault();
  isAppQuitting = true;

  logger.info('Application shutdown sequence initiated.');

  diagnostics.dispose();
  crashGuard.notifyAppQuitting();

  // Async cleanup tasks
  const cleanupTasks: Promise<void>[] = [];

  if (wakeWordService) {
    cleanupTasks.push(
      wakeWordService.dispose().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to dispose wake word service during shutdown', { message });
      }),
    );
  }

  if (metricsCollector) {
    cleanupTasks.push(
      metricsCollector.stop().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to stop metrics exporter cleanly', { message });
      }),
    );
  }

  // Synchronous cleanup
  if (memoryStore) {
    try {
      memoryStore.dispose();
      memoryStore = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to dispose memory store', { message });
    }
  }

  if (removeConversationListeners) {
    removeConversationListeners();
  }
  conversationManager = null;

  if (developmentTray) {
    developmentTray.destroy();
    developmentTray = null;
  }

  // Wait for all async cleanup to finish
  if (cleanupTasks.length > 0) {
    try {
      // Set a timeout to force quit if cleanup hangs
      await Promise.race([
        Promise.all(cleanupTasks),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch (error) {
      // Should be caught by individual catch blocks, but just in case
      logger.warn('Error during shutdown cleanup tasks', { error });
    }
  }

  logger.info('Application cleanup complete. Quitting now.');
  app.quit();
});
