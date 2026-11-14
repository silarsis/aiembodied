import { BackgroundService } from './backgrounds/background-service.js';
import { RoomService } from './rooms/room-service.js';
import { pickIdleActions } from './rooms/idle-thoughts.js';
import { MAX_IDLE_HABITS_LENGTH, normalizeIdleHabits } from './rooms/idle-habits.js';
import { Menu, Notification, app, BrowserWindow, Tray, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, protocol, session } from 'electron';
import type { WebContents } from 'electron';
import { ASSET_SCHEME, ASSET_SCHEME_PRIVILEGES, registerAssetProtocol } from './rooms/asset-protocol.js';
import { ASSET_FOLDER, createRoomGenerationService, objectMakingAvailable, pickSingleImageGeometry } from './rooms/room-generation-setup.js';
import type { RoomGenerationService } from './rooms/room-generation.js';
import { SwitchboardClient, makeEventId } from './switchboard/client.js';
import { LocalOnlyBus, type SwitchboardBus } from './switchboard/bus.js';
import { AvatarInbox } from './switchboard/inbox.js';
import { DecisionLog } from './switchboard/decisions.js';
import { deliberate } from './switchboard/deliberate.js';
import { deliberateFast } from './switchboard/deliberate-system-one.js';
import { ProactiveTick, proactiveSettingsFromEnv } from './presence/proactive-tick.js';
import { PresenceTracker, isVoicePhase } from './presence/presence.js';
import { FloorController } from './floor/index.js';
import { HOME_PLACE_ID, PlaceManager, placesNote, scopedPlaces } from './places/place-manager.js';
import { PlacePresence } from './presence/place-presence.js';
import { createPlaceDelivery, type EventSink } from './places/place-delivery.js';
import { createAppWindow } from './window/app-window.js';
import { Satellite } from './satellite/satellite.js';
import { DeviceRuntime } from './satellite/device-runtime.js';
import { FullscreenWatcher } from './satellite/fullscreen-watch.js';
import { stateIcon, toBgra } from './satellite/tray-state.js';
import { KeychainTokenStore } from './satellite/token-store.js';
import { SATELLITE_FILE, SatelliteSettingsStore, detectSatelliteRole, userDataOverride } from './satellite/settings.js';
import { RoomHub } from './room-hub/room-hub.js';
import { RoomDeviceRegistry } from './room-hub/room-devices.js';
import { createTailscaleLookup } from './room-hub/tailscale.js';
import { rememberIpcHandler } from './room-hub/ipc-registry.js';
import { callToPlace, chooseSummon, summon } from './places/summon.js';
import { PlaceDevices } from './room-hub/place-devices.js';
import { createIntentRouter } from './floor/intent-router.js';
import { createModelBid } from './floor/bid.js';
import { createSystemOne } from './decide/system-one.js';
import { createSystemOneAddressee, createSystemOneBid, createSystemOneIntent } from './floor/system-one-floor.js';
import { avatarIdForName } from './avatars/avatar-id.js';
import { SwitchboardMirror } from './switchboard/mirror.js';
import { AvatarRegistry, DEFAULT_AVATAR_ID, type AvatarProfile } from './avatars/avatar-registry.js';
import { AvatarSettingsKeys, avatarOnlyKeys } from './avatars/avatar-settings.js';
import { composeAvatarPrompt, readTagInstructions } from './avatars/tag-instructions.js';
import type { AvatarTagInstructions } from './avatars/bridge-types.js';
import { VoiceServices } from './avatars/voice-services.js';
import { tagEvent, tagResult } from './avatars/speaker.js';
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
import { ServerManager } from './server/server-manager.js';
import { LocalVoiceService } from './local-voice/local-voice-service.js';
import {
  activeAgent,
  type CaptureAgent,
  createMemoryTools,
  memoryEngineSettings,
  registerMemoryEngineIpc,
  setupMemoryEngine,
  MemoryStorageSync,
  HomeServerSync,
  homeServersFor,
  memoryStorageTargets,
  type MemoryEngineRuntime,
} from './memory-engine/index.js';
import { buildVoiceEngines, DEFAULT_OPENAI_MODELS } from './local-voice/voice-engines.js';
import { describeProviders, type ProviderSettingsPatch } from './config/provider-settings.js';
import type { LocalVoiceEvent, LocalVoiceRespondRequest, LocalVoiceRespondResult, SpeakingVoiceOptions } from './local-voice/types.js';
import { SpeechServiceClient } from './local-voice/speech-service-client.js';
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
import { getOpenAIClient } from './openai/client.js';
import type OpenAI from 'openai';
import { createChatCompletionsResponsesClient } from './openai/chat-completions-responses.js';
import {
  BUILT_IN_SERVER_IDS,
  databaseUrlWithPassword,
  OPENAI_TTS_VOICES,
  parseSpeakingModel,
  routeTargets,
  routeTargetsWithOverride,
  serverUrl,
  isLocalUrl,
  SPEAKING_ENGINES,
  speakingVoiceKey,
  USE_SERVER_TYPES,
  type ModelRoute,
  type ServerType,
  type SpeakingEngineId,
  type UseId,
} from './config/model-routing.js';
import { probeMemoryDatabase, probeModelServer } from './config/model-server-probe.js';
import { ComfyUIPool } from './avatar/generation/comfyui-pool.js';
import { LocalLlmControl } from './local-voice/local-llm-control.js';
import { CodingService, type CodingView } from './coding/coding-service.js';
import { CodingMemoryWriter } from './coding/memory-writer.js';
import { CodingNudger } from './coding/nudger.js';
import { registerCodingTaskIpc } from './coding/task-ipc.js';
import { CODING_SERVER_ID, CODING_TOOL_IDS, createCodingTools } from './coding/tools.js';
import { ApprovalBroker, type ApprovalOutcome, type PendingApproval } from './tools/approvals.js';
import { registerApprovalsIpc } from './tools/approvals-ipc.js';
import { lookupHuggingFace, parseHuggingFaceRef } from './local-llm/huggingface.js';
import { LlmLibrary } from './local-llm/llm-library.js';
import type { LocalLlmSettings } from './local-llm/llm-settings.js';
import { VisionModel } from './local-vision/vision-model.js';
import { VisionServer, withVisionServer } from './local-vision/vision-server.js';
import { MCPManager } from './mcp/mcp-manager.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { createRoutedSearchProvider, createWebSearchTool, WEB_SEARCH_TOOL_ID } from './tools/web-search.js';
import { registerMCPHandlers } from './mcp/ipc-handlers.js';
import { GpuMemoryReader, localPort, type GpuMemoryServer } from './diagnostics/gpu-memory.js';
import { DEFAULT_MEMORY_SERVICE_URL } from './memory-engine/settings.js';
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

// A second copy of the app on one PC (a satellite next to the full app, for testing) needs its own userData folder;
// the single-instance lock below is per userData folder, so the two do not fight over it.
const userDataFolder = userDataOverride(process.env);
if (userDataFolder) app.setPath('userData', userDataFolder);
/** A satellite draws one room of bija's world and runs nothing else (docs/features/satellite.md). */
const satelliteMode = detectSatelliteRole(process.env, app.getPath('userData'));
const satelliteSettings = satelliteMode ? new SatelliteSettingsStore(path.join(app.getPath('userData'), SATELLITE_FILE)) : null;
let satellite: Satellite | null = null;
let satelliteDevices: DeviceRuntime | null = null;

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
let serverManager: ServerManager | null = null;
let avatarModelService: AvatarModelService | null = null;
let avatarAnimationService: AvatarAnimationService | null = null;
let avatarPoseService: AvatarPoseService | null = null;
let backgroundService: BackgroundService | null = null;
let roomService: RoomService | null = null;
let roomGeneration: RoomGenerationService | null = null;
// The scheme that serves downloaded room models must be declared before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: ASSET_SCHEME, privileges: ASSET_SCHEME_PRIVILEGES }]);
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
/** Echo's voice service, kept for the code and tests that only know one avatar. */
let localVoiceService: LocalVoiceService | null = null;
/** One LocalVoiceService per avatar id, sharing the engines below. Null until provider settings are applied. */
let voiceServices: VoiceServices | null = null;
let voiceEngines: ReturnType<typeof buildVoiceEngines> | null = null;
let voiceConfigManager: ConfigManager | null = null;
let avatarRegistry: AvatarRegistry | null = null;
let avatarSettingsKeys: AvatarSettingsKeys | null = null;
/** Who speaks when several avatars share the scene (phase 3). Inert with one avatar. */
let floor: FloorController | null = null;
/** Who is where (this PC's place and the places avatars can walk to). */
let placeManager: PlaceManager | null = null;
/** The link to desktops that draw other rooms (paired with a code, reached over Tailscale). */
let roomHub: RoomHub | null = null;
let proactiveTick: ProactiveTick | null = null;
/** One floor per place that has had a turn: who answers is decided among the avatars at that place. The local one is `floor`. */
const floors = new Map<string, FloorController>();
/** Builds the floor for a place; set once the place manager and the floor's models exist. */
let makeFloor: ((placeId: string) => FloorController) | null = null;
/** The window that sent the latest message of Kevin's; floor-queued answers and chatter reach it. */
let floorSender: WebContents | null = null;
/** The latest session instructions the renderer of each place sent for Echo, reused when Echo takes a back-channel turn there. */
const lastEchoInstructions = new Map<string, string>();
/** What each desktop room's PC last said about itself (presence, devices). bija's own presence is `presence`. */
const placePresence = new PlacePresence();
/** The devices of each desktop room: their state, the kill switch, and the clocks that send avatars home. */
let placeDevices: PlaceDevices | null = null;

/** What the Places page and the Status panel show: each desktop room with what its PC says about its devices. */
function roomHubStatus(hub: RoomHub) {
  const status = hub.status();
  return { ...status, devices: status.devices.map((device) => ({ ...device, deviceState: placePresence.deviceState(device.placeId) })) };
}

/** The place a call came from: a desktop room's calls carry its place id on the fake event; bija's own window is the local place. */
function placeOf(event: unknown): string {
  const id = (event as { placeId?: unknown } | null | undefined)?.placeId;
  return typeof id === 'string' && id ? id : (placeManager?.localPlaceId() ?? HOME_PLACE_ID);
}

/** The floor of a place, made on first use. Null before the app has finished starting. */
function floorFor(placeId: string): FloorController | null {
  const existing = floors.get(placeId);
  if (existing) return existing;
  const made = makeFloor?.(placeId) ?? null;
  if (made) floors.set(placeId, made);
  return made;
}

/** Where events for a place go: bija's window for the local place, the satellite's link for a desktop room, nowhere for an offscreen place. */
const delivery = createPlaceDelivery({
  places: () => placeManager,
  hub: () => roomHub,
  localSink: () => floorSender,
  broadcastLocal: (channel, payload) => broadcastToWindows(channel, payload),
});
const sinkFor = delivery.sinkFor;
const sendForAvatar = delivery.sendForAvatar;
let memoryEngine: MemoryEngineRuntime | null = null;
let memoryStorageSync: MemoryStorageSync | null = null;
let homeServerSync: HomeServerSync | null = null;
let configManagerForMemory: ConfigManager | null = null;

/**
 * The conversation model, as recorded on what the agent writes to memory: the model picked in
 * Models and servers, OpenAI's default, or for a local server with none picked, its name.
 */
function conversationModelName(manager: ConfigManager | null = configManagerForMemory): string | null {
  const target = manager ? routeTargetsWithOverride(manager.getConfig().models, 'llm', codingService?.chatOverride())[0] : undefined;
  if (!target) return null;
  if (target.model?.trim()) return target.model.trim();
  return target.server.type === 'openai' ? DEFAULT_OPENAI_MODELS.llm : target.server.name || null;
}

/** Point the memory engine at the database and mirror picked in Models and servers. */
function syncMemoryStorage(manager: ConfigManager | null = configManagerForMemory): void {
  if (!manager || !memoryEngine) return;
  configManagerForMemory = manager;
  memoryStorageSync ??= new MemoryStorageSync({ client: memoryEngine.client, logger });
  void memoryStorageSync.apply(memoryStorageTargets(manager.getConfig().models, (id) => manager.getServerKey(id)));
  homeServerSync ??= new HomeServerSync({ client: memoryEngine.client, logger });
  void homeServerSync.apply(homeServersFor(manager.getConfig().models, (id) => manager.getServerKey(id)));
}
let currentMotionServiceUrl: string | null = null;

let toolRegistry: ToolRegistry | null = null;
let approvalBroker: ApprovalBroker | null = null;
let codingNudger: CodingNudger | null = null;
// Copies app events onto the switchboard (services/switchboard). Phase 1: mirror only; null when off.
let switchboardClient: SwitchboardClient | null = null;
// Where events go: the client, or a local-only bus when the switchboard is off. Always set once the app is ready.
let switchboardBus: SwitchboardBus | null = null;
/** The last inbox decisions of all avatars, for the Status panel. */
const decisionLog = new DecisionLog(10);
/** Each avatar's mirror (its events on the bus) and inbox (what it does with events addressed to it). */
const avatarPlumbing = new Map<string, { mirror: SwitchboardMirror; inbox: AvatarInbox }>();
/** Whether Kevin is around, for the inbox's decision step. Do-not-disturb is saved in the memory store. */
const presence = new PresenceTracker({
  getValue: (key) => memoryStore?.getValue(key) ?? null,
  setValue: (key, value) => memoryStore?.setValue(key, value),
});
/** The voice turn each avatar is answering now, so tool results can name their turn. */
const activeVoiceRequests = new Map<string, string>();
const seenApprovalIds = new Set<string>();
let codingToolsSignature: string | null = null;

/** Send a message to every open window. */
function broadcastToWindows(channel: string, payload?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}
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
  const window = createAppWindow({ logger, diagnostics, baseDir: __dirname, isProduction, satellite: satelliteSettings ?? undefined });

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

    floor?.wakeWordHeard();
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
 * Where an avatar's voice for an engine is kept. Each engine has its own voices, so a character
 * keeps one per engine; OpenAI's is the one it always had (also used by the Realtime conversation
 * engine). Settings are still saved under the VRM model id; the avatar's profile says which.
 * Without an avatar id: the avatar of the active VRM model.
 */
function characterVoiceKey(engine: SpeakingEngineId | 'openai', avatarId?: string): string | null {
  return avatarSettingsKeys?.voice(engine, avatarId) ?? null;
}

/** Where an avatar's idle habits (what they do when nobody is talking) are kept. */
function characterIdleHabitsKey(avatarId?: string): string | null {
  return avatarSettingsKeys?.idleHabits(avatarId) ?? null;
}

/** Where an avatar's personality prompt is kept. */
function characterPromptKey(avatarId?: string): string | null {
  return avatarSettingsKeys?.prompt(avatarId) ?? null;
}

function characterVoice(engine: SpeakingEngineId | 'openai' | null, avatarId?: string): string | null {
  if (!engine || !memoryStore) return null;
  const key = characterVoiceKey(engine, avatarId);
  return key ? memoryStore.getValue(key) ?? null : null;
}

/** The voices the character can pick for whatever speaks now, and the one it has (the active character's without an avatar id). */
async function speakingVoiceOptions(manager: ConfigManager, avatarId?: string): Promise<SpeakingVoiceOptions> {
  const routing = manager.getConfig().models;
  const target = routeTargets(routing, 'tts')[0];
  const engine = speakingVoiceKey(routing);
  if (!target || !engine) {
    return { engine: null, label: 'Nothing speaks', voices: [], defaultVoice: null, selected: null };
  }
  const route = routing.routes.tts;
  if (engine === 'openai') {
    return {
      engine,
      label: 'OpenAI',
      voices: [...OPENAI_TTS_VOICES],
      defaultVoice: route.voice || 'alloy',
      selected: characterVoice(engine, avatarId),
    };
  }
  const parsed = parseSpeakingModel(target.model);
  const engines = await new SpeechServiceClient({ baseUrl: target.server.url }).ttsEngines();
  const found = engines?.find((entry) => entry.id === engine);
  let voices: string[] = [];
  let fallback: string | null = null;
  if (engine === 'piper') {
    voices = (found?.models ?? []).filter((model) => model.installed).map((model) => model.id);
  } else {
    const model = found?.models.find((entry) => (engine === 'kitten' ? entry.id === parsed.model : true));
    voices = model?.voices ?? [];
    fallback = model?.defaultVoice ?? null;
  }
  if (!found && engine === 'kokoro') {
    voices = (await new SpeechServiceClient({ baseUrl: target.server.url }).health())?.voices ?? [];
  }
  return {
    engine,
    label: found?.label ?? engine,
    voices,
    defaultVoice: parsed.legacyVoice || route.voice || fallback || voices[0] || null,
    selected: characterVoice(engine, avatarId),
  };
}

/**
 * Point the conversation pipeline and motion at the current provider settings and API key. Runs
 * at startup and after every change on the Settings page, so a change applies without a restart
 * (except the local motion model, which the launcher picks when it starts services/motion).
 */
/** The avatar id an IPC call names; Echo when it names none. */
function avatarIdArg(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_AVATAR_ID;
}

/** For settings: no avatar id means the avatar of the active VRM model (what the screens always meant). */
function settingsAvatarArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Who an avatar is to long-term memory: the name of its VRM model, as the memory engine has always been told. */
function avatarAgent(
  store: Pick<MemoryStore, 'getActiveVrmModelId' | 'getVrmModel'>,
  registry: Pick<AvatarRegistry, 'get'> | null,
  avatarId?: string,
): CaptureAgent {
  if (!avatarId || avatarId === DEFAULT_AVATAR_ID) return activeAgent(store);
  const profile = registry?.get(avatarId);
  if (!profile) return activeAgent(store);
  try {
    const model = profile.vrmModelId ? store.getVrmModel(profile.vrmModelId) : null;
    const name = model?.name?.trim() || profile.name.trim();
    if (name) return { name, id: profile.vrmModelId };
  } catch {
    // Fall through to the generic name.
  }
  return { name: profile.name || 'assistant', id: null };
}

/**
 * A note for an avatar goes onto the bus as avatar.inbox; its inbox (below) hands it to that
 * avatar's LocalVoiceService.notify, over the switchboard or, when it is not connected, straight
 * back. Before the bus exists (very early) it goes to the avatar's service directly.
 */
function notifyAvatar(avatarId: string, text: string, urgent: boolean): void {
  const mirror = avatarPlumbing.get(avatarId)?.mirror;
  if (mirror) mirror.noteQueued(text, urgent);
  else getVoiceService(avatarId)?.notify(text, { urgent });
}

/**
 * Give an avatar its switchboard presence: a mirror (its events on the bus) and an inbox (what it
 * does with events addressed to it). Adding an avatar later is one call to this with its profile.
 */
function startAvatarPlumbing(profile: AvatarProfile, manager: ConfigManager): void {
  if (!switchboardBus || avatarPlumbing.has(profile.id)) return;
  const avatarId = profile.id;
  const mirror = new SwitchboardMirror({ client: switchboardBus, avatarId });
  const inbox = new AvatarInbox({
    avatarId,
    bus: switchboardBus,
    notify: (text, options) => getVoiceService(avatarId)?.notify(text, options),
    // Quick decisions (Laya) first, built per call so a changed route applies at once; the chat model when it is off, fails or is unsure.
    deliberate: (event) => {
      const avatarName = avatarRegistry?.get(avatarId)?.name ?? profile.name;
      return deliberateFast(event, presence, {
        makeClient: () => createSystemOne({ routing: manager.getConfig().models, keyFor: (id) => manager.getServerKey(id), logger }),
        fallback: (e) => deliberate(e, presence, { avatarName, routing: manager.getConfig().models, keyFor: (id) => manager.getServerKey(id), logger }),
        avatarName,
        logger,
      });
    },
    onRemembered: (text) => proactiveTick?.noteRemembered(text),
    remember: (_event, text, source) => {
      conversationManager?.appendToRecentSession([
        { role: 'system', content: `[Update from ${source}, not from Kevin, saved quietly] ${text}`, ts: Date.now() },
      ]);
    },
    doNotDisturb: () => presence.doNotDisturb,
    onDecision: (decision) => decisionLog.record(decision),
    logger,
  });
  avatarPlumbing.set(avatarId, { mirror, inbox });
  inbox.start();
}

/**
 * `ipcMain.handle`, plus a note of the handler so the room hub can run the same function for a desktop room's
 * `call` (docs/features/room-link-protocol.md).
 */
function handleIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  rememberIpcHandler(channel, listener as Parameters<typeof rememberIpcHandler>[1]);
  ipcMain.handle(channel, listener);
}

function requirePlaces(): PlaceManager {
  if (!placeManager) throw new Error('Places are not available yet.');
  return placeManager;
}

function requireAvatarRegistry(): AvatarRegistry {
  if (!avatarRegistry) throw new Error('Avatars are not available yet.');
  return avatarRegistry;
}

/** Lowercase a-z0-9_- slug of an avatar name; "avatar" when nothing usable is left. */
function slugifyAvatarName(name: string): string {
  return avatarIdForName(name).slice(0, 60) || 'avatar';
}

/** Validate the renderer's add/update fields (name <= 80, prompt <= 4000). */
function readAvatarFields(input: unknown, requireName: boolean): { name?: string; vrmModelId?: string | null; prompt?: string } {
  if (!input || typeof input !== 'object') throw new Error('Avatar details are required.');
  const { name, vrmModelId, prompt } = input as Record<string, unknown>;
  const out: { name?: string; vrmModelId?: string | null; prompt?: string } = {};
  if (name !== undefined || requireName) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Give the avatar a name.');
    if (name.trim().length > 80) throw new Error('The name can be at most 80 characters.');
    out.name = name.trim();
  }
  if (vrmModelId !== undefined && vrmModelId !== null) {
    if (typeof vrmModelId !== 'string' || vrmModelId.length > 200) throw new Error('Invalid body.');
    out.vrmModelId = vrmModelId || null;
  } else if (vrmModelId === null) {
    out.vrmModelId = null;
  }
  if (prompt !== undefined) {
    if (typeof prompt !== 'string') throw new Error('The prompt must be text.');
    if (prompt.length > 4000) throw new Error('The prompt can be at most 4000 characters.');
    out.prompt = prompt;
  }
  return out;
}

/** The avatar's mirror, Echo's when no id is given. */
function mirrorFor(avatarId: string = DEFAULT_AVATAR_ID): SwitchboardMirror | undefined {
  return avatarPlumbing.get(avatarId)?.mirror;
}

/** The avatar a switchboard address such as `avatar:echo` names (Echo for anything else). */
function avatarIdOfAddress(address: string | undefined): string {
  return address?.startsWith('avatar:') ? address.slice('avatar:'.length) || DEFAULT_AVATAR_ID : DEFAULT_AVATAR_ID;
}

/**
 * The voice service for an avatar, made on first use with that avatar's own history and notes
 * and the shared engines. Null until provider settings have been applied.
 */
function getVoiceService(avatarId: string = DEFAULT_AVATAR_ID): LocalVoiceService | null {
  return voiceServices ? voiceServices.get(avatarId) : null;
}

/** Movement tag instructions the renderer sent for the avatars other than Echo (empty until it sends them). */
const avatarTagInstructionsByPlace = new Map<string, AvatarTagInstructions>();
const NO_TAG_INSTRUCTIONS: AvatarTagInstructions = { shared: '', moveOnly: '' };

/**
 * The personality text of an avatar other than Echo: the prompt saved for its own VRM model when
 * it wears one, else the profile's prompt. An avatar sharing Echo's body (no model, or the one Echo
 * wears) never borrows her saved prompt. The Characters pop-up shows exactly this text.
 */
function avatarPersona(avatarId: string): { persona: string | undefined; ownModel: boolean } {
  const profile = avatarRegistry?.get(avatarId);
  const ownModel = Boolean(profile?.vrmModelId) && !avatarSettingsKeys?.sharesEchoBody(avatarId);
  const key = ownModel ? characterPromptKey(avatarId) : null;
  const saved = key ? memoryStore?.getValue(key)?.trim() : '';
  return { persona: saved || profile?.prompt || undefined, ownModel };
}

/**
 * Adds the places paragraph (where the avatar is, who is where, the {room:} tag) to an avatar's system prompt.
 * Every turn gets it, chatter included; a preview turn does not.
 */
function withPlacesNote(instructions: string | undefined, preview = false, placeId?: string): string | undefined {
  if (preview || !placeManager) return instructions;
  // "You are in ..." is told from the place the avatar is in.
  const note = placesNote(scopedPlaces(placeManager, placeId ?? placeManager.localPlaceId()), (id) => avatarRegistry?.get(id)?.name ?? id);
  if (!note) return instructions;
  return instructions?.trim() ? `${instructions.trim()}\n\n${note}` : note;
}

/**
 * The system prompt for an avatar's turn. Echo uses what the renderer sent (or the last it sent,
 * or her saved prompt). Another avatar uses the prompt saved for its own VRM model, if it has a
 * model of its own, else its profile's prompt; avatars wearing Echo's body never borrow her prompt.
 * The movement tag instructions from the renderer follow the persona.
 */
function avatarInstructions(avatarId: string, sessionInstructions?: string, placeId: string = placeManager?.localPlaceId() ?? HOME_PLACE_ID): string | undefined {
  if (avatarId === DEFAULT_AVATAR_ID) {
    if (sessionInstructions?.trim()) return sessionInstructions;
    const lastHere = lastEchoInstructions.get(placeId);
    if (lastHere) return lastHere;
    const key = characterPromptKey(DEFAULT_AVATAR_ID);
    return (key ? memoryStore?.getValue(key) : null)?.trim() || undefined;
  }
  const profile = avatarRegistry?.get(avatarId);
  const { persona, ownModel } = avatarPersona(avatarId);
  return composeAvatarPrompt({
    name: profile?.name ?? avatarId,
    persona,
    ownModel,
    tags: avatarTagInstructionsByPlace.get(placeId) ?? NO_TAG_INSTRUCTIONS,
    avatarId,
  });
}

/** One voice turn for an avatar: the mirror, presence and the renderer's events around LocalVoiceService.respond. */
async function runVoiceTurn(
  sender: EventSink,
  request: LocalVoiceRespondRequest,
  voiceService: LocalVoiceService,
  placeId: string = placeManager?.localPlaceId() ?? HOME_PLACE_ID,
): Promise<LocalVoiceRespondResult> {
  const avatarId = voiceService.avatarId;
  const baseInstructions = avatarId === DEFAULT_AVATAR_ID ? request.instructions : (avatarInstructions(avatarId, request.instructions, placeId) ?? request.instructions);
  const instructions = withPlacesNote(baseInstructions, request.preview === true, placeId);
  const payload = instructions === request.instructions ? request : { ...request, ...(instructions !== undefined ? { instructions } : {}) };
  const mirror = mirrorFor(avatarId);
  mirror?.turnStarted(payload.requestId, { text: payload.text, system: payload.system === true, preview: payload.preview === true });
  activeVoiceRequests.set(avatarId, payload.requestId);
  // bija's presence is about bija's room; a desktop room's own presence is kept apart.
  const here = placeId === (placeManager?.localPlaceId() ?? HOME_PLACE_ID);
  if (!payload.preview && !payload.system) {
    if (here) presence.update({ lastUserSpeechAt: Date.now() });
    else placePresence.update(placeId, { userSpokeAt: Date.now() });
  }
  try {
    const result = await voiceService.respond(payload, (voiceEvent) => {
      if (!sender.isDestroyed()) {
        sender.send('local-voice:event', tagEvent(voiceEvent, avatarId));
      }
    });
    if (!payload.preview) mirror?.turnFinished(payload.requestId, { text: result.text, cancelled: result.cancelled });
    if (!payload.preview && result.text) {
      if (here) presence.update({ lastAssistantSpokeAt: Date.now() });
      else placePresence.update(placeId, { assistantSpokeAt: Date.now() });
    }
    return tagResult(result, avatarId);
  } catch (error) {
    if (!payload.preview) mirror?.turnFinished(payload.requestId, { text: '', error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    if (activeVoiceRequests.get(avatarId) === payload.requestId) activeVoiceRequests.delete(avatarId);
  }
}

function createVoiceService(avatarId: string): LocalVoiceService {
  const manager = voiceConfigManager;
  if (!voiceEngines || !manager) throw new Error('Voice engines are not configured yet.');
  return new LocalVoiceService({
    ...voiceEngines,
    avatarId,
    tools: toolRegistry ?? undefined,
    approvals: approvalBroker?.forAvatar(avatarId),
    extraInstructions: () => codingBrief(manager),
    // The update is spoken where the avatar is.
    onSystemReady: () =>
      sendForAvatar(avatarId, 'local-voice:system-ready', {
        urgent: getVoiceService(avatarId)?.systemStatus().urgent === true,
        ...(avatarId === DEFAULT_AVATAR_ID ? {} : { avatarId }),
      }),
    logger,
    onToolResult: (record) => {
      memoryEngine?.recordToolCall(record);
      mirrorFor(avatarId)?.toolResult(record, activeVoiceRequests.get(avatarId));
    },
    voiceFor: () => characterVoice(speakingVoiceKey(manager.getConfig().models), avatarId) ?? undefined,
    // Through memoryEngine at call time: it is set up after this service.
    memory: {
      brief: () => memoryEngine?.voiceFor(avatarId).brief() ?? Promise.resolve(null),
      recall: (text, recalled) => memoryEngine?.voiceFor(avatarId).recall(text, recalled) ?? Promise.resolve(null),
      activity: (busy) => memoryEngine?.voiceFor(avatarId).activity?.(busy),
    },
  });
}

async function applyProviderSettings(manager: ConfigManager): Promise<void> {
  const config = manager.getConfig();
  const { providers, models } = config;
  const engines = buildVoiceEngines(models, (id) => manager.getServerKey(id), { logger, llmOverride: codingService?.chatOverride() });
  voiceEngines = engines;
  voiceConfigManager = manager;
  if (voiceServices) {
    voiceServices.configure(engines);
  } else {
    voiceServices = new VoiceServices({ create: createVoiceService });
  }
  localVoiceService = voiceServices.get(DEFAULT_AVATAR_ID);

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
  applyCodingTools(manager);
  configManagerForMemory = manager;
  syncMemoryStorage(manager);
  void getCodingService(manager)
    .apply()
    .catch((error: unknown) => logger.warn('Coding runner setup failed.', { message: error instanceof Error ? error.message : String(error) }));

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
    settings: () => library.settings(),
  });
  localLlmTools = { library, control };
  return localLlmTools;
}

/**
 * The vision model for Describe the avatar and Check poses: its download (local-vision.json) and the
 * llama-server that runs it only while a job needs it. Built on first use.
 */
let visionTools: { model: VisionModel; server: VisionServer } | null = null;
function getVisionTools(manager: ConfigManager): { model: VisionModel; server: VisionServer } {
  if (visionTools) return visionTools;
  const home = process.env.AIEMBODIED_HOST_USERPROFILE?.trim() || os.homedir();
  const logDirectory = path.join(app.getPath('userData'), 'logs');
  const repoRoot = path.resolve(__dirname, '../../..');
  const baseUrl = () => {
    const server = manager.getConfig().models.servers.find((entry) => entry.id === BUILT_IN_SERVER_IDS.vision);
    return server && isLocalUrl(server.url) ? serverUrl(server.type, server.url) : null;
  };
  const model = new VisionModel({
    file: path.join(app.getPath('userData'), 'local-vision.json'),
    modelsDirectory: process.env.LOCAL_LLM_MODELS_DIR?.trim() || path.join(home, '.cache', 'aiembodied', 'llm-models'),
    token: () => manager.getServerKey(BUILT_IN_SERVER_IDS.huggingface),
    logger,
  });
  const server = new VisionServer({
    baseUrl,
    pick: () => model.pick(),
    repoRoot,
    logDirectory,
    // Reuses the llama-server stopper; it only ever stops a process named llama-server on that port.
    stop: () => new LocalLlmControl({ baseUrl, repoRoot, logDirectory, fileName: 'vision' }).stop(),
    logger,
  });
  visionTools = { model, server };
  return visionTools;
}

/** Run a helper job on the vision model when `use` is routed to it (starting it first), else as is. */
function withVision<T>(manager: ConfigManager, use: 'describe' | 'posecheck', job: () => Promise<T>): Promise<T> {
  return withVisionServer(manager.getConfig().models, use, getVisionTools(manager).server, job);
}

/**
 * Run a downloaded model (or, with null, the start script's default) for Thinking: point Thinking
 * at this PC's llama-server and restart it with that model. Returns what happened, in words.
 */
async function useLocalLlm(manager: ConfigManager, id: string | null, settings?: Partial<LocalLlmSettings>): Promise<string> {
  const { library, control } = getLocalLlmTools(manager);
  const model = await library.select(id);
  if (settings) await library.setSettings(settings);
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

/**
 * The coding runner side: events, sync, and swapping the local models while a task needs the coder
 * model. Built on first use, like the local LLM tools it borrows Echo's llama-server control from.
 */
const gpuMemoryReader = new GpuMemoryReader();
let codingService: CodingService | null = null;
function getCodingService(manager: ConfigManager): CodingService {
  if (codingService) return codingService;
  const { control } = getLocalLlmTools(manager);
  const repoRoot = path.resolve(__dirname, '../../..');
  codingService = new CodingService({
    settings: () => {
      const { models, coding } = manager.getConfig();
      return { models, coding };
    },
    keyFor: (id) => manager.getServerKey(id),
    echoControl: control,
    // Its pid file is coder-llm.pid in the logs folder, so ServerManager stops it when the app quits.
    coderControl: (model, baseUrl) =>
      new LocalLlmControl({
        baseUrl: () => baseUrl,
        repoRoot,
        logDirectory: path.join(app.getPath('userData'), 'logs'),
        model: async () => model,
        fileName: 'coder-llm',
        // The coder runs one job at a time, so it keeps one slot whatever Thinking is set to.
        slots: 1,
      }),
    onOverrideChange: () => applyProviderSettings(manager),
    gpuMemory: gpuMemoryReader,
    notify: (text, options) => notifyAvatar(CODING_NUDGE_AVATAR_ID, text, options?.urgent === true),
    logger,
  });
  const service = codingService;
  const workspaceName = (id: string | undefined) => manager.getCoding().workspaces.find((ws) => ws.id === id)?.name ?? id ?? 'a workspace';
  codingNudger = new CodingNudger({
    notify: (text, options) => notifyAvatar(CODING_NUDGE_AVATAR_ID, text, options?.urgent === true),
    getTask: (id) => service.runnerClient()?.getTask(id).catch(() => null) ?? Promise.resolve(null),
    workspaceName,
    logger,
  });
  service.onRunnerEvent((event) => void codingNudger?.handleEvent(event));
  service.onRunnerEvent((event) => mirrorFor(CODING_NUDGE_AVATAR_ID)?.runnerEvent(event));
  // Finished tasks become memories. The memory engine is set up later, so it is read at call time.
  const memoryWriter = new CodingMemoryWriter({
    getTask: (id) => service.runnerClient()?.getTask(id).catch(() => null) ?? Promise.resolve(null),
    workspaceName,
    post: (task) => memoryEngine?.outbox.enqueue({ kind: 'coding_task', task }),
    agentName: () => (memoryStore ? avatarAgent(memoryStore, avatarRegistry, CODING_NUDGE_AVATAR_ID).name : null),
    logger,
  });
  service.onRunnerEvent((event) => void memoryWriter.handleEvent(event));
  return codingService;
}

/** Coding updates (task questions, reviews, nudges) go to this avatar until tasks can be handed to others. */
const CODING_NUDGE_AVATAR_ID = DEFAULT_AVATAR_ID;

/** Echo's coding tools exist while workspaces are set up. Re-registered when the list changes. */
function applyCodingTools(manager: ConfigManager): void {
  if (!toolRegistry) return;
  const service = getCodingService(manager);
  const workspaces = manager.getCoding().workspaces;
  const signature = JSON.stringify(workspaces.map((ws) => [ws.id, ws.name, ws.kind]));
  if (signature === codingToolsSignature) return;
  codingToolsSignature = signature;
  for (const id of Object.values(CODING_TOOL_IDS)) toolRegistry.unregister(id);
  if (workspaces.length === 0) {
    logger.info('Coding tools are off: no workspaces.');
    return;
  }
  for (const tool of createCodingTools({
    client: () => service.runnerClient(),
    workspaces: () => manager.getCoding().workspaces,
    suppressNudge: (taskId, status) => codingNudger?.suppress(taskId, status),
  })) {
    toolRegistry.register(tool);
  }
  logger.info('Coding tools registered', { server: CODING_SERVER_ID, workspaces: workspaces.length });
}

/** One line for Echo's prompt: where the coding agent can work. Empty when it can't be reached. */
function codingBrief(manager: ConfigManager): string | null {
  const workspaces = manager.getCoding().workspaces;
  if (workspaces.length === 0 || !codingService?.status().runnerUp) return null;
  const names = workspaces.map((ws) => (ws.kind === 'self' ? `${ws.name} (your own code)` : ws.name)).join(', ');
  return `You can hand coding work to the coding agent in: ${names}. Use the coding tools.`;
}

async function codingView(manager: ConfigManager): Promise<CodingView> {
  const service = getCodingService(manager);
  return { coding: manager.getCoding(), runnerId: service.runnerServer()?.id ?? null, status: service.status() };
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
      handleIpc(channel, instrumentedHandler);
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
  // Status and diagnostics: GPU memory on this PC, split by the app's local servers.
  const GPU_SERVER_LABELS: Record<string, string> = {
    [BUILT_IN_SERVER_IDS.llm]: 'Language model',
    [BUILT_IN_SERVER_IDS.speech]: 'Speech (TTS)',
    [BUILT_IN_SERVER_IDS.motion]: 'Motion',
    [BUILT_IN_SERVER_IDS.comfy]: 'ComfyUI',
    [BUILT_IN_SERVER_IDS.searxng]: 'SearXNG',
    [BUILT_IN_SERVER_IDS.memory]: 'Memory database',
    [BUILT_IN_SERVER_IDS.coderLlm]: 'Coding model',
    [BUILT_IN_SERVER_IDS.vision]: 'Vision model',
  };
  handleIpc('diagnostics:gpu-memory', () => {
    const servers: GpuMemoryServer[] = [];
    const seen = new Set<number>();
    const add = (id: string, name: string, url: string | undefined) => {
      const port = localPort(url);
      if (port === null || seen.has(port)) return;
      seen.add(port);
      servers.push({ id, name, port });
    };
    for (const server of manager.getConfig().models.servers) {
      add(server.id, GPU_SERVER_LABELS[server.id] ?? server.name, server.url);
    }
    // Started by pnpm dev:run beside the servers above, not listed in Models and servers.
    add('local-asr', 'Speech-to-text (ASR)', process.env.STT_URL?.trim() || 'http://127.0.0.1:1235/v1');
    add('local-memory-engine', 'Memory engine', process.env.MEMORY_SERVICE_URL?.trim() || DEFAULT_MEMORY_SERVICE_URL);
    return gpuMemoryReader.read(servers);
  });
  // Coding page of the Models and servers pop-up, and the coding line in Status and diagnostics.
  handleIpc('coding:get', () => codingView(manager));
  handleIpc('coding:status', () => getCodingService(manager).status());
  handleIpc('coding:set', async (_event, next: unknown) => {
    await manager.setCoding(next);
    await applyProviderSettings(manager);
    return codingView(manager);
  });
  handleIpc('coding:pick-gguf', async () => {
    const options = { title: 'Choose the Qwen3-Coder-Next file', properties: ['openFile' as const], filters: [{ name: 'GGUF model', extensions: ['gguf'] }] };
    const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handleIpc('coding:pick-folder', async () => {
    const options = { title: 'Choose a git repository', properties: ['openDirectory' as const] };
    const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  registerCodingTaskIpc({
    ipcMain,
    client: () => getCodingService(manager).runnerClient(),
    onRunnerEvent: (listener) => getCodingService(manager).onRunnerEvent(listener),
    broadcast: broadcastToWindows,
  });
  if (approvalBroker) {
    registerApprovalsIpc({ ipcMain, broker: approvalBroker, broadcast: broadcastToWindows });
  }
  handleIpc('coding:suggest-checks', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a workspace first.');
    const service = getCodingService(manager);
    await service.apply();
    return service.suggestChecks(id);
  });
  // Models and servers pop-up. Keys go in, never out: the view only says whether one is set.
  handleIpc('models:get', () => manager.getModelRoutingView());
  handleIpc('models:probe', async (_event, payload: { serverId?: unknown; draft?: { type?: unknown; url?: unknown; key?: unknown } }) => {
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
  handleIpc(
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
  handleIpc('models:remove-server', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a server to remove.');
    await manager.removeModelServer(id);
    await applyProviderSettings(manager);
    return manager.getModelRoutingView();
  });
  handleIpc('models:set-route', async (_event, payload: { use?: unknown; route?: unknown }) => {
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
  handleIpc('models:civitai-lookup', async (_event, payload: { ref?: unknown; versionId?: unknown }) => {
    const ref = parseCivitaiRef(typeof payload?.ref === 'string' ? payload.ref : '');
    if (!ref) throw new Error('Paste a Civitai link (civitai.com, .green or .red: a model page or download link) or an AIR (urn:air:…:civitai:123@456).');
    const model = await lookupCivitai(ref, manager.getServerKey(BUILT_IN_SERVER_IDS.civitai));
    const versionId = typeof payload?.versionId === 'number' ? payload.versionId : undefined;
    return {
      versions: model.versions.map((version) => ({ id: version.id, name: version.name, baseModel: version.baseModel })),
      plan: planCivitaiDownload(model, versionId, ref.fileId),
    };
  });
  handleIpc('models:download', async (_event, payload: { serverId?: unknown; ref?: unknown; versionId?: unknown }) => {
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
  handleIpc('models:downloads', () => modelDownloads.list());
  const speechServerClient = (serverId: unknown) => {
    const server = manager.getConfig().models.servers.find((entry) => entry.id === serverId && entry.type === 'speech');
    if (!server) throw new Error('That is not a speech service.');
    return new SpeechServiceClient({ baseUrl: server.url });
  };
  handleIpc('models:speech-engines', (_event, serverId: unknown) => speechServerClient(serverId).ttsEngines());
  handleIpc('models:speech-download', async (_event, payload: { serverId?: unknown; engine?: unknown; model?: unknown }) => {
    if (typeof payload?.engine !== 'string' || typeof payload.model !== 'string') {
      throw new Error('Pick a model to download.');
    }
    const client = speechServerClient(payload.serverId);
    await client.downloadTtsModel(payload.engine, payload.model);
    return client.ttsEngines();
  });
  handleIpc('models:cancel-download', (_event, id: unknown) => {
    if (typeof id === 'string') modelDownloads.cancel(id);
    return modelDownloads.list();
  });
  handleIpc('models:comfy-addon', async (_event, serverId: unknown) => {
    const server = comfyServer(serverId);
    return { installed: await modelDownloads.hasAddon(server), folder: comfyAddonDirectory };
  });
  // Thinking models from Hugging Face, for this PC's llama-server.
  const hfToken = () => manager.getServerKey(BUILT_IN_SERVER_IDS.huggingface);
  const localLlmList = async () => {
    const { library } = getLocalLlmTools(manager);
    return { ...(await library.read()), folder: library.modelsDirectory, settings: await library.settings() };
  };
  handleIpc('models:hf-lookup', async (_event, ref: unknown) => {
    const parsed = parseHuggingFaceRef(typeof ref === 'string' ? ref : '');
    if (!parsed) throw new Error('Paste a Hugging Face link or repo name (such as unsloth/Qwen3-8B-GGUF), or type words to search for.');
    return lookupHuggingFace(parsed, hfToken());
  });
  handleIpc('models:hf-download', async (_event, payload: { repo?: unknown; quant?: unknown; use?: unknown }) => {
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
  handleIpc('models:hf-downloads', () => getLocalLlmTools(manager).library.list());
  handleIpc('models:hf-cancel', (_event, id: unknown) => {
    const { library } = getLocalLlmTools(manager);
    if (typeof id === 'string') library.cancel(id);
    return library.list();
  });
  // The vision model (Qwen3-VL) for Describe the avatar: download status and progress.
  handleIpc('models:vision-status', () => getVisionTools(manager).model.status());
  handleIpc('models:vision-download', async (_event, ref: unknown) => {
    const { model } = getVisionTools(manager);
    await model.download(typeof ref === 'string' ? ref : undefined);
    return model.status();
  });
  handleIpc('models:vision-cancel', async () => {
    const { model } = getVisionTools(manager);
    model.cancel();
    return model.status();
  });
  handleIpc('models:local-llms', () => localLlmList());
  handleIpc('models:use-local-llm', async (_event, id: unknown, settings: unknown) => {
    const given = settings && typeof settings === 'object' ? (settings as Partial<LocalLlmSettings>) : undefined;
    const message = await useLocalLlm(manager, typeof id === 'string' && id ? id : null, given);
    return { message, library: await localLlmList(), models: manager.getModelRoutingView() };
  });
  handleIpc('models:delete-local-llm', async (_event, id: unknown) => {
    if (typeof id === 'string') await getLocalLlmTools(manager).library.remove(id);
    return localLlmList();
  });
  handleIpc('models:set-key', async (_event, payload: { serverId?: unknown; key?: unknown }) => {
    if (typeof payload?.serverId !== 'string') throw new Error('Choose a server.');
    await manager.setServerKey(payload.serverId, typeof payload.key === 'string' ? payload.key : '');
    await applyProviderSettings(manager);
    return manager.getModelRoutingView();
  });
  handleIpc('talk:get-shortcut-status', () => pushToTalk.getStatus());
  handleIpc('wake-word:list', () => listWakeWords(trainedWakeWordDirectory()));
  handleIpc('wake-word:set-listening', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Listening must be enabled or disabled.');
    return wakeWordListening.setEnabled(enabled);
  });
  handleIpc('wake-word:get-training-status', () =>
    wakeWordTrainer ? wakeWordTrainer.getStatus() : { available: false, reason: 'Training is not set up.', job: null },
  );
  handleIpc('wake-word:train', (_event, payload: { phrase?: unknown; quick?: unknown }) => {
    if (!wakeWordTrainer) {
      throw new Error('Wake word training is not set up.');
    }
    return wakeWordTrainer.start(typeof payload?.phrase === 'string' ? payload.phrase : '', { quick: payload?.quick === true });
  });
  handleIpc('wake-word:cancel-training', () =>
    wakeWordTrainer ? wakeWordTrainer.cancel() : { available: false, reason: 'Training is not set up.', job: null },
  );
  registerConfigHandler('config:test-secret', (_event, key: ConfigSecretKey) => manager.testSecret(key));
  registerConfigHandler('config:set-audio-devices', (_event, preferences) =>
    manager.setAudioDevicePreferences(preferences),
  );

  handleIpc('realtime:mint-ephemeral-token', async (_event, payload: RealtimeEphemeralTokenRequest) => {
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
  handleIpc('conversation:get-history', () => {
    if (!conversation) {
      throw new Error('Conversation manager is not initialized.');
    }
    return conversation.getHistory();
  });
  handleIpc('conversation:append-message', (_event, payload: ConversationAppendMessagePayload) => {
    if (!conversation) {
      throw new Error('Conversation manager is not initialized.');
    }
    return conversation.appendMessage(payload);
  });
  handleIpc('conversation:announce', (_event, payload: { note?: string; reply?: string; ts?: number }) => {
    if (!conversation) {
      throw new Error('Conversation manager is not initialized.');
    }
    const ts = typeof payload?.ts === 'number' ? payload.ts : Date.now();
    const messages: Omit<ConversationAppendMessagePayload, 'sessionId'>[] = [];
    if (payload?.note?.trim()) messages.push({ role: 'system', content: payload.note, ts });
    if (payload?.reply?.trim()) messages.push({ role: 'assistant', content: payload.reply, ts });
    return messages.length > 0 ? conversation.appendToRecentSession(messages) : [];
  });
  handleIpc('metrics:observe-latency', (_event, payload: LatencyObservation) => {
    if (!metrics) {
      return false;
    }

    if (!payload || typeof payload.valueMs !== 'number') {
      throw new Error('Invalid latency observation payload received.');
    }

    metrics.observeLatency(payload.metric, payload.valueMs);
    return true;
  });
  handleIpc('avatar-model:list', async () => {
    if (!avatarModels) {
      return [] as AvatarModelSummary[];
    }

    return avatarModels.listModels();
  });
  handleIpc('avatar-model:get-active', async () => {
    if (!avatarModels) {
      return null;
    }

    return avatarModels.getActiveModel();
  });
  handleIpc('avatar-model:set-active', async (_event, modelId: string | null) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    return avatarModels.setActiveModel(modelId);
  });
  handleIpc('avatar-model:upload', async (_event, payload: AvatarModelUploadRequest) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    return avatarModels.uploadModel(payload) as Promise<AvatarModelUploadResult>;
  });
  handleIpc('avatar-model:delete', async (_event, modelId: string) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    await avatarModels.deleteModel(modelId);
    return true;
  });
  handleIpc('avatar-model:load', async (_event, modelId: string) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    return avatarModels.loadModelBinary(modelId);
  });
  const requireRooms = (): RoomService => {
    if (!roomService) throw new Error('Rooms are unavailable.');
    return roomService;
  };
  const requireBackgrounds = (): BackgroundService => {
    if (!backgroundService) throw new Error('Backgrounds are unavailable.');
    return backgroundService;
  };
  handleIpc('background:list', () => requireBackgrounds().list());
  handleIpc('background:get-active', () => requireBackgrounds().getActive());
  handleIpc('background:set-active', (_event, id: string | null) => requireBackgrounds().setActive(id));
  handleIpc('background:load', (_event, id: string) => requireBackgrounds().load(id));
  handleIpc('background:generate', (_event, prompt: string) => requireBackgrounds().generate(prompt));
  handleIpc('background:delete', (_event, id: string) => requireBackgrounds().delete(id));
  handleIpc('background:list-rooms', () => requireRooms().list());
  handleIpc('background:load-room', (_event, id: string) => requireRooms().load(id));
  const requireGeneration = (): RoomGenerationService => {
    if (!roomGeneration) throw new Error('Room building is unavailable.');
    return roomGeneration;
  };
  handleIpc('rooms:generate', (_event, description: unknown) =>
    requireGeneration().generate(String(description ?? ''), (progress) => broadcastToWindows('rooms:generate-progress', progress)),
  );
  handleIpc('rooms:cancel-generate', () => requireGeneration().cancel());
  handleIpc('rooms:making', () => requireGeneration().making);
  const objectSettingsView = () => ({
    ...requireBackgrounds().getObjectSettings(),
    available: objectMakingAvailable(manager.getConfig().models),
  });
  handleIpc('rooms:object-settings:get', () => objectSettingsView());
  handleIpc('rooms:object-settings:set', (_event, settings: unknown) => {
    requireBackgrounds().setObjectSettings(settings);
    return objectSettingsView();
  });
  handleIpc('rooms:generated:list', () => requireGeneration().listGenerated());
  handleIpc('rooms:generated:delete', (_event, id: unknown) => requireGeneration().deleteGenerated(String(id ?? '')));
  handleIpc('rooms:delete', async (_event, id: string) => {
    await requireGeneration().delete(id);
    if (backgroundService && (await backgroundService.getActive()) === id) await backgroundService.setActive(null);
  });
  handleIpc('rooms:idle-settings:get', () => requireBackgrounds().getIdleSettings());
  handleIpc('rooms:idle-settings:set', (_event, settings: unknown) => requireBackgrounds().setIdleSettings(settings));
  // The "Idle thoughts" job: what the avatar does next on its own. Null on any failure; the renderer then picks at random.
  handleIpc('rooms:idle-pick', (_event, context: unknown) =>
    pickIdleActions(context as { system: string; user: string }, {
      routing: manager.getConfig().models,
      keyFor: (id) => manager.getServerKey(id),
      logger,
    }),
  );
  const requireAvatarGeneration = (): AvatarGenerationService => {
    if (!avatarGenerationService) {
      throw new Error('Avatar generation is unavailable.');
    }
    return avatarGenerationService;
  };
  handleIpc('avatar:image-models', async () => { if (!avatarImageModels) throw new Error('Image models are unavailable.'); return avatarImageModels.list(); });
  handleIpc('avatar:image-model-select', async (_event, id: string) => { if (!avatarImageModels) throw new Error('Image models are unavailable.'); await avatarImageModels.select(id); });
  handleIpc('avatar:image-loras-select', async (_event, choices: unknown) => {
    if (!avatarImageModels) throw new Error('Image models are unavailable.');
    avatarImageModels.selectLoras(Array.isArray(choices) ? choices : []);
  });
  // Popular Civitai checkpoints for a LoRA's base model, sized against the image server's GPU.
  handleIpc('avatar:base-model-suggestions', async (_event, payload: { baseModel?: unknown; family?: unknown }) => {
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
  handleIpc('avatar:character-models', async () => { if (!avatarCharacterModels) throw new Error('3D avatar models are unavailable.'); return avatarCharacterModels.list(); });
  handleIpc('avatar:character-model-select', async (_event, stage: 'geometry' | 'rig', id: string) => { if (!avatarCharacterModels) throw new Error('3D avatar models are unavailable.'); await avatarCharacterModels.select(stage, id); });
  handleIpc('avatar:generation-list', async (): Promise<AvatarGenerationStatus[]> => requireAvatarGeneration().listJobs());
  handleIpc('avatar:generation-cancel', async (_event, jobId: string): Promise<void> => requireAvatarGeneration().cancel(jobId));
  handleIpc(
    'avatar:generation-start',
    async (_event, payload: AvatarGenerationRequest): Promise<AvatarGenerationJob> =>
      requireAvatarGeneration().startJob(payload),
  );
  handleIpc('avatar:generation-remove-background', async (_event, jobId: string) => requireAvatarGeneration().removeConceptBackground(jobId));
  handleIpc('avatar:generation-restore-background', async (_event, jobId: string) => requireAvatarGeneration().restoreConceptBackground(jobId));
  handleIpc('avatar:generation-redraw-views', async (_event, jobId: string) => requireAvatarGeneration().redrawViews(jobId));
  handleIpc('avatar:generation-confirm-concept', async (_event, jobId: string, confirmation?: AvatarGenerationConfirmation): Promise<void> => requireAvatarGeneration().confirmConcept(jobId, confirmation));
  handleIpc(
    'avatar:generation-status',
    async (_event, jobId: string): Promise<AvatarGenerationStatus> => requireAvatarGeneration().getStatus(jobId),
  );
  handleIpc(
    'avatar:generation-preview',
    async (_event, jobId: string): Promise<Buffer> => requireAvatarGeneration().loadPreview(jobId),
  );
  handleIpc(
    'avatar:generation-accept',
    async (_event, jobId: string): Promise<AvatarGenerationAcceptance> => requireAvatarGeneration().accept(jobId),
  );
  handleIpc('avatar:generation-reject', async (_event, jobId: string): Promise<void> =>
    requireAvatarGeneration().reject(jobId),
  );
  handleIpc(
    'avatar-model:update-thumbnail',
    async (_event, payload: { modelId: string; thumbnailDataUrl: string }) => {
      if (!avatarModels) {
        throw new Error('Avatar model service is unavailable.');
      }

      return avatarModels.updateThumbnail(payload.modelId, payload.thumbnailDataUrl);
    },
  );
  handleIpc(
    'avatar-model:update-description',
    async (_event, payload: { modelId: string; description: string }) => {
      if (!avatarModels) {
        throw new Error('Avatar model service is unavailable.');
      }

      return avatarModels.updateDescription(payload.modelId, payload.description);
    },
  );
  handleIpc(
    'avatar-model:generate-description',
    async (_event, payload: { thumbnailDataUrl: string }) => {
      if (!avatarDescriptionService) {
        await refreshAvatarDescriptionService(manager);
      }
      if (!avatarDescriptionService) {
        throw new Error('Describe the avatar has no model to use. Pick one in Models and servers → Describe the avatar (or add the OpenAI API key if it runs on OpenAI).');
      }

      const service = avatarDescriptionService;
      return withVision(manager, 'describe', () => service.generateDescription(payload.thumbnailDataUrl));
    },
  );
  handleIpc('avatar-animation:list', async () => {
    if (!avatarAnimations) {
      return [] as AvatarAnimationSummary[];
    }

    return avatarAnimations.listAnimations();
  });
  handleIpc('avatar-animation:upload', async (_event, payload: AvatarAnimationUploadRequest) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    return avatarAnimations.uploadAnimation(payload) as Promise<AvatarAnimationUploadResult>;
  });
  handleIpc('avatar-animation:generate', async (_event, payload: AvatarAnimationGenerationRequest) => {
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
  const motionStreamControllers = new Map<string, AbortController>();
  handleIpc('avatar-motion:status', async (): Promise<AvatarMotionStatus> => {
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
  handleIpc('avatar-motion:stream', async (event, payload: AvatarMotionStreamRequest) => {
    if (!localMotionService || !localMotionServer(manager)) {
      throw new Error('Local motion service is unavailable.');
    }

    const sender = event.sender;
    const controller = new AbortController();
    motionStreamControllers.set(payload.streamId, controller);
    try {
      return await localMotionService.streamMotion(
        payload,
        (chunk) => {
          if (!sender.isDestroyed()) {
            sender.send('avatar-motion:chunk', chunk);
          }
        },
        { signal: controller.signal },
      );
    } finally {
      motionStreamControllers.delete(payload.streamId);
    }
  });
  handleIpc('avatar-motion:cancel', (_event, streamId: unknown) => {
    if (typeof streamId === 'string') {
      motionStreamControllers.get(streamId)?.abort();
    }
  });
  handleIpc('avatars:list', () => avatarRegistry?.list() ?? []);
  // Places: who is where. The renderer follows the snapshot, asks avatars to walk to another place and confirms arrivals.
  handleIpc('places:snapshot', () => requirePlaces().snapshot());
  handleIpc('places:move', (_event, avatarId: unknown, placeRef: unknown, reason: unknown) => {
    const places = requirePlaces();
    if (typeof avatarId !== 'string' || !avatarId || typeof placeRef !== 'string' || !placeRef.trim()) {
      return { ok: false, reason: 'invalid request' };
    }
    const place = places.resolvePlace(placeRef);
    if (!place) return { ok: false, reason: 'unknown place' };
    const result = places.startMove(avatarId, place.id, reason === 'called' ? 'called' : 'chose to');
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  });
  handleIpc('places:arrived', (_event, avatarId: unknown) => {
    if (typeof avatarId === 'string' && avatarId) requirePlaces().arrived(avatarId);
  });
  // The talk key with nobody in the room: call someone over (the recent partner, else Echo, else the first avatar).
  // The same rule for bija's own window and for a desktop room; the answer says who is coming.
  handleIpc('places:summon', (event) => {
    const placeId = placeOf(event);
    return callToPlace(
      requirePlaces(),
      placeId,
      floorFor(placeId)?.recentPartner() ?? null,
      (avatarRegistry?.list() ?? []).map((profile) => ({ id: profile.id, name: profile.name })),
    );
  });
  // Settings > Places: desktop rooms (pairing, who is connected, rename, revoke).
  const requireRoomHub = (): RoomHub => {
    if (!roomHub) throw new Error('Desktop rooms are not available yet.');
    return roomHub;
  };
  handleIpc('room-hub:status', () => roomHubStatus(requireRoomHub()));
  handleIpc('room-hub:start-pairing', (_event, placeName: unknown) => requireRoomHub().startPairing(typeof placeName === 'string' ? placeName : undefined));
  handleIpc('room-hub:cancel-pairing', async () => {
    await requireRoomHub().cancelPairing();
  });
  handleIpc('room-hub:revoke', async (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string') return false;
    const place = requireRoomHub().status().devices.find((device) => device.id === deviceId)?.placeId;
    const revoked = await requireRoomHub().revoke(deviceId);
    if (revoked && place) placeDevices?.forget(place);
    return revoked;
  });
  // Which room a desktop room draws (a 3D room id or a background id).
  handleIpc('room-hub:set-room', (_event, placeId: unknown, room: unknown) =>
    typeof placeId === 'string' && typeof room === 'string' ? requirePlaces().setRoom(placeId, room) : false,
  );
  handleIpc('room-hub:rename', (_event, placeId: unknown, name: unknown) =>
    typeof placeId === 'string' && typeof name === 'string' ? requirePlaces().rename(placeId, name) : null,
  );
  handleIpc('avatars:add', (_event, input: unknown) => {
    const registry = requireAvatarRegistry();
    const fields = readAvatarFields(input, true);
    const base = slugifyAvatarName(fields.name ?? '');
    const taken = new Set(registry.list().map((profile) => profile.id));
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base.slice(0, 60)}-${n}`;
    const profile = registry.add({
      id,
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.vrmModelId !== undefined ? { vrmModelId: fields.vrmModelId } : {}),
      ...(fields.prompt ? { prompt: fields.prompt } : {}),
    });
    startAvatarPlumbing(profile, manager);
    return profile;
  });
  handleIpc('avatars:update', (_event, id: unknown, changes: unknown) => {
    const registry = requireAvatarRegistry();
    if (typeof id !== 'string' || !id) throw new Error('Avatar id is required.');
    return registry.update(id, readAvatarFields(changes, false));
  });
  // What the idle director needs for the avatars other than Echo: their personality and idle habits, as saved.
  handleIpc('avatars:idle-personas', () => {
    const personas: Record<string, { personality: string; habits: string }> = {};
    for (const profile of avatarRegistry?.list() ?? []) {
      if (profile.id === DEFAULT_AVATAR_ID) continue;
      const habitsKey = characterIdleHabitsKey(profile.id);
      personas[profile.id] = {
        personality: avatarPersona(profile.id).persona ?? '',
        habits: habitsKey && memoryStore ? normalizeIdleHabits(memoryStore.getValue(habitsKey)) : '',
      };
    }
    return personas;
  });
  // Each place keeps its own: an avatar's prompt uses the instructions of the place it stands in.
  handleIpc('avatars:set-tag-instructions', (event, instructions: unknown) => {
    avatarTagInstructionsByPlace.set(placeOf(event), readTagInstructions(instructions));
  });
  handleIpc('avatars:remove', (_event, id: unknown) => {
    const registry = requireAvatarRegistry();
    if (typeof id !== 'string' || !id) throw new Error('Avatar id is required.');
    if (id === DEFAULT_AVATAR_ID) throw new Error('Echo cannot be removed.');
    registry.remove(id);
    avatarPlumbing.get(id)?.inbox.stop();
    avatarPlumbing.delete(id);
    voiceServices?.delete(id);
    // Its own voice and idle habits go with it, so a later avatar with the same id starts clean.
    // Settings saved under a library character's VRM model id stay: that character is still in the library.
    for (const key of avatarOnlyKeys(id, SPEAKING_ENGINES)) memoryStore?.deleteValue(key);
  });
  handleIpc('local-voice:status', async () => {
    if (!localVoiceService) {
      throw new Error('Local voice service is unavailable.');
    }
    return localVoiceService.status();
  });
  handleIpc('local-voice:transcribe', async (_event, audio: ArrayBuffer | Uint8Array) => {
    if (!localVoiceService) {
      throw new Error('Local voice service is unavailable.');
    }
    const wav = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    return localVoiceService.transcribe(wav);
  });
  handleIpc('local-voice:respond', async (event, request: LocalVoiceRespondRequest) => {
    let payload = request;
    // The caller's place: a desktop room's turns are decided among the avatars there, by that place's floor.
    const placeId = placeOf(event);
    const isLocalPlace = placeId === (placeManager?.localPlaceId() ?? HOME_PLACE_ID);
    const floor = floorFor(placeId);
    const voiceService = getVoiceService(avatarIdArg(payload?.avatarId));
    if (!voiceService) {
      throw new Error('Local voice service is unavailable.');
    }
    if (!payload || typeof payload.requestId !== 'string' || typeof payload.text !== 'string') {
      throw new Error('Invalid local voice request payload received.');
    }
    const avatarId = voiceService.avatarId;

    // Kevin's own speech or typing (not a system update or a preview): the coder model gives way to it.
    const ownTurn = !payload.system && !payload.preview;
    if (ownTurn) codingService?.noteActivity();
    const sender = event.sender;
    // The coder model has Echo's place: the tasks are paused and Echo's model is coming back. Say so, and wait for it.
    if (ownTurn && codingService?.swapReclaiming()) {
      const message = 'Hang on, I’m busy, be with you in a sec…';
      const send = (voiceEvent: LocalVoiceEvent) => {
        if (!sender.isDestroyed()) sender.send('local-voice:event', tagEvent(voiceEvent, avatarId));
      };
      if (!sender.isDestroyed()) sender.send('coding:busy', { busy: true, message });
      try {
        await voiceService.speakOnly(payload.requestId, message, send);
        await codingService.waitForEcho(15 * 60_000);
      } finally {
        if (!sender.isDestroyed()) sender.send('coding:busy', { busy: false });
      }
    }
    if (!payload.preview && !payload.system && avatarId === DEFAULT_AVATAR_ID && payload.instructions?.trim()) {
      lastEchoInstructions.set(placeId, payload.instructions);
    }
    // Places: an avatar that is somewhere else walks in first, then answers.
    let turnService = voiceService;
    let turnAvatarId = avatarId;
    const places = placeManager;
    const scoped = places ? scopedPlaces(places, placeId) : null;
    if (places && scoped && floor && ownTurn) {
      if (isLocalPlace) floorSender = sender;
      const named = payload.avatarId?.trim() ? avatarId : null;
      let callId: string | null = null;
      if (named && !scoped.isPresent(named)) {
        callId = named;
      } else if (!named && places.avatarsAt(placeId).length === 0) {
        // Nobody is here: call the avatar Kevin last talked with, else Echo, else the first one.
        callId = chooseSummon(floor.recentPartner(), (avatarRegistry?.list() ?? []).map((profile) => profile.id));
      }
      if (callId) {
        const came = await summon(scoped, callId, 'summoned');
        if (!came) {
          const name = avatarRegistry?.get(callId)?.name ?? callId;
          if (!sender.isDestroyed()) {
            sender.send('local-voice:event', tagEvent({ requestId: payload.requestId, type: 'error', message: `${name} did not come over.` }, callId));
          }
          return tagResult({ requestId: payload.requestId, text: '', cancelled: true }, callId);
        }
        // Kevin named nobody: the avatar that came answers (alone, so there is nothing for the floor to decide).
        if (!named) {
          const summoned = getVoiceService(callId);
          if (!summoned) throw new Error('Local voice service is unavailable.');
          turnService = summoned;
          turnAvatarId = callId;
          payload = { ...payload, avatarId: callId };
        }
      }
    }
    // Several avatars here, or some away, and Kevin named none: the floor manager decides who answers.
    if (floor && ownTurn && !payload.avatarId?.trim() && (floor.isMulti() || floor.hasAway())) {
      if (isLocalPlace) floorSender = sender;
      return floor.respondToPerson(payload);
    }
    const result = await runVoiceTurn(sender, payload, turnService, placeId);
    // Kevin named an avatar directly: the others in the scene overhear the exchange.
    if (floor && ownTurn && payload.avatarId?.trim() && floor.isMulti() && !result.cancelled && result.text.trim()) {
      floor.heard('person', payload.text, turnAvatarId);
      floor.heard(turnAvatarId, result.text);
    }
    return result;
  });
  handleIpc('presence:update', (event, payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    // A desktop room reports its own presence; bija's is left alone.
    const from = placeOf(event);
    if (from !== (placeManager?.localPlaceId() ?? HOME_PLACE_ID)) {
      placePresence.update(from, p);
      return true;
    }
    presence.update({
      listening: typeof p.listening === 'boolean' ? p.listening : undefined,
      voicePhase: isVoicePhase(p.voicePhase) ? p.voicePhase : undefined,
      faceSeenAt: typeof p.faceSeenAt === 'number' ? p.faceSeenAt : undefined,
      lastUserSpeechAt: typeof p.userSpokeAt === 'number' ? p.userSpokeAt : undefined,
      lastAssistantSpokeAt: typeof p.assistantSpokeAt === 'number' ? p.assistantSpokeAt : undefined,
    });
    return true;
  });
  // Kevin started speaking over the avatars: cancel what they say and drop what waits.
  handleIpc('floor:interrupt', (event) => {
    floors.get(placeOf(event))?.interrupt();
  });
  handleIpc('floor:get-hear-chatter', () => floor?.hearChatter() ?? false);
  handleIpc('floor:set-hear-chatter', (_event, enabled: unknown) => floor?.setHearChatter(enabled === true) ?? false);
  handleIpc('presence:get-dnd', () => presence.doNotDisturb);
  handleIpc('presence:set-dnd', (_event, enabled: unknown) => {
    presence.update({ doNotDisturb: enabled === true });
    return presence.doNotDisturb;
  });
  handleIpc('local-voice:cancel', (_event, requestId?: string, avatarId?: unknown) => {
    getVoiceService(avatarIdArg(avatarId))?.cancel(typeof requestId === 'string' ? requestId : undefined);
    return true;
  });
  handleIpc('switchboard:status', async () => ({
    enabled: switchboardClient !== null,
    connected: switchboardBus?.connected() === true,
    url: switchboardClient ? process.env.SWITCHBOARD_URL?.trim() || 'http://127.0.0.1:8196' : null,
    openTxns: ((await switchboardClient?.openTxns(20)) ?? null)?.map((t) => ({ id: t.id, title: t.title ?? null, state: t.state, opened_by: t.opened_by ?? null, owner: t.owner ?? null, updated_at: t.updated_at ?? null })) ?? null,
    decisions: decisionLog.recent().map((decision) => ({ ...decision, avatarName: avatarRegistry?.get(decision.avatarId)?.name ?? decision.avatarId })),
  }));
  handleIpc('local-voice:system-status', (_event, avatarId?: unknown) =>
    getVoiceService(avatarIdArg(avatarId))?.systemStatus() ?? { pending: 0, ready: false, texts: [], urgent: false },
  );
  handleIpc('local-voice:reset', (_event, avatarId?: unknown) => {
    getVoiceService(avatarIdArg(avatarId))?.resetHistory();
    return true;
  });
  handleIpc('avatar-animation:delete', async (_event, animationId: string) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    await avatarAnimations.deleteAnimation(animationId);
    return true;
  });
  handleIpc('avatar-animation:rename', async (_event, animationId: string, newName: string) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    return avatarAnimations.renameAnimation(animationId, newName);
  });
  handleIpc('avatar-animation:load', async (_event, animationId: string) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    return avatarAnimations.loadAnimationBinary(animationId);
  });
  handleIpc('avatar-pose:list', async () => {
    if (!avatarPoses) {
      return [] as AvatarPoseSummary[];
    }

    return avatarPoses.listPoses();
  });
  handleIpc('avatar-pose:upload', async (_event, payload: AvatarPoseUploadRequest) => {
    if (!avatarPoses) {
      throw new Error('Avatar pose service is unavailable.');
    }

    return avatarPoses.uploadPose(payload);
  });
  handleIpc('avatar-pose:generate', async (_event, payload: AvatarPoseGenerationRequest) => {
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
  handleIpc('avatar-pose:delete', async (_event, poseId: string) => {
    if (!avatarPoses) {
      throw new Error('Avatar pose service is unavailable.');
    }

    await avatarPoses.deletePose(poseId);
    return true;
  });
  handleIpc('avatar-pose:load', async (_event, poseId: string) => {
    if (!avatarPoses) {
      throw new Error('Avatar pose service is unavailable.');
    }

    return avatarPoses.loadPose(poseId);
  });
  handleIpc('avatar-pose:evaluate', async (_event, payload: PoseEvaluationRequest) => {
    if (!poseEvaluationService) {
      await refreshPoseEvaluationService(manager);
    }
    if (!poseEvaluationService) {
      throw new Error('Check poses has no model to use. Pick one in Models and servers (or add the OpenAI API key if it runs on OpenAI).');
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

    const evaluator = poseEvaluationService;
    return withVision(manager, 'posecheck', () =>
      evaluator.evaluatePose({
        ...payload,
        poseData,
        bones,
        boneHierarchy,
        modelDescription,
      }),
    );
  });
  handleIpc('avatar-pose:refine', async (_event, payload: PoseEvaluationRequest) => {
    if (!poseEvaluationService) {
      await refreshPoseEvaluationService(manager);
    }
    if (!poseEvaluationService) {
      throw new Error('Check poses has no model to use. Pick one in Models and servers (or add the OpenAI API key if it runs on OpenAI).');
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

    const evaluator = poseEvaluationService;
    return withVision(manager, 'posecheck', () =>
      evaluator.refinePose({
        ...payload,
        poseData,
        bones,
        boneHierarchy,
        modelDescription,
      }),
    );
  });
  handleIpc('avatar:trigger-behavior', async (_event, cue: string) => {
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
  handleIpc('camera:emit-detection', async (_event, payload: CameraDetectionEventPayload) => {
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

  // Quit handler
  handleIpc('app:quit', () => {
    logger.info('Quit requested via IPC');
    app.quit();
  });

  // Hibernate handler
  handleIpc('app:hibernate', async (): Promise<void> => {
    logger.info('Hibernate requested via IPC');
    
    if (!serverManager) {
      throw new Error('Server manager not initialized');
    }

    // Stop all servers first
    try {
      await serverManager.hibernate();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to hibernate servers', { message });
    }

    // Request Windows hibernation
    if (process.platform === 'win32') {
      try {
        const { spawnSync } = await import('node:child_process');
        spawnSync('shutdown', ['/h'], { stdio: 'ignore', windowsHide: true });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to initiate hibernation', { message });
        throw new Error(`Failed to initiate hibernation: ${message}`);
      }
    } else {
      logger.warn('Hibernate is Windows-only');
      throw new Error('Hibernate is only supported on Windows');
    }
  });

  // Avatar voice preferences
  const voiceEngine = (engine: unknown): SpeakingEngineId | 'openai' =>
    typeof engine === 'string' && (SPEAKING_ENGINES as readonly string[]).includes(engine) ? (engine as SpeakingEngineId) : 'openai';

  // Without an engine: the OpenAI voice (the Realtime conversation engine's), as before.
  handleIpc('avatar:voice:get-preference', (_event, engine?: unknown, avatarId?: unknown) => {
    if (!memoryStore) {
      logger.warn('Memory store unavailable for avatar voice preference');
      return null;
    }
    const key = characterVoiceKey(voiceEngine(engine), settingsAvatarArg(avatarId));
    return key ? memoryStore.getValue(key) : null;
  });

  handleIpc('avatar:voice:set-preference', (_event, voice: unknown, engine?: unknown, avatarId?: unknown) => {
    // An empty voice for an engine clears the character's pick (back to the engine's default).
    if (typeof voice !== 'string' || (!voice && engine === undefined)) {
      logger.warn('Invalid voice preference:', voice);
      return;
    }
    if (!memoryStore) {
      logger.warn('Memory store unavailable for avatar voice preference');
      return;
    }
    const key = characterVoiceKey(voiceEngine(engine), settingsAvatarArg(avatarId));
    if (!key) {
      logger.warn('No active avatar model to set voice preference');
      return;
    }
    memoryStore.setValue(key, voice);
    logger.info('Avatar voice preference saved', { key, voice });
  });

  // Per-character personality prompt. Null means the character has none of its own yet, so the
  // renderer falls back to the global prompt (what every character used before this existed).
  handleIpc('avatar:prompt:get-preference', (_event, avatarId?: unknown) => {
    const key = characterPromptKey(settingsAvatarArg(avatarId));
    if (!key || !memoryStore) return null;
    const stored = memoryStore.getValue(key);
    return typeof stored === 'string' && stored.length > 0 ? stored : null;
  });

  handleIpc('avatar:prompt:set-preference', (_event, prompt: unknown, avatarId?: unknown) => {
    if (typeof prompt !== 'string') {
      logger.warn('Invalid personality prompt');
      return;
    }
    const key = characterPromptKey(settingsAvatarArg(avatarId));
    if (!key || !memoryStore) {
      logger.warn('No active avatar model to save the personality prompt for');
      return;
    }
    memoryStore.setValue(key, prompt.trim());
    logger.info('Avatar personality prompt saved', { key, length: prompt.trim().length });
    // A prompt saved for the character's own body replaces the profile's fallback prompt, so the
    // text shown in the Characters pop-up and the text used for its turns are always the same one.
    const named = settingsAvatarArg(avatarId) ?? avatarRegistry?.activeAvatarId();
    if (named && named !== DEFAULT_AVATAR_ID && avatarRegistry?.get(named)?.prompt) {
      avatarRegistry.update(named, { prompt: '' });
    }
  });

  handleIpc('avatar:idle-habits:get', (_event, avatarId?: unknown) => {
    const key = characterIdleHabitsKey(settingsAvatarArg(avatarId));
    if (!key || !memoryStore) return '';
    return normalizeIdleHabits(memoryStore.getValue(key));
  });

  handleIpc('avatar:idle-habits:set', (_event, habits: unknown, avatarId?: unknown) => {
    if (typeof habits !== 'string') {
      logger.warn('Invalid idle habits');
      return;
    }
    const key = characterIdleHabitsKey(settingsAvatarArg(avatarId));
    if (!key || !memoryStore) {
      logger.warn('No active avatar model to save idle habits for');
      return;
    }
    const saved = normalizeIdleHabits(habits);
    memoryStore.setValue(key, saved);
    logger.info('Avatar idle habits saved', { key, length: saved.length, max: MAX_IDLE_HABITS_LENGTH });
  });

  handleIpc('local-voice:voice-options', (_event, avatarId?: unknown) => speakingVoiceOptions(manager, settingsAvatarArg(avatarId)));

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

const satelliteLogger = {
  debug: (message?: unknown, meta?: unknown) => logger.debug(String(message), meta),
  info: (message?: unknown, meta?: unknown) => logger.info(String(message), meta),
  warn: (message?: unknown, meta?: unknown) => logger.warn(String(message), meta),
};

/** Starts this PC as a satellite: pairing, the link to bija, the asset cache, and the window. */
async function startSatelliteMode(settings: SatelliteSettingsStore): Promise<void> {
  const runtime = new Satellite({
    settings,
    tokens: new KeychainTokenStore(async () => (await import('keytar')).default),
    cacheDir: path.join(app.getPath('userData'), 'cache', 'assets'),
    appVersion: app.getVersion(),
    hostname: os.hostname(),
    getWindow: () => mainWindow,
    quit: () => app.quit(),
    pushToTalk,
    logger: satelliteLogger,
  });
  satellite = runtime;
  // The privacy gate: the mic is live only while an avatar is here, the screen is unlocked, the link is up, the
  // room is open and no other app is full screen. It lives here, in the main process, and fails closed.
  const startIcon = stateIcon('off');
  const tray = new Tray(nativeImage.createFromBitmap(toBgra(startIcon.data), { width: startIcon.width, height: startIcon.height, scaleFactor: 2 }));
  const devices = new DeviceRuntime({
    settings,
    powerMonitor,
    globalShortcut,
    session: session.defaultSession,
    getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    sendOp: (op) => runtime.sendOp(op),
    tray,
    makeImage: (icon) => nativeImage.createFromBitmap(toBgra(icon.data), { width: icon.width, height: icon.height, scaleFactor: 2 }),
    makeMenu: (template) => Menu.buildFromTemplate(template),
    makeWatcher: (onChange) => new FullscreenWatcher({ onChange, logger: satelliteLogger }),
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    placeName: () => runtime.status().placeName,
    avatarName: (avatarId) => runtime.avatarName(avatarId),
    showWindow: () => focusExistingWindow(),
    quit: () => app.quit(),
    logger: satelliteLogger,
  });
  satelliteDevices = devices;
  runtime.attachDevices(devices);
  devices.start();
  await runtime.start(ipcMain, protocol);
  logger.info('Running as a satellite PC.', { hub: settings.get().hubUrl });
  let window: BrowserWindow;
  try {
    window = createWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown renderer bootstrap error occurred while creating the window.';
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
  if (satelliteMode && satelliteSettings) {
    // No services, models, speech, memory or hub: just the window, the link to bija and the room files.
    await startSatelliteMode(satelliteSettings);
    return;
  }
  // Initialize server manager for hibernation support
  // pnpm dev:run writes a pid file for each server it starts (.dev-home/logs); the app writes its
  // own for llama-server restarts and ComfyUI (<userData>/logs).
  serverManager = new ServerManager({
    logger,
    pidDirectories: [path.resolve(__dirname, '../../..', '.dev-home', 'logs'), path.join(app.getPath('userData'), 'logs')],
  });
  logger.info('ServerManager initialized');

  // Register for system suspend/resume notifications
  if (process.platform === 'win32') {
    // Windows: Use powerMonitor (cross-platform) with native fallback
    powerMonitor.on('suspend', async () => {
      logger.info('System suspend detected');
      await serverManager?.suspend().catch((error) => {
        logger.warn('Failed to suspend servers', { message: error instanceof Error ? error.message : String(error) });
      });
    });

    powerMonitor.on('resume', async () => {
      logger.info('System resume detected');
      await serverManager?.resume().catch((error) => {
        logger.warn('Failed to resume servers', { message: error instanceof Error ? error.message : String(error) });
      });
    });

    logger.info('System suspend/resume handlers registered');
  } else {
    logger.info('Suspend/resume handlers not available on this platform');
  }

  const manager = new ConfigManager({
    secretStore,
    preferencesStore: new FilePreferencesStore(path.join(app.getPath('userData'), 'preferences.json')),
    logger,
    openAIClientFactory: getOpenAIClient,
    repoRoot: path.resolve(__dirname, '../../..'),
  });

  if (!switchboardBus) {
    if (process.env.SWITCHBOARD_ENABLED !== '0') {
      switchboardClient = new SwitchboardClient({ baseUrl: process.env.SWITCHBOARD_URL?.trim() || 'http://127.0.0.1:8196', logger });
      switchboardBus = switchboardClient;
    } else {
      switchboardBus = new LocalOnlyBus(makeEventId);
    }
  }

  try {
    memoryStore = new MemoryStore({ filePath: path.join(app.getPath('userData'), 'memory.db') });
    presence.hydrate();
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
    const registryModels = avatarModelService;
    avatarRegistry = new AvatarRegistry({
      store: memoryStore,
      activeVrmModelId: () => registryModels.getActiveModel?.()?.id ?? null,
    });
    avatarSettingsKeys = new AvatarSettingsKeys(avatarRegistry);
    const registry = avatarRegistry;
    const floorStore = memoryStore;
    const places = new PlaceManager({ store: memoryStore, registry, bus: () => switchboardBus, logger });
    placeManager = places;
    places.onChanged((snapshot) => broadcastToWindows('places:changed', snapshot));
    // Desktop rooms: a second PC that draws one place. The hub only listens when a PC is paired or a code is active.
    const hub = new RoomHub({
      registry: new RoomDeviceRegistry(path.join(app.getPath('userData'), 'room-devices.json')),
      places,
      tailscale: createTailscaleLookup(),
      assetRoot: path.join(app.getPath('userData'), 'rooms', ASSET_FOLDER),
      appVersion: app.getVersion(),
      avatars: () => registry.list(),
      settings: () => ({ wakeWord: manager.getRendererConfig().wakeWord ?? null, pushToTalk: pushToTalk.getStatus() }),
      bus: () => switchboardBus,
      onSatelliteMessage: (from, op) => {
        if (op.op === 'presence' || op.op === 'wake.heard') placePresence.onSatelliteOp(from.placeId, op);
        else placeDevices?.onMessage(from.placeId, op);
      },
      logger,
    });
    roomHub = hub;
    const pushHubStatus = () => broadcastToWindows('room-hub:changed', roomHubStatus(hub));
    placeDevices = new PlaceDevices({
      places,
      presence: placePresence,
      bus: () => switchboardBus,
      onChanged: pushHubStatus,
      logger,
    });
    hub.onChanged(pushHubStatus);
    places.settleOffline();
    void hub.start().catch((error) => logger.warn('Room hub failed to start', { message: error instanceof Error ? error.message : String(error) }));
    // One floor per place: the scene is the avatars at that place, and what the floor starts (answers, chatter)
    // is delivered where that place is drawn (this window, or a satellite's link).
    makeFloor = (placeId) => new FloorController({
      registry,
      places: scopedPlaces(places, placeId),
      // Kevin's line picked an avatar that is somewhere else: it walks in, and its turn waits for it.
      summon: (avatarId, reason) => summon(scopedPlaces(places, placeId), avatarId, reason),
      reportError: (avatarId, requestId, message) => {
        const sink = sinkFor(placeId);
        if (sink && !sink.isDestroyed()) sink.send('local-voice:event', tagEvent({ requestId, type: 'error', message }, avatarId));
      },
      store: floorStore,
      voice: (avatarId) => getVoiceService(avatarId),
      runPersonTurn: (avatarId, request) => {
        const voiceService = getVoiceService(avatarId);
        const sink = sinkFor(placeId);
        if (!voiceService || !sink) throw new Error('Local voice service is unavailable.');
        return runVoiceTurn(sink, request, voiceService, placeId);
      },
      emitChatter: (chatterAvatarId, voiceEvent) => {
        const sink = sinkFor(placeId);
        if (sink && !sink.isDestroyed()) sink.send('local-voice:event', tagEvent(voiceEvent, chatterAvatarId));
      },
      saveLine: (line) =>
        conversationManager?.appendToRecentSession([{ role: 'assistant', content: line.content, speaker: line.speaker, ts: line.ts }]),
      instructionsFor: (avatarId) => withPlacesNote(avatarInstructions(avatarId, undefined, placeId), false, placeId),
      bus: () => switchboardBus,
      // Quick decisions (Laya) answer first; the clients are built per call so a changed route applies at once.
      // When the route is off or fails, bids go to the Idle thoughts model and the addressee check (avatar lines only) is skipped.
      addressee: (input, signal) => {
        const client = createSystemOne({ routing: manager.getConfig().models, keyFor: (id) => manager.getServerKey(id), logger });
        if (!client) return Promise.reject(new Error('Quick decisions are off'));
        return createSystemOneAddressee(client, (id) => registry.get(id)?.name ?? id)(input, signal);
      },
      // Kevin's lines go to the fine-tuned quick model first (the decide route must serve the floor checkpoint, e.g. laya-floor-v1);
      // when it is unsure or fails the Idle thoughts chat model reads the line, then the recent partner or the host.
      quickIntent: (input, signal) => {
        // The floor asks for its own checkpoint on the decide route's servers (FLOOR_INTENT_MODEL, default laya-floor-v1),
        // so bids, the addressee check and the inbox step stay on whatever model the decide route names. A server without that
        // checkpoint fails fast and the chat model decides.
        const routing = manager.getConfig().models;
        const decide = routing.routes.decide;
        const model = process.env.FLOOR_INTENT_MODEL?.trim() || 'laya-floor-v1';
        const floorRouting = {
          ...routing,
          routes: { ...routing.routes, decide: { ...decide, model, backups: decide.backups?.map((backup) => ({ ...backup, model })) } },
        };
        const client = createSystemOne({ routing: floorRouting, keyFor: (id) => manager.getServerKey(id), logger });
        if (!client) return Promise.reject(new Error('Quick decisions are off'));
        return createSystemOneIntent(client, (id) => registry.get(id)?.name ?? id)(input, signal);
      },
      intent: createIntentRouter({
        routing: () => manager.getConfig().models,
        keyFor: (id) => manager.getServerKey(id),
        nameOf: (id) => registry.get(id)?.name ?? id,
        logger,
      }),
      bid: async (candidates, recentLines, signal) => {
        const nameOfSpeaker = (from: string) => (from.startsWith('avatar:') ? (registry.get(from.slice('avatar:'.length))?.name ?? from) : 'Kevin');
        const client = createSystemOne({ routing: manager.getConfig().models, keyFor: (id) => manager.getServerKey(id), logger });
        if (client) {
          try {
            return await createSystemOneBid(client, nameOfSpeaker)(candidates, recentLines, signal);
          } catch (error) {
            logger.warn('Quick-decision bids failed; asking the Idle thoughts model.', { message: error instanceof Error ? error.message : String(error) });
          }
        }
        return createModelBid({
          routing: () => manager.getConfig().models,
          keyFor: (id) => manager.getServerKey(id),
          nameOfSpeaker,
          logger,
        })(candidates, recentLines, signal);
      },
      logger,
    });
    floor = floorFor(places.localPlaceId());
    const agentStore = memoryStore;
    memoryEngine = setupMemoryEngine({
      settings: memoryEngineSettings(),
      store: memoryStore,
      conversations: conversationManager,
      agentFor: (avatarId) => avatarAgent(agentStore, registry, avatarId),
      logger,
    });
    // One mirror and inbox for each avatar (just Echo for now).
    for (const profile of avatarRegistry.peek()) startAvatarPlumbing(profile, manager);
    // The proactive tick: Echo may greet Kevin or mention quiet saves, when Laya says the moment is right.
    proactiveTick?.stop();
    proactiveTick = new ProactiveTick({
      ...proactiveSettingsFromEnv(process.env),
      presence,
      makeClient: () => createSystemOne({ routing: manager.getConfig().models, keyFor: (id) => manager.getServerKey(id), logger }),
      notify: (text, options) => getVoiceService(DEFAULT_AVATAR_ID)?.notify(text, options),
      avatarName: () => avatarRegistry?.get(DEFAULT_AVATAR_ID)?.name ?? 'Echo',
      bus: () => switchboardBus,
      logger,
    });
    proactiveTick.start();
    // Provider settings may have been applied before the engine existed.
    syncMemoryStorage();

    // Initialize MCP tool registry and manager
    toolRegistry = new ToolRegistry();
    approvalBroker = new ApprovalBroker({ registry: toolRegistry, avatarId: DEFAULT_AVATAR_ID, logger });
    approvalBroker.on('outcome', (outcome) => codingNudger?.handleApproval(outcome));
    approvalBroker.on('outcome', (outcome: ApprovalOutcome) => mirrorFor(avatarIdOfAddress(outcome.approval.requestedBy))?.approvalOutcome(outcome));
    // 'changed' lists everything pending; only ids not seen before are new requests.
    approvalBroker.on('changed', (pending: PendingApproval[]) => {
      for (const approval of pending) {
        if (seenApprovalIds.has(approval.id)) continue;
        seenApprovalIds.add(approval.id);
        mirrorFor(avatarIdOfAddress(approval.requestedBy))?.approvalRequested(approval);
      }
    });
    if (memoryEngine) {
      const store = memoryStore;
      const conversations = conversationManager;
      for (const tool of createMemoryTools({
        client: memoryEngine.client,
        outbox: memoryEngine.outbox,
        currentSessionId: () => conversations.getCurrentSessionId(),
        agentName: () => avatarAgent(store, avatarRegistry).name,
        modelName: () => conversationModelName(),
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
    roomService = new RoomService({
      assetsDirectory: path.join(__dirname, '../assets/rooms'),
      roomsDirectory: path.join(app.getPath('userData'), 'rooms'),
    });
    registerAssetProtocol(protocol, path.join(app.getPath('userData'), 'rooms', ASSET_FOLDER));
    roomGeneration = createRoomGenerationService({
      userData: app.getPath('userData'),
      routing: () => manager.getConfig().models,
      keyFor: (id) => manager.getServerKey(id),
      appVersion: app.getVersion(),
      logger,
      readSetting: (key) => memoryStore?.getValue(key),
      // Missing objects are made with the avatar studio's image and 3D steps, on the same servers.
      comfy: {
        pick: (stage) => comfyPool.pick(stage),
        imageModel: () => {
          if (!avatarImageModels) throw new Error('Image models are unavailable.');
          return avatarImageModels.resolve();
        },
        geometryModel: () => {
          if (!avatarCharacterModels) throw new Error('3D models are unavailable.');
          return pickSingleImageGeometry(avatarCharacterModels);
        },
      },
      onRoomUpdated: (roomId) => {
        broadcastToWindows('rooms:updated', roomId);
        // A desktop room may be showing that room.
        roomHub?.sendToAll({ op: 'ipc', channel: 'rooms:updated', args: [roomId] });
      },
    });
    backgroundService = new BackgroundService({
      store: memoryStore,
      rooms: roomService,
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
          for (const [, service] of voiceServices?.entries() ?? []) {
            service.cancel();
            service.resetHistory();
          }
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
  codingService?.stop();
  approvalBroker?.dispose();
  proactiveTick?.stop();
  void roomHub?.stop();
  satellite?.stop();
  satelliteDevices?.stop();
  for (const { inbox } of avatarPlumbing.values()) inbox.stop();
  void switchboardClient?.stop();

  // Stop the local servers this app started, as hibernation does.
  if (serverManager) {
    await serverManager.shutdown().catch((error) => {
      logger.warn('Failed to stop servers during shutdown', { message: error instanceof Error ? error.message : String(error) });
    });
  }

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
  homeServerSync?.stop();
  homeServerSync = null;
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
