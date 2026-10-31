import { BackgroundService } from './backgrounds/background-service.js';
import { app, BrowserWindow, Tray, dialog, globalShortcut, ipcMain } from 'electron';
import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ConfigManager,
  ConfigValidationError,
  type ConfigSecretKey,
  type RendererConfig,
  type WakeWordConfig,
} from './config/config-manager.js';
import { KeytarSecretStore } from './config/keytar-secret-store.js';
import { InMemorySecretStore } from './config/secret-store.js';
import { FilePreferencesStore } from './config/preferences-store.js';
import { initializeLogger } from './logging/logger.js';
import { createAppDiagnostics } from './logging/app-diagnostics.js';
import { CrashGuard } from './crash-guard.js';
import { WakeWordService } from './wake-word/wake-word-service.js';
import { WakeWordTrainer } from './wake-word/wake-word-trainer.js';
import { listWakeWords } from './wake-word/wake-word-library.js';
import { resolveOpenWakeWordModelPaths } from './wake-word/open-wake-word.js';
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
import { PoseEvaluationService } from './avatar/pose-evaluation-service.js';
import { AvatarDescriptionService } from './avatar/avatar-description-service.js';
import { AvatarGenerationService } from './avatar/generation/avatar-generation-service.js';
import { ComfyUIClient } from './avatar/generation/comfyui-client.js';
import { BlenderCharacterRunner } from './avatar/generation/character/rig-runner.js';
import { AvatarImageModelService, createImageModelScanner } from './avatar/generation/image-model-service.js';
import { ComfyUIRuntime } from './avatar/generation/comfyui-runtime.js';
import { LocalMotionClient } from './avatar/motion/local-motion-client.js';
import { LocalMotionGenerationService } from './avatar/motion/local-motion-generation-service.js';
import { LocalVoiceService } from './local-voice/local-voice-service.js';
import { buildVoiceEngines } from './local-voice/voice-engines.js';
import { describeProviders, type ProviderSettingsPatch } from './config/provider-settings.js';
import type { LocalVoiceRespondRequest } from './local-voice/types.js';
import type {
  AvatarModelSummary,
  AvatarModelUploadRequest,
  AvatarModelUploadResult,
  AvatarAnimationSummary,
  AvatarAnimationUploadRequest,
  AvatarAnimationUploadResult,
  AvatarAnimationGenerationRequest,
  AvatarMotionStatus,
  AvatarMotionStreamRequest,
  AvatarPoseSummary,
  AvatarPoseUploadRequest,
  AvatarPoseGenerationRequest,
  PoseEvaluationRequest,
  AvatarGenerationRequest,
  AvatarGenerationJob,
  AvatarGenerationStatus,
  AvatarGenerationAcceptance,
} from './avatar/types.js';
import {
  resolvePreloadScriptPath,
  resolveRendererEntryPoint,
  RuntimeResourceNotFoundError,
} from './runtime-paths.js';
import { getOpenAIClient } from './openai/client.js';
import { MCPManager } from './mcp/mcp-manager.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { createWebSearchProvider, createWebSearchTool } from './tools/web-search.js';
import { registerMCPHandlers } from './mcp/ipc-handlers.js';
import { PushToTalkShortcut } from './talk/push-to-talk.js';
import type { TalkTriggerEvent } from './talk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = app.isPackaged || process.env.NODE_ENV === 'production';
const APP_NAME = 'AI Embodied Assistant';
const DEFAULT_MODEL_ASSET_PATH = path.join(__dirname, '../assets/vrm-models/default-avatar.vrm');
// Unpacked from the asar in packaged builds (see electron-builder.yml): onnxruntime reads them natively.
const WAKE_WORD_ASSETS_DIRECTORY = path
  .join(__dirname, '../assets/wake-word')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

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
/** The wake word the running detector listens for, to tell when the Settings page changed it. */
let runningWakeWord: { model: string; threshold: number } | null = null;
let wakeWordTrainer: WakeWordTrainer | null = null;
const pushToTalk = new PushToTalkShortcut({
  globalShortcut,
  onPress: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('talk:trigger', { source: 'shortcut', timestamp: Date.now() } satisfies TalkTriggerEvent);
    }
  },
  onStatus: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('talk:shortcut-status', status);
    }
  },
  logger: { info: (...args) => logger.info(...args), warn: (...args) => logger.warn(...args) },
});
let memoryStore: MemoryStore | null = null;
let conversationManager: ConversationManager | null = null;
let removeConversationListeners: (() => void) | null = null;
let metricsCollector: PrometheusCollector | null = null;
let autoLaunchManager: AutoLaunchManager | null = null;
let developmentTray: Tray | null = null;
let avatarModelService: AvatarModelService | null = null;
let avatarAnimationService: AvatarAnimationService | null = null;
let avatarPoseService: AvatarPoseService | null = null;
let backgroundService: BackgroundService | null = null;
let vrmaGenerationService: VrmaGenerationService | null = null;
let poseGenerationService: PoseGenerationService | null = null;
let poseEvaluationService: PoseEvaluationService | null = null;
let avatarDescriptionService: AvatarDescriptionService | null = null;
let avatarImageModels: AvatarImageModelService | undefined;
let avatarGenerationService: AvatarGenerationService | null = null;
let localMotionService: LocalMotionGenerationService | null = null;
let localVoiceService: LocalVoiceService | null = null;
let currentVrmaApiKey: string | null = null;
let currentVrmaModel: string | null = null;
let currentMotionServiceUrl: string | null = null;
let currentDescriptionApiKey: string | null = null;

let toolRegistry: ToolRegistry | null = null;
let mcpManager: MCPManager | null = null;

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

  const model = config.providers.motion.openaiModel;
  if (vrmaGenerationService && currentVrmaApiKey === nextKey && currentVrmaModel === model) {
    return;
  }

  try {
    vrmaGenerationService = new VrmaGenerationService({
      client: getOpenAIClient(nextKey),
      animationService: avatarAnimationService,
      model,
      logger,
    });
    currentVrmaApiKey = nextKey;
    currentVrmaModel = model;
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

async function refreshPoseEvaluationService(
  manager: ConfigManager,
  reason: 'startup' | 'secret-update' = 'startup',
): Promise<void> {
  const config = manager.getConfig();
  const nextKey = typeof config.realtimeApiKey === 'string' ? config.realtimeApiKey.trim() : '';

  if (!nextKey) {
    poseEvaluationService = null;
    return;
  }

  if (!avatarPoseService) {
    poseEvaluationService = null;
    return;
  }

  if (poseEvaluationService && currentVrmaApiKey === nextKey) {
    return;
  }

  try {
    poseEvaluationService = new PoseEvaluationService({
      client: getOpenAIClient(nextKey),
      poseService: avatarPoseService,
      logger,
    });
    if (!currentVrmaApiKey) currentVrmaApiKey = nextKey;
    logger.info('Pose evaluation service initialized.', { reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to initialize pose evaluation service', { message });
    poseEvaluationService = null;
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

/** Where wake words trained in the app are kept. */
function trainedWakeWordDirectory(): string {
  return path.join(app.getPath('userData'), 'wake-words');
}

/** services/wakeword-trainer in the repo checkout the app runs from; absent in packaged builds. */
function resolveWakeWordTrainerDirectory(): string | null {
  const candidate = process.env.WAKE_WORD_TRAINER_DIR?.trim() || path.resolve(__dirname, '../../../services/wakeword-trainer');
  return existsSync(path.join(candidate, 'train_wake_word.py')) ? candidate : null;
}

/**
 * Listen for `wakeWord` in place of the detector already running (the Settings page can pick
 * another wake word or threshold at any time).
 */
async function restartWakeWordService(wakeWord: WakeWordConfig): Promise<void> {
  if (wakeWordService) {
    const previous = wakeWordService;
    wakeWordService = null;
    // The old detector must let go of the microphone before the new one opens it.
    await previous.dispose().catch((error: unknown) => {
      logger.warn('Failed to stop the previous wake word service', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  startWakeWordService(wakeWord);
}

function startWakeWordService(wakeWord: WakeWordConfig): void {
  const service = new WakeWordService({
    logger,
    cooldownMs: wakeWord.cooldownMs,
    minConfidence: wakeWord.threshold,
  });

  service.on('wake', (event) => {
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

  service.on('peak', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('wake-word:peak', event);
    }
  });

  service.on('error', (serviceError) => {
    logger.error('Wake word service error', {
      message: serviceError.message,
      stack: serviceError.stack,
    });
  });

  service.on('ready', (info) => {
    logger.info('Wake word service ready', info);
  });

  try {
    service.start({
      modelPaths: resolveOpenWakeWordModelPaths(WAKE_WORD_ASSETS_DIRECTORY, wakeWord.model),
      keywordLabel: wakeWord.keywordLabel,
      threshold: wakeWord.threshold,
      deviceIndex: wakeWord.deviceIndex,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start wake word service', {
      message,
    });
  }
  wakeWordService = service;
  runningWakeWord = { model: wakeWord.model, threshold: wakeWord.threshold };
}

/**
 * Point the conversation pipeline and motion at the current provider settings and API key. Runs
 * at startup and after every change on the Settings page, so a change applies without a restart
 * (except the local motion model, which the launcher picks when it starts services/motion).
 */
async function applyProviderSettings(manager: ConfigManager): Promise<void> {
  const config = manager.getConfig();
  const { providers } = config;
  const engines = buildVoiceEngines(providers, config.realtimeApiKey ?? '', { logger });
  if (localVoiceService) {
    localVoiceService.configure(engines);
  } else {
    localVoiceService = new LocalVoiceService({ ...engines, tools: toolRegistry ?? undefined, logger });
  }

  if (avatarAnimationService && currentMotionServiceUrl !== providers.motion.localServiceUrl) {
    localMotionService = new LocalMotionGenerationService({
      client: new LocalMotionClient({ baseUrl: providers.motion.localServiceUrl }),
      animationService: avatarAnimationService,
      logger,
    });
    currentMotionServiceUrl = providers.motion.localServiceUrl;
  }

  pushToTalk.apply(providers.talk?.shortcut ?? '');

  if (runningWakeWord && (runningWakeWord.model !== config.wakeWord.model || runningWakeWord.threshold !== config.wakeWord.threshold)) {
    logger.info('Wake word changed in Settings; restarting the detector', {
      model: config.wakeWord.model,
      threshold: config.wakeWord.threshold,
    });
    await restartWakeWordService(config.wakeWord);
  }

  await refreshVrmaGenerationService(manager, 'secret-update');
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

    if (channel === 'config:get-secret' || channel === 'config:test-secret' || channel === 'config:clear-secret') {
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

    const instrumentedHandler: Parameters<(typeof ipcMain)['handle']>[1] = async (event, ...args) => {
      logger.debug('Configuration IPC handler invoked.', {
        channel,
        payload: sanitizePayload(channel, args),
      });

      try {
        const result: unknown = await (handler as (event: unknown, ...args: unknown[]) => Promise<unknown>)(event, ...args);
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
      await applyProviderSettings(manager);
      await refreshPoseGenerationService(manager, 'secret-update');
    }

    return nextConfig;
  });
  registerConfigHandler('config:clear-secret', async (_event, key: ConfigSecretKey) => {
    const nextConfig = await manager.clearSecret(key);
    await applyProviderSettings(manager);
    await refreshPoseGenerationService(manager, 'secret-update');
    return nextConfig;
  });
  registerConfigHandler('config:set-providers', async (_event, patch: ProviderSettingsPatch) => {
    const nextConfig = await manager.setProviderSettings(patch ?? {});
    await applyProviderSettings(manager);
    return nextConfig;
  });
  ipcMain.handle('talk:get-shortcut-status', () => pushToTalk.getStatus());
  ipcMain.handle('wake-word:list', () => listWakeWords(trainedWakeWordDirectory()));
  ipcMain.handle('wake-word:get-training-status', () =>
    wakeWordTrainer ? wakeWordTrainer.getStatus() : { available: false, reason: 'Training is not set up.', job: null },
  );
  ipcMain.handle('wake-word:train', (_event, payload: { phrase?: unknown; quick?: unknown }) => {
    if (!wakeWordTrainer) {
      throw new Error('Wake word training is not set up.');
    }
    return wakeWordTrainer.start(typeof payload?.phrase === 'string' ? payload.phrase : '', { quick: payload?.quick === true });
  });
  ipcMain.handle('wake-word:cancel-training', () =>
    wakeWordTrainer ? wakeWordTrainer.cancel() : { available: false, reason: 'Training is not set up.', job: null },
  );
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
  const requireBackgrounds = (): BackgroundService => {
    if (!backgroundService) throw new Error('Backgrounds are unavailable.');
    return backgroundService;
  };
  ipcMain.handle('background:list', () => requireBackgrounds().list());
  ipcMain.handle('background:get-active', () => requireBackgrounds().getActive());
  ipcMain.handle('background:set-active', (_event, id: string | null) => requireBackgrounds().setActive(id));
  ipcMain.handle('background:load', (_event, id: string) => requireBackgrounds().load(id));
  ipcMain.handle('background:generate', (_event, prompt: string) => requireBackgrounds().generate(prompt));
  ipcMain.handle('background:delete', (_event, id: string) => requireBackgrounds().delete(id));
  const requireAvatarGeneration = (): AvatarGenerationService => {
    if (!avatarGenerationService) {
      throw new Error('Avatar generation is unavailable.');
    }
    return avatarGenerationService;
  };
  ipcMain.handle('avatar:image-models', async () => { if (!avatarImageModels) throw new Error('Image models are unavailable.'); return avatarImageModels.list(); });
  ipcMain.handle('avatar:image-model-select', async (_event, id: string) => { if (!avatarImageModels) throw new Error('Image models are unavailable.'); await avatarImageModels.select(id); });
  ipcMain.handle(
    'avatar:generation-start',
    async (_event, payload: AvatarGenerationRequest): Promise<AvatarGenerationJob> =>
      requireAvatarGeneration().startJob(payload),
  );
  ipcMain.handle('avatar:generation-confirm-concept', async (_event, jobId: string): Promise<void> => requireAvatarGeneration().confirmConcept(jobId));
  ipcMain.handle(
    'avatar:generation-status',
    async (_event, jobId: string): Promise<AvatarGenerationStatus> => requireAvatarGeneration().getStatus(jobId),
  );
  ipcMain.handle(
    'avatar:generation-preview',
    async (_event, jobId: string): Promise<Buffer> => requireAvatarGeneration().loadPreview(jobId),
  );
  ipcMain.handle(
    'avatar:generation-accept',
    async (_event, jobId: string): Promise<AvatarGenerationAcceptance> => requireAvatarGeneration().accept(jobId),
  );
  ipcMain.handle('avatar:generation-reject', async (_event, jobId: string): Promise<void> =>
    requireAvatarGeneration().reject(jobId),
  );
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
    const useLocalMotion = manager.getConfig().providers.motion.provider === 'local';
    if (useLocalMotion && localMotionService && (await localMotionService.isReady())) {
      return localMotionService.generateAnimation(payload);
    }

    if (!vrmaGenerationService) {
      await refreshVrmaGenerationService(manager, 'secret-update');
    }
    if (!vrmaGenerationService) {
      throw new Error(
        useLocalMotion
          ? 'Animation generation is unavailable. Start the local motion service or add an OpenAI API key in Settings.'
          : 'OpenAI motion needs an OpenAI API key (Settings).',
      );
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;
    return vrmaGenerationService.generateAnimation({ ...payload, bones, modelDescription });
  });
  ipcMain.handle('avatar-motion:status', async (): Promise<AvatarMotionStatus> => {
    const { providers, realtimeApiKey } = manager.getConfig();
    if (providers.motion.provider === 'openai') {
      return {
        provider: 'openai',
        available: Boolean(realtimeApiKey),
        ready: false,
        backend: null,
        device: null,
        model: providers.motion.openaiModel,
      };
    }
    const health = localMotionService ? await localMotionService.health() : null;
    return {
      provider: 'local',
      available: Boolean(health),
      ready: health?.ready === true,
      backend: health?.backend ?? null,
      device: health?.device ?? null,
    };
  });
  ipcMain.handle('avatar-motion:stream', async (event, payload: AvatarMotionStreamRequest) => {
    if (!localMotionService || manager.getConfig().providers.motion.provider !== 'local') {
      throw new Error('Local motion service is unavailable.');
    }

    const sender = event.sender;
    return localMotionService.streamMotion(payload, (chunk) => {
      if (!sender.isDestroyed()) {
        sender.send('avatar-motion:chunk', chunk);
      }
    });
  });
  ipcMain.handle('local-voice:status', async () => {
    if (!localVoiceService) {
      throw new Error('Local voice service is unavailable.');
    }
    return localVoiceService.status();
  });
  ipcMain.handle('local-voice:transcribe', async (_event, audio: ArrayBuffer | Uint8Array) => {
    if (!localVoiceService) {
      throw new Error('Local voice service is unavailable.');
    }
    const wav = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    return localVoiceService.transcribe(wav);
  });
  ipcMain.handle('local-voice:respond', async (event, payload: LocalVoiceRespondRequest) => {
    if (!localVoiceService) {
      throw new Error('Local voice service is unavailable.');
    }
    if (!payload || typeof payload.requestId !== 'string' || typeof payload.text !== 'string') {
      throw new Error('Invalid local voice request payload received.');
    }

    const sender = event.sender;
    return localVoiceService.respond(payload, (voiceEvent) => {
      if (!sender.isDestroyed()) {
        sender.send('local-voice:event', voiceEvent);
      }
    });
  });
  ipcMain.handle('local-voice:cancel', (_event, requestId?: string) => {
    localVoiceService?.cancel(typeof requestId === 'string' ? requestId : undefined);
    return true;
  });
  ipcMain.handle('local-voice:reset', () => {
    localVoiceService?.resetHistory();
    return true;
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
  ipcMain.handle('avatar-pose:evaluate', async (_event, payload: PoseEvaluationRequest) => {
    if (!poseEvaluationService) {
      await refreshPoseEvaluationService(manager, 'secret-update');
    }
    if (!poseEvaluationService) {
      throw new Error('Pose evaluation service is unavailable. Ensure REALTIME_API_KEY is set.');
    }

    // Load pose data if only poseId is provided
    let poseData = payload.poseData;
    if (!poseData && payload.poseId && avatarPoses) {
      poseData = (await avatarPoses.loadPose(payload.poseId)) as typeof poseData;
    }
    if (!poseData) {
      throw new Error('Pose data is required for evaluation.');
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const boneHierarchy = avatarModels ? await avatarModels.listActiveModelBoneHierarchy() : {};
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;

    return poseEvaluationService.evaluatePose({
      ...payload,
      poseData,
      bones,
      boneHierarchy,
      modelDescription,
    });
  });
  ipcMain.handle('avatar-pose:refine', async (_event, payload: PoseEvaluationRequest) => {
    if (!poseEvaluationService) {
      await refreshPoseEvaluationService(manager, 'secret-update');
    }
    if (!poseEvaluationService) {
      throw new Error('Pose evaluation service is unavailable. Ensure REALTIME_API_KEY is set.');
    }

    // Load pose data if only poseId is provided
    let poseData = payload.poseData;
    if (!poseData && payload.poseId && avatarPoses) {
      poseData = (await avatarPoses.loadPose(payload.poseId)) as typeof poseData;
    }
    if (!poseData) {
      throw new Error('Pose data is required for refinement.');
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const boneHierarchy = avatarModels ? await avatarModels.listActiveModelBoneHierarchy() : {};
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;

    return poseEvaluationService.refinePose({
      ...payload,
      poseData,
      bones,
      boneHierarchy,
      modelDescription,
    });
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

  // Register MCP handlers
  if (toolRegistry && mcpManager) {
    registerMCPHandlers(mcpManager, toolRegistry);
    logger.info('MCP IPC handlers registered');
  }
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

    // Initialize MCP tool registry and manager
    toolRegistry = new ToolRegistry();
    mcpManager = new MCPManager(memoryStore.database, toolRegistry);
    await mcpManager.initialize();
    logger.info('MCP Manager initialized', {
      autoStartedServers: mcpManager.listServers().filter(s => s.autoStart && s.enabled).length
    });

    // Seed default model if this is the first run
    await avatarModelService.seedDefaultModelIfMissing(DEFAULT_MODEL_ASSET_PATH);
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
  const comfy = new ComfyUIClient({ baseUrl: appConfig.comfyUiBaseUrl });
  const comfyRuntime = new ComfyUIRuntime({ client: comfy, logDirectory: path.join(app.getPath('userData'), 'logs') });
  const ensureComfyReady = () => comfyRuntime.ensureReady();
  avatarImageModels = new AvatarImageModelService(createImageModelScanner(path.join(__dirname, '../assets/avatar-generation/image-models.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), appConfig.comfyUiBaseUrl), memoryStore ?? undefined);
  if (memoryStore) {
    backgroundService = new BackgroundService({
      store: memoryStore,
      assetsDirectory: path.join(__dirname, '../assets/backgrounds'),
      backgroundsDirectory: path.join(app.getPath('userData'), 'backgrounds'),
      comfy,
      ensureComfyReady,
    });
  }


  await refreshVrmaGenerationService(manager);
  await refreshPoseGenerationService(manager);

  const webSearch = createWebSearchProvider(
    appConfig.webSearch.provider,
    { searxngUrl: appConfig.webSearch.searxngUrl, braveApiKey: appConfig.webSearch.braveApiKey },
    logger,
  );
  if (webSearch && toolRegistry) {
    toolRegistry.register(createWebSearchTool(webSearch));
    logger.info('Web search tool registered', { provider: webSearch.name });
  }

  await applyProviderSettings(manager);

  if (avatarModelService) {
    avatarGenerationService = new AvatarGenerationService({
      comfy,
      ensureComfyReady,
      models: avatarModelService,
      baseModelPath: DEFAULT_MODEL_ASSET_PATH,
      workDirectory: path.join(app.getPath('userData'), 'avatar-generation'),
      imageModels: avatarImageModels,
      characterRunner: new BlenderCharacterRunner(path.join(__dirname, '../assets/avatar-generation/rig-character.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')),
      logger,
    });
  }

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

  startWakeWordService(appConfig.wakeWord);

  wakeWordTrainer = new WakeWordTrainer({
    trainedDirectory: trainedWakeWordDirectory(),
    scriptsDirectory: resolveWakeWordTrainerDirectory(),
    distro: process.env.WAKE_WORD_TRAINER_DISTRO,
    logger,
    onStatus: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wake-word:training-status', status);
      }
    },
  });
  void wakeWordTrainer.resume().catch((error: unknown) => {
    logger.warn('Failed to check for a wake word training run', {
      message: error instanceof Error ? error.message : String(error),
    });
  });

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
      comfyUiBaseUrl: configSnapshot.comfyUiBaseUrl,
      conversationBackend: configSnapshot.conversationBackend,
      providers: describeProviders(configSnapshot.providers),
      motionServiceUrl: configSnapshot.providers.motion.localServiceUrl,
      localLlmBaseUrl: configSnapshot.providers.llm.localBaseUrl,
      speechServiceUrl: configSnapshot.providers.speechServiceUrl,
      wakeWordModel: configSnapshot.wakeWord.model,
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

let isAppQuitting = false;

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isAppQuitting) {
    app.quit();
  }
});

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
  pushToTalk.dispose();
  // Training carries on in WSL without the app; this only stops watching it.
  wakeWordTrainer?.dispose();

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
