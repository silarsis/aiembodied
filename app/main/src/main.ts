import { BackgroundService } from './backgrounds/background-service.js';
import { app, BrowserWindow, Tray, dialog, globalShortcut, ipcMain } from 'electron';
import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';
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
import { WakeWordListeningController } from './wake-word/listening-controller.js';
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
import { AvatarImageModelService, createImageModelScanner, createRemoteComfyModelScanner, type PoseControlInstaller } from './avatar/generation/image-model-service.js';
import { POSE_CONTROLNETS, poseControlNetPlan } from './avatar/generation/pose-control.js';
import { baseModelForFamily, type BaseModelSuggestions, lookupCivitai, parseCivitaiRef, planCivitaiDownload, suggestBaseModels } from './avatar/generation/civitai.js';
import { resolveComfyInstallation } from './avatar/generation/comfyui-runtime.js';
import { ModelDownloadService } from './avatar/generation/model-downloads.js';
import { AvatarCharacterModelService } from './avatar/generation/character-model-service.js';
import { LocalMotionClient } from './avatar/motion/local-motion-client.js';
import { LocalMotionGenerationService } from './avatar/motion/local-motion-generation-service.js';
import { LocalVoiceService } from './local-voice/local-voice-service.js';
import {
  activeAgent,
  createMemoryTools,
  memoryEngineSettings,
  registerMemoryEngineIpc,
  setupMemoryEngine,
  MemoryStorageSync,
  memoryStorageTargets,
  type MemoryEngineRuntime,
} from './memory-engine/index.js';
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
  AvatarGenerationConfirmation,
  AvatarGenerationAcceptance,
} from './avatar/types.js';
import {
  resolvePreloadScriptPath,
  resolveRendererEntryPoint,
  RuntimeResourceNotFoundError,
} from './runtime-paths.js';
import { getOpenAIClient } from './openai/client.js';
import type OpenAI from 'openai';
import { createChatCompletionsResponsesClient } from './openai/chat-completions-responses.js';
import { BUILT_IN_SERVER_IDS, databaseUrlWithPassword, routeTargets, serverUrl, USE_SERVER_TYPES, type ModelRoute, type ServerType, type UseId } from './config/model-routing.js';
import { probeMemoryDatabase, probeModelServer } from './config/model-server-probe.js';
import { ComfyUIPool } from './avatar/generation/comfyui-pool.js';
import { LocalLlmControl } from './local-voice/local-llm-control.js';
import { lookupHuggingFace, parseHuggingFaceRef } from './local-llm/huggingface.js';
import { LlmLibrary } from './local-llm/llm-library.js';
import { MCPManager } from './mcp/mcp-manager.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { createRoutedSearchProvider, createWebSearchTool, WEB_SEARCH_TOOL_ID } from './tools/web-search.js';
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
const wakeWordListening = new WakeWordListeningController(startWakeWordService);
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
  logger: { info: (message: string, meta?: unknown) => logger.info(message, meta), warn: (message: string, meta?: unknown) => logger.warn(message, meta) },
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
let avatarComfyPool: ComfyUIPool | undefined;
/** The ComfyUI add-on folder: its downloader runs for this PC, and other machines install the folder. */
const comfyAddonDirectory = path.join(__dirname, '../assets/avatar-generation/comfyui-aiembodied').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const modelDownloads = new ModelDownloadService({
  script: path.join(comfyAddonDirectory, 'aiembodied_downloader.py'),
  resolveInstallation: () => resolveComfyInstallation(),
  // A new SD1.5 or SDXL checkpoint on the image server brings its pose ControlNet with it.
  onFinished: (download, plan, server) => {
    if (download.state !== 'done' || (plan.kind !== 'sd1' && plan.kind !== 'sdxl')) return;
    if (avatarComfyPool?.primary('image')?.id !== server.id) return;
    void avatarImageModels?.ensurePoseControl(plan.kind).catch((error: unknown) => {
      logger.warn('Could not set up pose control for the new model.', { message: error instanceof Error ? error.message : String(error) });
    });
  },
  logger,
});
/** Downloads the pose ControlNets to the image step's first ComfyUI server. */
const poseControlInstaller: PoseControlInstaller = {
  status: (family) => {
    const server = avatarComfyPool?.primary('image');
    const download = server ? modelDownloads.find(server.id, POSE_CONTROLNETS[family].filename) : undefined;
    if (!download) return null;
    if (download.state === 'done') return { state: 'done' };
    if (download.state === 'failed' || download.state === 'cancelled') return { state: 'failed', error: download.error };
    return { state: 'downloading' };
  },
  install: async (family) => {
    const server = avatarComfyPool?.primary('image');
    if (!server || server.type !== 'comfy') return false;
    if (!server.managed && !(await modelDownloads.hasAddon(server))) return false;
    logger.info('Downloading pose control for avatar images.', { server: server.id, family });
    modelDownloads.start(server, poseControlNetPlan(family), undefined);
    return true;
  },
};
let avatarCharacterModels: AvatarCharacterModelService | undefined;
let avatarGenerationService: AvatarGenerationService | null = null;
let localMotionService: LocalMotionGenerationService | null = null;
let localVoiceService: LocalVoiceService | null = null;
let memoryEngine: MemoryEngineRuntime | null = null;
let memoryStorageSync: MemoryStorageSync | null = null;
let configManagerForMemory: ConfigManager | null = null;

/** Point the memory engine at the database and mirror picked in Models and servers. */
function syncMemoryStorage(manager: ConfigManager | null = configManagerForMemory): void {
  if (!manager || !memoryEngine) return;
  configManagerForMemory = manager;
  memoryStorageSync ??= new MemoryStorageSync({ client: memoryEngine.client, logger });
  void memoryStorageSync.apply(memoryStorageTargets(manager.getConfig().models, (id) => manager.getServerKey(id)));
}
let currentMotionServiceUrl: string | null = null;

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
    void wakeWordListening.setEnabled(false).catch((error: unknown) => logger.error('Failed to stop listening after window close', { message: String(error) }));
    mainWindow = null;
  });

  const stopWindowListening = () => {
    void wakeWordListening.setEnabled(false).catch((error: unknown) => logger.error('Failed to stop listening after renderer reset', { message: String(error) }));
  };
  window.webContents.on('did-start-loading', stopWindowListening);
  window.webContents.on('render-process-gone', stopWindowListening);

  mainWindow = window;
  return window;
};

const crashGuard = new CrashGuard({
  createWindow,
  logger,
});

/**
 * The OpenAI-compatible client and model for a helper job (animation clips, poses, pose checks,
 * avatar description), from the server Models and servers picks for it. Null when that server
 * is OpenAI and no key is set, or nothing is picked.
 */
function helperTarget(manager: ConfigManager, use: 'clips' | 'posegen' | 'posecheck' | 'describe'): { client: OpenAI; model?: string; signature: string } | null {
  const target = routeTargets(manager.getConfig().models, use)[0];
  if (!target) return null;
  const key = manager.getServerKey(target.server.id)?.trim() ?? '';
  if (target.server.type === 'openai' && !key) return null;
  const signature = `${target.server.url}|${key}|${target.model ?? ''}`;
  // OpenAI gets the SDK; any other chat server gets the same calls over /chat/completions.
  const client =
    target.server.type === 'openai'
      ? getOpenAIClient(key)
      : (createChatCompletionsResponsesClient({ baseUrl: target.server.url, apiKey: key || undefined, model: target.model }) as unknown as OpenAI);
  return { client, model: target.model, signature };
}

const helperSignatures = new Map<string, string>();

/** Rebuild a helper service when its server, key or model changed; null when it has none. */
function refreshHelper<T>(
  manager: ConfigManager,
  use: 'clips' | 'posegen' | 'posecheck' | 'describe',
  current: T | null,
  create: (client: OpenAI, model: string | undefined) => T,
  label: string,
): T | null {
  const target = helperTarget(manager, use);
  if (!target) {
    if (current) logger.warn(`${label} disabled: choose a server for it in Models and servers, or add the OpenAI API key.`);
    helperSignatures.delete(use);
    return null;
  }
  if (current && helperSignatures.get(use) === target.signature) return current;
  try {
    const service = create(target.client, target.model);
    helperSignatures.set(use, target.signature);
    logger.info(`${label} ready.`, { model: target.model });
    return service;
  } catch (error) {
    logger.warn(`Failed to initialize ${label.toLowerCase()}`, { message: error instanceof Error ? error.message : String(error) });
    helperSignatures.delete(use);
    return null;
  }
}

async function refreshVrmaGenerationService(manager: ConfigManager): Promise<void> {
  const animationService = avatarAnimationService;
  if (!animationService) {
    vrmaGenerationService = null;
    return;
  }
  vrmaGenerationService = refreshHelper(
    manager,
    'clips',
    vrmaGenerationService,
    (client, model) => new VrmaGenerationService({ client, animationService, model, logger }),
    'Animation clip generation',
  );
}

async function refreshPoseGenerationService(manager: ConfigManager): Promise<void> {
  const poseService = avatarPoseService;
  if (!poseService) {
    poseGenerationService = null;
    return;
  }
  poseGenerationService = refreshHelper(
    manager,
    'posegen',
    poseGenerationService,
    (client, model) => new PoseGenerationService({ client, poseService, model, logger }),
    'Pose generation',
  );
}

async function refreshPoseEvaluationService(manager: ConfigManager): Promise<void> {
  const poseService = avatarPoseService;
  if (!poseService) {
    poseEvaluationService = null;
    return;
  }
  poseEvaluationService = refreshHelper(
    manager,
    'posecheck',
    poseEvaluationService,
    (client, model) => new PoseEvaluationService({ client, poseService, model, logger }),
    'Pose checking',
  );
}

async function refreshAvatarDescriptionService(manager: ConfigManager): Promise<void> {
  avatarDescriptionService = refreshHelper(
    manager,
    'describe',
    avatarDescriptionService,
    (client, model) => new AvatarDescriptionService({ client, model, logger }),
    'Avatar description',
  );
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
 * Create capture only after explicit enable; the listening controller serializes replacements.
 */
function startWakeWordService(wakeWord: WakeWordConfig): WakeWordService {
  const service = new WakeWordService({
    logger,
    cooldownMs: wakeWord.cooldownMs,
    minConfidence: wakeWord.threshold,
  });

  service.on('wake', (event) => {
    if (!wakeWordListening.enabled) return;
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
    if (!wakeWordListening.enabled) return;
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
    throw error;
  }
  return service;
}

/**
 * Point the conversation pipeline and motion at the current provider settings and API key. Runs
 * at startup and after every change on the Settings page, so a change applies without a restart
 * (except the local motion model, which the launcher picks when it starts services/motion).
 */
async function applyProviderSettings(manager: ConfigManager): Promise<void> {
  const config = manager.getConfig();
  const { providers, models } = config;
  const engines = buildVoiceEngines(models, (id) => manager.getServerKey(id), { logger });
  if (localVoiceService) {
    localVoiceService.configure(engines);
  } else {
    localVoiceService = new LocalVoiceService({
      ...engines,
      tools: toolRegistry ?? undefined,
      logger,
      onToolResult: (record) => memoryEngine?.recordToolCall(record),
      // Through memoryEngine at call time: it is set up after this service.
      memory: {
        brief: () => memoryEngine?.voice.brief() ?? Promise.resolve(null),
        recall: (text, recalled) => memoryEngine?.voice.recall(text, recalled) ?? Promise.resolve(null),
        activity: (busy) => memoryEngine?.voice.activity?.(busy),
      },
    });
  }

  const motionServer = localMotionServer(manager);
  const motionUrl = motionServer?.url ?? providers.motion.localServiceUrl;
  if (avatarAnimationService && currentMotionServiceUrl !== motionUrl) {
    localMotionService = new LocalMotionGenerationService({
      client: new LocalMotionClient({ baseUrl: motionUrl }),
      animationService: avatarAnimationService,
      logger,
    });
    currentMotionServiceUrl = motionUrl;
  }

  applyWebSearch(manager);
  configManagerForMemory = manager;
  syncMemoryStorage(manager);

  pushToTalk.apply(providers.talk?.shortcut ?? '');

  await wakeWordListening.configure(config.wakeWord);

  await refreshVrmaGenerationService(manager);
  await refreshPoseGenerationService(manager);
  await refreshPoseEvaluationService(manager);
  await refreshAvatarDescriptionService(manager);
}

/**
 * Thinking models downloaded from Hugging Face, and this PC's llama-server that runs the picked one.
 * Built on first use: both need the config manager and the userData folder.
 */
let localLlmTools: { library: LlmLibrary; control: LocalLlmControl } | null = null;
function getLocalLlmTools(manager: ConfigManager): { library: LlmLibrary; control: LocalLlmControl } {
  if (localLlmTools) return localLlmTools;
  // pnpm dev:run moves the profile folders; downloads go to the real one so they outlive .dev-home.
  const home = process.env.AIEMBODIED_HOST_USERPROFILE?.trim() || os.homedir();
  const library = new LlmLibrary({
    file: path.join(app.getPath('userData'), 'local-llm.json'),
    modelsDirectory: process.env.LOCAL_LLM_MODELS_DIR?.trim() || path.join(home, '.cache', 'aiembodied', 'llm-models'),
    onDownloaded: (model) => useLocalLlm(manager, model.id),
    logger,
  });
  const control = new LocalLlmControl({
    baseUrl: () => {
      const server = routeTargets(manager.getConfig().models, 'llm')[0]?.server;
      return server?.id === BUILT_IN_SERVER_IDS.llm ? serverUrl(server.type, server.url) : null;
    },
    repoRoot: path.resolve(__dirname, '../../..'),
    logDirectory: path.join(app.getPath('userData'), 'logs'),
    model: () => library.selected(),
  });
  localLlmTools = { library, control };
  return localLlmTools;
}

/**
 * Run a downloaded model (or, with null, the start script's default) for Thinking: point Thinking
 * at this PC's llama-server and restart it with that model. Returns what happened, in words.
 */
async function useLocalLlm(manager: ConfigManager, id: string | null): Promise<string> {
  const { library, control } = getLocalLlmTools(manager);
  const model = await library.select(id);
  const current = manager.getConfig().models.routes.llm;
  await manager.setModelRoute('llm', {
    ...current,
    server: BUILT_IN_SERVER_IDS.llm,
    model: model?.alias,
    backups: (current.backups ?? []).filter((backup) => backup.server !== BUILT_IN_SERVER_IDS.llm),
  });
  await applyProviderSettings(manager);
  const result = await control.restart();
  logger.info('Thinking model changed.', { model: model?.id ?? 'default', restarted: result.restarted });
  return result.message;
}

/** The motion service Moving uses, or null when Moving runs on OpenAI keyframes. */
function localMotionServer(manager: ConfigManager) {
  const target = routeTargets(manager.getConfig().models, 'motion')[0];
  return target?.server.type === 'motion' ? target.server : null;
}

let webSearchSignature: string | null = null;

/** Register (or swap, or remove) the web_search tool for the servers Web search uses. */
function applyWebSearch(manager: ConfigManager): void {
  if (!toolRegistry) return;
  const targets = routeTargets(manager.getConfig().models, 'search').map(({ server }) => ({
    type: server.type as 'search' | 'brave',
    url: server.url,
    key: manager.getServerKey(server.id),
  }));
  const signature = JSON.stringify(targets);
  if (signature === webSearchSignature) return;
  webSearchSignature = signature;
  const provider = createRoutedSearchProvider(targets, logger);
  if (provider) {
    toolRegistry.register(createWebSearchTool(provider));
    logger.info('Web search tool registered', { provider: provider.name });
  } else {
    toolRegistry.unregister(WEB_SEARCH_TOOL_ID);
    logger.info('Web search is off.');
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
      await refreshPoseGenerationService(manager);
    }

    return nextConfig;
  });
  registerConfigHandler('config:clear-secret', async (_event, key: ConfigSecretKey) => {
    const nextConfig = await manager.clearSecret(key);
    await applyProviderSettings(manager);
    await refreshPoseGenerationService(manager);
    return nextConfig;
  });
  registerConfigHandler('config:set-providers', async (_event, patch: ProviderSettingsPatch) => {
    const nextConfig = await manager.setProviderSettings(patch ?? {});
    await applyProviderSettings(manager);
    return nextConfig;
  });
  // Models and servers pop-up. Keys go in, never out: the view only says whether one is set.
  ipcMain.handle('models:get', () => manager.getModelRoutingView());
  ipcMain.handle('models:probe', async (_event, payload: { serverId?: unknown; draft?: { type?: unknown; url?: unknown; key?: unknown } }) => {
    if (typeof payload?.serverId === 'string') {
      const server = manager.getConfig().models.servers.find((entry) => entry.id === payload.serverId);
      if (!server) throw new Error('That server no longer exists.');
      if (server.type === 'memory') {
        return probeMemoryDatabase(
          { url: databaseUrlWithPassword(server.url, manager.getServerKey(server.id)), local: server.id === BUILT_IN_SERVER_IDS.memory },
          memoryEngine?.client ?? null,
        );
      }
      return probeModelServer(server, manager.getServerKey(server.id));
    }
    const draft = payload?.draft;
    if (!draft || typeof draft.type !== 'string' || typeof draft.url !== 'string') {
      throw new Error('Choose a server type and address first.');
    }
    let url: string;
    try {
      url = new URL(draft.url.trim()).toString().replace(/\/+$/, '');
    } catch {
      throw new Error('Enter the server address as a URL, such as http://192.168.1.20:8188.');
    }
    const type = draft.type as ServerType;
    if (type === 'memory') {
      const password = typeof draft.key === 'string' && draft.key.trim() ? draft.key.trim() : undefined;
      return probeMemoryDatabase({ url: databaseUrlWithPassword(url, password), local: false }, memoryEngine?.client ?? null);
    }
    return probeModelServer({ type, url: serverUrl(type, url) }, typeof draft.key === 'string' ? draft.key : undefined);
  });
  ipcMain.handle(
    'models:save-server',
    async (_event, payload: { id?: unknown; name?: unknown; type?: unknown; url?: unknown; key?: unknown }) => {
      const id = await manager.saveModelServer({
        id: typeof payload?.id === 'string' ? payload.id : undefined,
        name: typeof payload?.name === 'string' ? payload.name : undefined,
        type: typeof payload?.type === 'string' ? (payload.type as ServerType) : undefined,
        url: typeof payload?.url === 'string' ? payload.url : undefined,
      });
      if (typeof payload?.key === 'string' && payload.key.trim()) await manager.setServerKey(id, payload.key);
      await applyProviderSettings(manager);
      return { id, models: manager.getModelRoutingView() };
    },
  );
  ipcMain.handle('models:remove-server', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a server to remove.');
    await manager.removeModelServer(id);
    await applyProviderSettings(manager);
    return manager.getModelRoutingView();
  });
  ipcMain.handle('models:set-route', async (_event, payload: { use?: unknown; route?: unknown }) => {
    const use = payload?.use as UseId;
    if (typeof use !== 'string' || !(use in USE_SERVER_TYPES)) throw new Error('Unknown model use.');
    await manager.setModelRoute(use, (payload?.route ?? {}) as ModelRoute);
    await applyProviderSettings(manager);
    return manager.getModelRoutingView();
  });
  const comfyServer = (serverId: unknown) => {
    const server = manager.getConfig().models.servers.find((entry) => entry.id === serverId);
    if (!server || server.type !== 'comfy') throw new Error('Choose a ComfyUI server.');
    return server;
  };
  ipcMain.handle('models:civitai-lookup', async (_event, payload: { ref?: unknown; versionId?: unknown }) => {
    const ref = parseCivitaiRef(typeof payload?.ref === 'string' ? payload.ref : '');
    if (!ref) throw new Error('Paste a Civitai link (civitai.com, .green or .red: a model page or download link) or an AIR (urn:air:…:civitai:123@456).');
    const model = await lookupCivitai(ref, manager.getServerKey(BUILT_IN_SERVER_IDS.civitai));
    const versionId = typeof payload?.versionId === 'number' ? payload.versionId : undefined;
    return {
      versions: model.versions.map((version) => ({ id: version.id, name: version.name, baseModel: version.baseModel })),
      plan: planCivitaiDownload(model, versionId, ref.fileId),
    };
  });
  ipcMain.handle('models:download', async (_event, payload: { serverId?: unknown; ref?: unknown; versionId?: unknown }) => {
    const server = comfyServer(payload?.serverId);
    const ref = parseCivitaiRef(typeof payload?.ref === 'string' ? payload.ref : '');
    if (!ref) throw new Error('Paste a Civitai model link or AIR.');
    const key = manager.getServerKey(BUILT_IN_SERVER_IDS.civitai);
    const model = await lookupCivitai(ref, key);
    const plan = planCivitaiDownload(model, typeof payload?.versionId === 'number' ? payload.versionId : undefined, ref.fileId);
    if (!server.managed && !(await modelDownloads.hasAddon(server))) {
      throw new Error(`${server.name} needs the aiembodied ComfyUI add-on before it can download models. See "Add-on" on this page.`);
    }
    return modelDownloads.start(server, plan, key);
  });
  ipcMain.handle('models:downloads', () => modelDownloads.list());
  ipcMain.handle('models:cancel-download', (_event, id: unknown) => {
    if (typeof id === 'string') modelDownloads.cancel(id);
    return modelDownloads.list();
  });
  ipcMain.handle('models:comfy-addon', async (_event, serverId: unknown) => {
    const server = comfyServer(serverId);
    return { installed: await modelDownloads.hasAddon(server), folder: comfyAddonDirectory };
  });
  // Thinking models from Hugging Face, for this PC's llama-server.
  const hfToken = () => manager.getServerKey(BUILT_IN_SERVER_IDS.huggingface);
  const localLlmList = async () => {
    const { library } = getLocalLlmTools(manager);
    return { ...(await library.read()), folder: library.modelsDirectory };
  };
  ipcMain.handle('models:hf-lookup', async (_event, ref: unknown) => {
    const parsed = parseHuggingFaceRef(typeof ref === 'string' ? ref : '');
    if (!parsed) throw new Error('Paste a Hugging Face link or repo name (such as unsloth/Qwen3-8B-GGUF), or type words to search for.');
    return lookupHuggingFace(parsed, hfToken());
  });
  ipcMain.handle('models:hf-download', async (_event, payload: { repo?: unknown; quant?: unknown; use?: unknown }) => {
    if (typeof payload?.repo !== 'string' || typeof payload.quant !== 'string') throw new Error('Pick a model and size first.');
    // Read the repo again here rather than trusting file names from the page.
    const lookup = await lookupHuggingFace({ repo: payload.repo }, hfToken());
    const quant = lookup.quants.find((entry) => entry.id === payload.quant);
    if (!lookup.repo || !quant) throw new Error('That size is no longer in the repo. Look it up again.');
    return getLocalLlmTools(manager).library.start(lookup.repo, quant, {
      token: hfToken(),
      use: payload.use !== false,
      ...(lookup.contextLength ? { contextLength: lookup.contextLength } : {}),
    });
  });
  ipcMain.handle('models:hf-downloads', () => getLocalLlmTools(manager).library.list());
  ipcMain.handle('models:hf-cancel', (_event, id: unknown) => {
    const { library } = getLocalLlmTools(manager);
    if (typeof id === 'string') library.cancel(id);
    return library.list();
  });
  ipcMain.handle('models:local-llms', () => localLlmList());
  ipcMain.handle('models:use-local-llm', async (_event, id: unknown) => {
    const message = await useLocalLlm(manager, typeof id === 'string' && id ? id : null);
    return { message, library: await localLlmList(), models: manager.getModelRoutingView() };
  });
  ipcMain.handle('models:delete-local-llm', async (_event, id: unknown) => {
    if (typeof id === 'string') await getLocalLlmTools(manager).library.remove(id);
    return localLlmList();
  });
  ipcMain.handle('models:set-key', async (_event, payload: { serverId?: unknown; key?: unknown }) => {
    if (typeof payload?.serverId !== 'string') throw new Error('Choose a server.');
    await manager.setServerKey(payload.serverId, typeof payload.key === 'string' ? payload.key : '');
    await applyProviderSettings(manager);
    return manager.getModelRoutingView();
  });
  ipcMain.handle('talk:get-shortcut-status', () => pushToTalk.getStatus());
  ipcMain.handle('wake-word:list', () => listWakeWords(trainedWakeWordDirectory()));
  ipcMain.handle('wake-word:set-listening', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Listening must be enabled or disabled.');
    return wakeWordListening.setEnabled(enabled);
  });
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
  ipcMain.handle('avatar:image-loras-select', async (_event, choices: unknown) => {
    if (!avatarImageModels) throw new Error('Image models are unavailable.');
    avatarImageModels.selectLoras(Array.isArray(choices) ? choices : []);
  });
  // Popular Civitai checkpoints for a LoRA's base model, sized against the image server's GPU.
  ipcMain.handle('avatar:base-model-suggestions', async (_event, payload: { baseModel?: unknown; family?: unknown }) => {
    const server = avatarComfyPool?.primary('image');
    if (!server) throw new Error('No ComfyUI server is set for the image step.');
    const baseModel =
      typeof payload?.baseModel === 'string' && payload.baseModel.trim()
        ? payload.baseModel.trim()
        : typeof payload?.family === 'string'
          ? baseModelForFamily(payload.family)
          : undefined;
    if (!baseModel) throw new Error("That LoRA's base model isn't known, so there is nothing to suggest.");
    const vramBytes = await fetch(`${server.url}/system_stats`, { signal: AbortSignal.timeout(5000) })
      .then(async (response) => (response.ok ? ((await response.json()) as { devices?: Array<{ vram_total?: unknown }> }) : null))
      .then((stats) => {
        const total = stats?.devices?.[0]?.vram_total;
        return typeof total === 'number' && total > 0 ? total : null;
      })
      .catch(() => null);
    const suggestions = await suggestBaseModels(baseModel, vramBytes, manager.getServerKey(BUILT_IN_SERVER_IDS.civitai));
    const result: BaseModelSuggestions = { serverId: server.id, serverName: server.name, baseModel, vramBytes, suggestions };
    return result;
  });
  ipcMain.handle('avatar:character-models', async () => { if (!avatarCharacterModels) throw new Error('3D avatar models are unavailable.'); return avatarCharacterModels.list(); });
  ipcMain.handle('avatar:character-model-select', async (_event, stage: 'geometry' | 'rig', id: string) => { if (!avatarCharacterModels) throw new Error('3D avatar models are unavailable.'); await avatarCharacterModels.select(stage, id); });
  ipcMain.handle('avatar:generation-list', async (): Promise<AvatarGenerationStatus[]> => requireAvatarGeneration().listJobs());
  ipcMain.handle('avatar:generation-cancel', async (_event, jobId: string): Promise<void> => requireAvatarGeneration().cancel(jobId));
  ipcMain.handle(
    'avatar:generation-start',
    async (_event, payload: AvatarGenerationRequest): Promise<AvatarGenerationJob> =>
      requireAvatarGeneration().startJob(payload),
  );
  ipcMain.handle('avatar:generation-remove-background', async (_event, jobId: string) => requireAvatarGeneration().removeConceptBackground(jobId));
  ipcMain.handle('avatar:generation-restore-background', async (_event, jobId: string) => requireAvatarGeneration().restoreConceptBackground(jobId));
  ipcMain.handle('avatar:generation-redraw-views', async (_event, jobId: string) => requireAvatarGeneration().redrawViews(jobId));
  ipcMain.handle('avatar:generation-confirm-concept', async (_event, jobId: string, confirmation?: AvatarGenerationConfirmation): Promise<void> => requireAvatarGeneration().confirmConcept(jobId, confirmation));
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
        await refreshAvatarDescriptionService(manager);
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
    const useLocalMotion = localMotionServer(manager) !== null;
    if (useLocalMotion && localMotionService && (await localMotionService.isReady())) {
      return localMotionService.generateAnimation(payload);
    }

    if (!vrmaGenerationService) {
      await refreshVrmaGenerationService(manager);
    }
    if (!vrmaGenerationService) {
      throw new Error(
        useLocalMotion
          ? 'Animation generation is unavailable. Start the motion service, or set up Animation clips in Models and servers.'
          : 'Animation clips need a server: choose one in Models and servers (OpenAI needs its API key).',
      );
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;
    return vrmaGenerationService.generateAnimation({ ...payload, bones, modelDescription });
  });
  ipcMain.handle('avatar-motion:status', async (): Promise<AvatarMotionStatus> => {
    if (!localMotionServer(manager)) {
      const clips = routeTargets(manager.getConfig().models, 'clips')[0];
      return {
        provider: 'openai',
        available: Boolean(clips && (clips.server.type !== 'openai' || manager.getServerKey(clips.server.id))),
        ready: false,
        backend: null,
        device: null,
        model: clips?.model ?? null,
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
    if (!localMotionService || !localMotionServer(manager)) {
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
      await refreshPoseGenerationService(manager);
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
      await refreshPoseEvaluationService(manager);
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
      await refreshPoseEvaluationService(manager);
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
    memoryEngine = setupMemoryEngine({
      settings: memoryEngineSettings(),
      store: memoryStore,
      conversations: conversationManager,
      logger,
    });
    // Provider settings may have been applied before the engine existed.
    syncMemoryStorage();

    // Initialize MCP tool registry and manager
    toolRegistry = new ToolRegistry();
    if (memoryEngine) {
      const store = memoryStore;
      const conversations = conversationManager;
      for (const tool of createMemoryTools({
        client: memoryEngine.client,
        outbox: memoryEngine.outbox,
        currentSessionId: () => conversations.getCurrentSessionId(),
        agentName: () => activeAgent(store).name,
      })) {
        toolRegistry.register(tool);
      }
      logger.info('Memory tools registered');
    }
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
  const comfyPool = new ComfyUIPool({
    routing: () => manager.getConfig().models,
    logDirectory: path.join(app.getPath('userData'), 'logs'),
    logger,
  });
  avatarComfyPool = comfyPool;
  const imageModelScript = path.join(__dirname, '../assets/avatar-generation/image-models.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  // Model lists come from the first ComfyUI server of each step: this PC's files are read
  // directly, another machine's are listed over its HTTP API.
  const scanComfyModels = (stage: 'image' | 'mesh') => async () => {
    const server = comfyPool.primary(stage);
    if (!server) throw new Error('No ComfyUI server is set for this step. Choose one in Models and servers.');
    return server.managed
      ? createImageModelScanner(imageModelScript, server.url)()
      : createRemoteComfyModelScanner(server.url)();
  };
  avatarImageModels = new AvatarImageModelService(scanComfyModels('image'), memoryStore ?? undefined, poseControlInstaller);
  const characterRunner = new BlenderCharacterRunner(path.join(__dirname, '../assets/avatar-generation/rig-character.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'));
  avatarCharacterModels = new AvatarCharacterModelService(scanComfyModels('mesh'), () => characterRunner.assertAvailable(), memoryStore ?? undefined);
  // Backgrounds draw on the image step's server; the pick and the run share one server.
  let backgroundComfy: ComfyUIClient | null = null;
  const fallbackComfy = new ComfyUIClient({ baseUrl: appConfig.comfyUiBaseUrl });
  if (memoryStore) {
    backgroundService = new BackgroundService({
      store: memoryStore,
      assetsDirectory: path.join(__dirname, '../assets/backgrounds'),
      backgroundsDirectory: path.join(app.getPath('userData'), 'backgrounds'),
      comfy: {
        isAvailable: () => (backgroundComfy ?? fallbackComfy).isAvailable(),
        run: (graph, options) => (backgroundComfy ?? fallbackComfy).run(graph, options),
      },
      ensureComfyReady: async () => {
        backgroundComfy = await comfyPool.pick('image');
      },
    });
  }

  await applyProviderSettings(manager);

  if (avatarModelService) {
    avatarGenerationService = new AvatarGenerationService({
      comfy: fallbackComfy,
      pickComfy: (stage) => comfyPool.pick(stage),
      models: avatarModelService,
      baseModelPath: DEFAULT_MODEL_ASSET_PATH,
      workDirectory: path.join(app.getPath('userData'), 'avatar-generation'),
      imageModels: avatarImageModels,
      characterModels: avatarCharacterModels,
      characterRunner,
      // Started again afterwards with the thinking model picked in Models and servers.
      localLlm: getLocalLlmTools(manager).control,
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

  await wakeWordListening.configure(appConfig.wakeWord);

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
    if (memoryStore) {
      const store = memoryStore;
      registerMemoryEngineIpc({
        ipcMain,
        runtime: () => memoryEngine,
        store,
        logger,
        currentSessionId: () => conversationManager?.getCurrentSessionId() ?? null,
        leaveCurrentSession: () => {
          localVoiceService?.cancel();
          localVoiceService?.resetHistory();
          conversationManager?.startSession({ startedAt: Date.now() });
        },
      });
    }
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

  cleanupTasks.push(
    wakeWordListening.dispose().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to dispose wake word service during shutdown', { message });
    }),
  );

  if (metricsCollector) {
    cleanupTasks.push(
      metricsCollector.stop().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to stop metrics exporter cleanly', { message });
      }),
    );
  }

  // Synchronous cleanup. Queued memory writes stay in SQLite and go out on the next start.
  memoryStorageSync?.stop();
  memoryStorageSync = null;
  memoryEngine?.stop();
  memoryEngine = null;
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
