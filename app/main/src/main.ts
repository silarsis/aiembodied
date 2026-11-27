import { createHandleIpc, type OnIpc } from './ipc/handle-ipc.js';
import { registerConfigIpc } from './config/ipc.js';
import { registerDiagnosticsIpc } from './diagnostics/ipc.js';
import { registerCodingIpc } from './coding/ipc.js';
import { registerModelsIpc } from './models/ipc.js';
import { registerTalkIpc } from './talk/ipc.js';
import { registerWakeWordIpc } from './wake-word/ipc.js';
import { registerConversationIpc } from './conversation/ipc.js';
import { registerMetricsIpc } from './metrics/ipc.js';
import { registerAvatarIpc, type CameraDetectionEventPayload } from './avatar/ipc.js';
import { registerAvatarGenerationIpc } from './avatar/generation/ipc.js';
import { registerAvatarMotionIpc } from './avatar/motion/ipc.js';
import { registerBackgroundsIpc } from './backgrounds/ipc.js';
import { registerFurnitureIpc } from './furniture/ipc.js';
import { registerRoomsIpc } from './rooms/ipc.js';
import { registerPlacesIpc } from './places/ipc.js';
import { registerStationsIpc } from './stations/ipc.js';
import { registerPursuitsIpc } from './pursuits/ipc.js';
import { registerAgentTimeIpc } from './agent-time/ipc.js';
import { registerRoomHubIpc, roomHubStatus } from './room-hub/ipc.js';
import { registerAvatarsIpc } from './avatars/ipc.js';
import { registerAvatarSettingsIpc } from './avatars/settings-ipc.js';
import { registerLocalVoiceIpc } from './local-voice/ipc.js';
import { registerPresenceIpc } from './presence/ipc.js';
import { registerFloorIpc } from './floor/ipc.js';
import { registerSwitchboardIpc } from './switchboard/ipc.js';
import { registerLifecycleIpc } from './lifecycle/ipc.js';
import { BackgroundService } from './backgrounds/background-service.js';
import { FurnitureService } from './furniture/furniture-service.js';
import type { ComfyGraph } from './avatar/generation/comfyui-client.js';
import { RoomService } from './rooms/room-service.js';
import { normalizeIdleHabits } from './shared/rooms/idle-habits.js';
import {
  Menu,
  Notification,
  app,
  BrowserWindow,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
  protocol,
  session,
  shell,
} from 'electron';
import type { WebContents } from 'electron';
import {
  ASSET_SCHEME,
  ASSET_SCHEME_PRIVILEGES,
  registerAssetProtocol,
} from './rooms/asset-protocol.js';
import {
  ASSET_FOLDER,
  createRoomGenerationService,
  pickSingleImageGeometry,
} from './rooms/room-generation-setup.js';
import type { RoomGenerationService } from './rooms/room-generation.js';
import { SwitchboardClient, makeEventId } from './switchboard/client.js';
import { LocalOnlyBus, type SwitchboardBus } from './switchboard/bus.js';
import { AvatarInbox } from './switchboard/inbox.js';
import { DecisionLog } from './switchboard/decisions.js';
import { deliberate } from './switchboard/deliberate.js';
import { deliberateFast } from './switchboard/deliberate-system-one.js';
import { ProactiveTick, proactiveSettingsFromEnv } from './presence/proactive-tick.js';
import { PresenceTracker } from './presence/presence.js';
import { FloorController } from './floor/index.js';
import { HOME_PLACE_ID, PlaceManager, placesNote, scopedPlaces } from './places/place-manager.js';
import { PlacePresence, describePlaceLine } from './presence/place-presence.js';
import { createArrivalGreeting } from './presence/arrival-greeting.js';
import { cameraPresenceOn } from './shared/places/camera-setting.js';
import { createPlaceDelivery, type EventSink } from './places/place-delivery.js';
import { createAppWindow } from './window/app-window.js';
import { Satellite } from './satellite/satellite.js';
import { DeviceRuntime } from './satellite/device-runtime.js';
import { FullscreenWatcher } from './satellite/fullscreen-watch.js';
import { stateIcon, toBgra } from './satellite/tray-state.js';
import { KeychainTokenStore } from './satellite/token-store.js';
import {
  SATELLITE_FILE,
  SatelliteSettingsStore,
  detectSatelliteRole,
  userDataOverride,
} from './satellite/settings.js';
import { RoomHub, fileMarker } from './room-hub/room-hub.js';
import { webRootFor } from './runtime-paths.js';
import { RoomDeviceRegistry } from './room-hub/room-devices.js';
import { createTailscaleLookup } from './room-hub/tailscale.js';
import { summon } from './places/summon.js';
import { createDoorbell, wakeShouldListen } from './places/doorbell.js';
import { CONVERSATION_MS } from './shared/places/wander.js';
import { NextDoorReturn } from './places/next-door-return.js';
import { walkToKevin } from './places/urgent-walk.js';
import { ActivityMonitor } from './shared/presence/activity-monitor.js';
import { SatelliteWakeRunner, type SharedWakeWord } from './satellite/wake-runner.js';
import { PlaceDevices } from './room-hub/place-devices.js';
import { createIntentRouter } from './floor/intent-router.js';
import { createModelBid } from './floor/bid.js';
import { createSystemOne } from './decide/system-one.js';
import {
  createSystemOneAddressee,
  createSystemOneBid,
  createSystemOneIntent,
} from './floor/system-one-floor.js';
import { SwitchboardMirror } from './switchboard/mirror.js';
import { AvatarRegistry, DEFAULT_AVATAR_ID } from './avatars/avatar-registry.js';
import type { AvatarProfile } from './shared/avatars/avatar-registry-types.js';
import { AvatarSettingsKeys } from './avatars/avatar-settings.js';
import { composeAvatarPrompt } from './avatars/tag-instructions.js';
import type { AvatarTagInstructions } from './shared/avatars/bridge-types.js';
import { VoiceServices } from './avatars/voice-services.js';
import { tagEvent, tagResult } from './avatars/speaker.js';
import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ConfigManager, ConfigValidationError } from './config/config-manager.js';
import type { WakeWordConfig } from './shared/config/config-manager-types.js';
import { KeytarSecretStore } from './config/keytar-secret-store.js';
import { InMemorySecretStore } from './config/secret-store.js';
import { FilePreferencesStore } from './config/preferences-store.js';
import { initializeLogger } from './logging/logger.js';
import { MotionTraceSink } from './logging/motion-trace.js';
import { createAppDiagnostics } from './logging/app-diagnostics.js';
import { CrashGuard } from './crash-guard.js';
import { WakeWordService } from './wake-word/wake-word-service.js';
import type { WakeWordDetectionEvent } from './shared/wake-word/types.js';
import { WakeWordListeningController } from './wake-word/listening-controller.js';
import { WakeWordTrainer } from './wake-word/wake-word-trainer.js';
import { resolveOpenWakeWordModelPaths } from './wake-word/open-wake-word.js';
import { ConversationManager } from './conversation/conversation-manager.js';
import type { ConversationMessage, ConversationSession } from './shared/conversation/types.js';
import { MemoryStore } from './memory/index.js';
import { PrometheusCollector } from './metrics/prometheus-collector.js';
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
import {
  AvatarImageModelService,
  createControllerModelScanner,
  createImageModelScanner,
  createRemoteComfyModelScanner,
  type PoseControlInstaller,
} from './avatar/generation/image-model-service.js';
import { POSE_CONTROLNETS, poseControlNetPlan } from './avatar/generation/pose-control.js';
import { resolveComfyInstallation } from './avatar/generation/comfyui-runtime.js';
import { ModelDownloadService } from './avatar/generation/model-downloads.js';
import { AvatarCharacterModelService } from './avatar/generation/character-model-service.js';
import { LocalMotionClient } from './avatar/motion/local-motion-client.js';
import { LocalMotionGenerationService } from './avatar/motion/local-motion-generation-service.js';
import { ServerManager } from './server/server-manager.js';
import { AicontrollerBridge, echoRouteOverride } from './aicontroller/bridge.js';
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
import { describeProviders } from './shared/config/provider-settings.js';
import type {
  LocalVoiceRespondRequest,
  LocalVoiceRespondResult,
} from './shared/local-voice/types.js';
import { getOpenAIClient } from './openai/client.js';
import type OpenAI from 'openai';
import { createChatCompletionsResponsesClient } from './openai/chat-completions-responses.js';
import {
  BUILT_IN_SERVER_IDS,
  routeTargets,
  routeTargetsWithOverride,
  serverUrl,
  isLocalUrl,
  speakingVoiceKey,
  type SpeakingEngineId,
} from './shared/config/model-routing.js';
import { ComfyUIPool } from './avatar/generation/comfyui-pool.js';
import { LocalLlmControl } from './local-voice/local-llm-control.js';
import { CodingService } from './coding/coding-service.js';
import type { CodingView } from './shared/coding/coding-service-types.js';
import { CodingMemoryWriter } from './coding/memory-writer.js';
import { CodingNudger } from './coding/nudger.js';
import { CODING_SERVER_ID, CODING_TOOL_IDS, createCodingTools } from './coding/tools.js';
import { ApprovalBroker, type ApprovalOutcome } from './tools/approvals.js';
import type { PendingApproval } from './shared/tools/approvals-types.js';
import { registerApprovalsIpc } from './tools/approvals-ipc.js';
import { LlmLibrary } from './local-llm/llm-library.js';
import type { LocalLlmSettings } from './shared/local-llm/llm-settings-types.js';
import { VisionModel } from './local-vision/vision-model.js';
import { VisionServer, withVisionServer } from './local-vision/vision-server.js';
import { MCPManager } from './mcp/mcp-manager.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { StationRegistry } from './stations/station-registry.js';
import { StationTrips } from './stations/station-trips.js';
import { PursuitManager } from './pursuits/pursuit-manager.js';
import { LlmGate } from './pursuits/pursuit-llm.js';
import { AgentActHandler } from './agent-time/act-handler.js';
import { AgentSync } from './agent-time/agent-sync.js';
import { AgentSleep } from './agent-time/sleep.js';
import { QuietSaves } from './agent-time/quiet-saves.js';
import { QUESTION_TOOL_ID, withQuestionTool } from './agent-time/ask.js';
import { withTimeNote } from './agent-time/prompt.js';
import { createAgentTimeTools } from './agent-time/tools.js';
import { agentTimeSettingsFromEnv } from './agent-time/settings.js';
import { WorkflowsClient } from './agent-time/workflows-client.js';
import { createReadingNotesTool, readingOutboxItem } from './pursuits/reading-memory.js';
import { StationLookup } from './stations/station-lookup.js';
import { createVoiceStations, type VoiceStations } from './stations/voice-stations.js';
import {
  createRoutedSearchProvider,
  createWebSearchTool,
  WEB_SEARCH_TOOL_ID,
} from './tools/web-search.js';
import { registerMCPHandlers } from './mcp/ipc-handlers.js';
import { GpuMemoryReader } from './diagnostics/gpu-memory.js';
import { PushToTalkShortcut } from './talk/push-to-talk.js';
import type { TalkTriggerEvent } from './shared/talk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = app.isPackaged || process.env.NODE_ENV === 'production';
const APP_NAME = 'AI Embodied Assistant';
const DEFAULT_MODEL_ASSET_PATH = path.join(__dirname, '../assets/vrm-models/default-avatar.vrm');
// Unpacked from the asar in packaged builds (see electron-builder.yml): onnxruntime reads them natively.
const WAKE_WORD_ASSETS_DIRECTORY = path
  .join(__dirname, '../assets/wake-word')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

if (!isProduction) {
  const repoRoot = path.resolve(__dirname, '../../..');
  dotenv.config({ path: path.join(repoRoot, '.env') });
}

// A second copy of the app on one PC (a satellite next to the full app, for testing) needs its own userData folder;
// the single-instance lock below is per userData folder, so the two do not fight over it.
const userDataFolder = userDataOverride(process.env);
if (userDataFolder) app.setPath('userData', userDataFolder);
/** A satellite draws one room of bija's world and runs nothing else (docs/features/satellite.md). */
const SATELLITE_FLAG = '--satellite';
const satelliteMode = detectSatelliteRole(
  process.argv.includes(SATELLITE_FLAG)
    ? { ...process.env, AIEMBODIED_ROLE: 'satellite' }
    : process.env,
  app.getPath('userData'),
);
const satelliteSettings = satelliteMode
  ? new SatelliteSettingsStore(path.join(app.getPath('userData'), SATELLITE_FILE))
  : null;
let satellite: Satellite | null = null;
let satelliteDevices: DeviceRuntime | null = null;
/** The satellite's own wake word worker, run only while its privacy gate allows (satellite/wake-runner.ts). */
let satelliteWake: SatelliteWakeRunner | null = null;
let satelliteActivity: ActivityMonitor | null = null;

const secretStore = isProduction ? new KeytarSecretStore('aiembodied') : new InMemorySecretStore();
const { logger } = initializeLogger();
// Verbose motion/contact trace for analysing sitting problems (AIEMBODIED_MOTION_TRACE=1 or the Status setting).
const motionTrace = new MotionTraceSink({ directory: path.join(app.getPath('userData'), 'logs') });
// Register a preload diagnostics channel as early as possible to catch messages during renderer bootstrap
try {
  ipcMain.on(
    'diagnostics:preload-log',
    (
      _event,
      payload: { level?: string; message?: string; meta?: Record<string, unknown>; ts?: number },
    ) => {
      const level = (typeof payload?.level === 'string' ? payload.level : 'info').toLowerCase();
      const message =
        typeof payload?.message === 'string' ? payload.message : 'preload-diagnostics';
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
      mainWindow.webContents.send('talk:trigger', {
        source: 'shortcut',
        timestamp: Date.now(),
      } satisfies TalkTriggerEvent);
    }
  },
  onStatus: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('talk:shortcut-status', status);
    }
  },
  logger: {
    info: (message: string, meta?: unknown) => logger.info(message, meta),
    warn: (message: string, meta?: unknown) => logger.warn(message, meta),
  },
});
let memoryStore: MemoryStore | null = null;
let conversationManager: ConversationManager | null = null;
let removeConversationListeners: (() => void) | null = null;
let metricsCollector: PrometheusCollector | null = null;
let autoLaunchManager: AutoLaunchManager | null = null;
let developmentTray: Tray | null = null;
let serverManager: ServerManager | null = null;
/**
 * The shared model controller. When it answers (AICONTROLLER_ENABLED, default auto) it runs Echo's
 * language model and the coder: this app leases them instead of starting llama-server.
 */
const aicontroller = new AicontrollerBridge({
  logger,
  // A new lease URL (or none): rebuild Echo's engines.
  onChange: () => (voiceConfigManager ? applyProviderSettings(voiceConfigManager) : undefined),
  // The Thinking model picked in Models and servers, so the controller loads it for Echo's lease.
  echoModel: async () => {
    if (!voiceConfigManager) return undefined;
    const model = await getLocalLlmTools(voiceConfigManager).library.selected();
    return model ? { path: model.path, alias: model.alias } : null;
  },
});
let avatarModelService: AvatarModelService | null = null;
let avatarAnimationService: AvatarAnimationService | null = null;
let avatarPoseService: AvatarPoseService | null = null;
let backgroundService: BackgroundService | null = null;
let furnitureService: FurnitureService | null = null;
let roomService: RoomService | null = null;
let roomGeneration: RoomGenerationService | null = null;
// The scheme that serves downloaded room models must be declared before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: ASSET_SCHEME_PRIVILEGES },
]);
let vrmaGenerationService: VrmaGenerationService | null = null;
let poseGenerationService: PoseGenerationService | null = null;
let poseEvaluationService: PoseEvaluationService | null = null;
let avatarDescriptionService: AvatarDescriptionService | null = null;
let avatarImageModels: AvatarImageModelService | undefined;
let avatarComfyPool: ComfyUIPool | undefined;
/** The ComfyUI add-on folder: its downloader runs for this PC, and other machines install the folder. */
const comfyAddonDirectory = path
  .join(__dirname, '../assets/avatar-generation/comfyui-aiembodied')
  .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const modelDownloads = new ModelDownloadService({
  script: path.join(comfyAddonDirectory, 'aiembodied_downloader.py'),
  resolveInstallation: () => resolveComfyInstallation(),
  // A new SD1.5 or SDXL checkpoint on the image server brings its pose ControlNet with it.
  onFinished: (download, plan, server) => {
    if (download.state !== 'done' || (plan.kind !== 'sd1' && plan.kind !== 'sdxl')) return;
    if (avatarComfyPool?.primary('image')?.id !== server.id) return;
    void avatarImageModels?.ensurePoseControl(plan.kind).catch((error: unknown) => {
      logger.warn('Could not set up pose control for the new model.', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  },
  logger,
});
/** Downloads the pose ControlNets to the image step's first ComfyUI server. */
const poseControlInstaller: PoseControlInstaller = {
  status: (family) => {
    const server = avatarComfyPool?.primary('image');
    const download = server
      ? modelDownloads.find(server.id, POSE_CONTROLNETS[family].filename)
      : undefined;
    if (!download) return null;
    if (download.state === 'done') return { state: 'done' };
    if (download.state === 'failed' || download.state === 'cancelled')
      return { state: 'failed', error: download.error };
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
/** Once a minute, maybe brings an avatar back from next door to where someone is (places/next-door-return.ts). */
let nextDoorReturn: NextDoorReturn | null = null;
/** Polls how long ago anyone used this PC; the answer is what wandering between places goes by (shared/presence/activity-monitor.ts). */
let activityMonitor: ActivityMonitor | null = null;

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

/** How long ago Kevin last talked with the avatar, in any place's floor; null when not lately. */
function talkedAgoMs(avatarId: string): number | null {
  let best: number | null = null;
  for (const placeFloor of floors.values()) {
    const age = placeFloor.talkedAgoMs(avatarId);
    if (age !== null && (best === null || age < best)) best = age;
  }
  return best;
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
function conversationModelName(
  manager: ConfigManager | null = configManagerForMemory,
): string | null {
  const target = manager
    ? routeTargetsWithOverride(manager.getConfig().models, 'llm', codingService?.chatOverride())[0]
    : undefined;
  if (!target) return null;
  if (target.model?.trim()) return target.model.trim();
  return target.server.type === 'openai' ? DEFAULT_OPENAI_MODELS.llm : target.server.name || null;
}

/** Point the memory engine at the database and mirror picked in Models and servers. */
function syncMemoryStorage(manager: ConfigManager | null = configManagerForMemory): void {
  if (!manager || !memoryEngine) return;
  configManagerForMemory = manager;
  memoryStorageSync ??= new MemoryStorageSync({ client: memoryEngine.client, logger });
  void memoryStorageSync.apply(
    memoryStorageTargets(manager.getConfig().models, (id) => manager.getServerKey(id)),
  );
  homeServerSync ??= new HomeServerSync({ client: memoryEngine.client, logger });
  void homeServerSync.apply(
    homeServersFor(manager.getConfig().models, (id) => manager.getServerKey(id)),
  );
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
// Stations: tools that live at an object in a 3D room (stations/). Set up with the rooms; null before that.
let stationRegistry: StationRegistry | null = null;
let stationTrips: StationTrips | null = null;
let voiceStations: VoiceStations | null = null;
// Pursuits: reading sessions an avatar starts on its own (pursuits/). Set up with the stations.
let pursuitManager: PursuitManager | null = null;
// Agent time (agent-time/): the workflows service runs each avatar's life and asks this app to act. Off with WORKFLOWS_ENABLED=0.
const agentTime = agentTimeSettingsFromEnv(process.env);
/** Who is asleep, and what each inbox saved quietly since the avatar spoke. */
const agentSleep = new AgentSleep(logger);
const quietSaves = new QuietSaves();
/** One model call at a time across pursuits and agent thinking, so a conversation always has a slot. */
const agentLlmGate = new LlmGate(1);
let workflowsClient: WorkflowsClient | null = null;
let agentActHandler: AgentActHandler | null = null;
let agentSync: AgentSync | null = null;

function emitCameraDetection(event: CameraDetectionEventPayload): boolean {
  const cue = typeof event.cue === 'string' ? event.cue.trim() : '';
  if (!cue) {
    throw new Error('Camera detection payload must include a cue identifier.');
  }

  const timestamp =
    typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? event.timestamp
      : Date.now();

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
  const window = createAppWindow({
    logger,
    diagnostics,
    baseDir: __dirname,
    isProduction,
    satellite: satelliteSettings ?? undefined,
  });

  window.on('closed', () => {
    void wakeWordListening
      .setEnabled(false)
      .catch((error: unknown) =>
        logger.error('Failed to stop listening after window close', { message: String(error) }),
      );
    mainWindow = null;
  });

  const stopWindowListening = () => {
    void wakeWordListening
      .setEnabled(false)
      .catch((error: unknown) =>
        logger.error('Failed to stop listening after renderer reset', { message: String(error) }),
      );
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
function helperTarget(
  manager: ConfigManager,
  use: 'clips' | 'posegen' | 'posecheck' | 'describe',
): { client: OpenAI; model?: string; signature: string } | null {
  const target = routeTargets(manager.getConfig().models, use)[0];
  if (!target) return null;
  const key = manager.getServerKey(target.server.id)?.trim() ?? '';
  if (target.server.type === 'openai' && !key) return null;
  const signature = `${target.server.url}|${key}|${target.model ?? ''}`;
  // OpenAI gets the SDK; any other chat server gets the same calls over /chat/completions.
  const client =
    target.server.type === 'openai'
      ? getOpenAIClient(key)
      : (createChatCompletionsResponsesClient({
          baseUrl: target.server.url,
          apiKey: key || undefined,
          model: target.model,
        }) as unknown as OpenAI);
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
    if (current)
      logger.warn(
        `${label} disabled: choose a server for it in Models and servers, or add the OpenAI API key.`,
      );
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
    logger.warn(`Failed to initialize ${label.toLowerCase()}`, {
      message: error instanceof Error ? error.message : String(error),
    });
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
  const candidate =
    process.env.WAKE_WORD_TRAINER_DIR?.trim() ||
    path.resolve(__dirname, '../../../services/wakeword-trainer');
  return existsSync(path.join(candidate, 'train_wake_word.py')) ? candidate : null;
}

/** One doorbell per place: the wake word heard while nobody is there calls an avatar over (places/doorbell.ts). */
const doorbells = new Map<string, ReturnType<typeof createDoorbell>>();

function doorbellFor(placeId: string): ReturnType<typeof createDoorbell> | null {
  const places = placeManager;
  if (!places) return null;
  let bell = doorbells.get(placeId);
  if (!bell) {
    bell = createDoorbell({
      places: scopedPlaces(places, placeId),
      placeId,
      partner: () => floorFor(placeId)?.recentPartner() ?? null,
      avatarIds: () => (avatarRegistry?.list() ?? []).map((profile) => profile.id),
      logger,
    });
    doorbells.set(placeId, bell);
  }
  return bell;
}

/**
 * bija's wake word listens while an avatar is at this screen or the doorbell is on. With nobody here and the doorbell
 * off the microphone is released, and it comes back when an avatar arrives. With one place and every avatar home
 * nothing ever closes it.
 */
function syncWakeGate(): void {
  const places = placeManager;
  if (!places) return;
  void wakeWordListening
    .setGate(wakeShouldListen(places, places.localPlaceId()))
    .catch((error: unknown) => {
      logger.warn('Could not change the wake word gate', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Starts the openWakeWord worker (capture begins) and hands its detections to `handlers`. The one place the worker
 * is built, for bija and for a satellite PC alike.
 */
function launchWakeWordService(
  wakeWord: WakeWordConfig,
  handlers: {
    onWake: (event: WakeWordDetectionEvent) => void;
    onPeak?: (event: WakeWordDetectionEvent) => void;
  },
): WakeWordService {
  const service = new WakeWordService({
    logger,
    cooldownMs: wakeWord.cooldownMs,
    minConfidence: wakeWord.threshold,
  });

  service.on('wake', handlers.onWake);
  if (handlers.onPeak) service.on('peak', handlers.onPeak);

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
 * Create capture only after explicit enable; the listening controller serializes replacements.
 */
function startWakeWordService(wakeWord: WakeWordConfig): WakeWordService {
  return launchWakeWordService(wakeWord, {
    onWake: (event) => {
      if (!wakeWordListening.enabled) return;
      logger.info('Wake word detected in main process', {
        keyword: event.keywordLabel,
        confidence: event.confidence,
      });

      // The wake word starts a turn with whoever is here to hear it. With nobody here (the doorbell) it calls an avatar
      // over first, and the turn starts once it has arrived.
      const deliver = () => {
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
      };
      const bell = placeManager ? doorbellFor(placeManager.localPlaceId()) : null;
      if (bell) void bell.onWake(deliver);
      else deliver();
    },
    onPeak: (event) => {
      if (!wakeWordListening.enabled) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wake-word:peak', event);
      }
    },
  });
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

function characterVoice(
  engine: SpeakingEngineId | 'openai' | null,
  avatarId?: string,
): string | null {
  if (!engine || !memoryStore) return null;
  const key = characterVoiceKey(engine, avatarId);
  return key ? (memoryStore.getValue(key) ?? null) : null;
}

/**
 * Point the conversation pipeline and motion at the current provider settings and API key. Runs
 * at startup and after every change on the Settings page, so a change applies without a restart
 * (except the local motion model, which the launcher picks when it starts services/motion).
 */
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
        makeClient: () =>
          createSystemOne({
            routing: manager.getConfig().models,
            keyFor: (id) => manager.getServerKey(id),
            logger,
          }),
        fallback: (e) =>
          deliberate(e, presence, {
            avatarName,
            routing: manager.getConfig().models,
            keyFor: (id) => manager.getServerKey(id),
            logger,
          }),
        avatarName,
        logger,
      });
    },
    onRemembered: (text) => {
      proactiveTick?.noteRemembered(text);
      quietSaves.add(avatarId, text);
    },
    asleep: () => agentSleep.isAsleep(avatarId),
    remember: (_event, text, source) => {
      conversationManager?.appendToRecentSession([
        {
          role: 'system',
          content: `[Update from ${source}, not from Kevin, saved quietly] ${text}`,
          ts: Date.now(),
        },
      ]);
    },
    doNotDisturb: () => presence.doNotDisturb,
    onDecision: (decision) => decisionLog.record(decision),
    // Urgent news walks to where someone is using a PC, when nobody is at this avatar's place (places/urgent-walk.ts).
    beforeUrgent: () =>
      placeManager ? walkToKevin(placeManager, avatarId, undefined, logger) : undefined,
    logger,
  });
  avatarPlumbing.set(avatarId, { mirror, inbox });
  inbox.start();
}

const handleIpc = createHandleIpc(ipcMain);

function requirePlaces(): PlaceManager {
  if (!placeManager) throw new Error('Places are not available yet.');
  return placeManager;
}

/** The avatar's mirror, Echo's when no id is given. */
function mirrorFor(avatarId: string = DEFAULT_AVATAR_ID): SwitchboardMirror | undefined {
  return avatarPlumbing.get(avatarId)?.mirror;
}

/** The avatar a switchboard address such as `avatar:echo` names (Echo for anything else). */
function avatarIdOfAddress(address: string | undefined): string {
  return address?.startsWith('avatar:')
    ? address.slice('avatar:'.length) || DEFAULT_AVATAR_ID
    : DEFAULT_AVATAR_ID;
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
function withPlacesNote(
  instructions: string | undefined,
  preview = false,
  placeId?: string,
): string | undefined {
  if (preview) return instructions;
  // "You are in ..." is told from the place the avatar is in.
  const note = placeManager
    ? placesNote(
        scopedPlaces(placeManager, placeId ?? placeManager.localPlaceId()),
        (id) => avatarRegistry?.get(id)?.name ?? id,
      )
    : null;
  const withPlaces = note
    ? instructions?.trim()
      ? `${instructions.trim()}\n\n${note}`
      : note
    : instructions;
  // "Your time and plans": the reminder, watch and flow tools (agent-time/), when they are on.
  return agentTime.enabled ? withTimeNote(withPlaces) : withPlaces;
}

/**
 * The system prompt for an avatar's turn. Echo uses what the renderer sent (or the last it sent,
 * or her saved prompt). Another avatar uses the prompt saved for its own VRM model, if it has a
 * model of its own, else its profile's prompt; avatars wearing Echo's body never borrow her prompt.
 * The movement tag instructions from the renderer follow the persona.
 */
function avatarInstructions(
  avatarId: string,
  sessionInstructions?: string,
  placeId: string = placeManager?.localPlaceId() ?? HOME_PLACE_ID,
): string | undefined {
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
  const baseInstructions =
    avatarId === DEFAULT_AVATAR_ID
      ? request.instructions
      : (avatarInstructions(avatarId, request.instructions, placeId) ?? request.instructions);
  const instructions = withPlacesNote(baseInstructions, request.preview === true, placeId);
  const payload =
    instructions === request.instructions
      ? request
      : { ...request, ...(instructions !== undefined ? { instructions } : {}) };
  const mirror = mirrorFor(avatarId);
  // Kevin is talking with this avatar (not a preview, a system update or back-channel chatter): it stops reading,
  // keeping its notes, so its live turn does not wait behind a reading call.
  if (!payload.preview && !payload.system && !payload.silent) {
    pursuitManager?.interrupt(avatarId, 'conversation');
    agentActHandler?.interruptThinking(avatarId);
  }
  mirror?.turnStarted(payload.requestId, {
    text: payload.text,
    system: payload.system === true,
    preview: payload.preview === true,
  });
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
    if (!payload.preview)
      mirror?.turnFinished(payload.requestId, { text: result.text, cancelled: result.cancelled });
    if (!payload.preview && result.text) quietSaves.clear(avatarId);
    if (!payload.preview && result.text) {
      if (here) presence.update({ lastAssistantSpokeAt: Date.now() });
      else placePresence.update(placeId, { assistantSpokeAt: Date.now() });
    }
    return tagResult(result, avatarId);
  } catch (error) {
    if (!payload.preview)
      mirror?.turnFinished(payload.requestId, {
        text: '',
        error: error instanceof Error ? error.message : String(error),
      });
    throw error;
  } finally {
    if (activeVoiceRequests.get(avatarId) === payload.requestId)
      activeVoiceRequests.delete(avatarId);
  }
}

/** The registry as one avatar uses it: the same tools, each call carrying the avatar's id. */
function avatarTools(
  registry: ToolRegistry,
  avatarId: string,
): Pick<ToolRegistry, 'list' | 'execute'> {
  return {
    list: () => registry.list(),
    execute: (toolId, params) => registry.execute(toolId, params, { avatarId }),
  };
}

function createVoiceService(avatarId: string): LocalVoiceService {
  const manager = voiceConfigManager;
  if (!voiceEngines || !manager) throw new Error('Voice engines are not configured yet.');
  return new LocalVoiceService({
    ...voiceEngines,
    avatarId,
    // Tools run on this avatar's behalf: a tool that depends on who calls (my_reading_notes) is told the avatar.
    tools: toolRegistry ? avatarTools(toolRegistry, avatarId) : undefined,
    approvals: approvalBroker?.forAvatar(avatarId),
    // Looked up at call time: the stations are set up after the voice services.
    stations: {
      prepare: () => voiceStations?.prepare() ?? Promise.resolve(),
      descriptionNote: (tool) => voiceStations?.descriptionNote(tool) ?? '',
      noticeFor: (id, tool) => voiceStations?.noticeFor(id, tool) ?? null,
      begin: (id, tool) => voiceStations?.begin(id, tool) ?? null,
      offer: (list) => voiceStations?.offer?.(list) ?? list,
      runLookup: (id, tool, params, context) =>
        voiceStations?.runLookup?.(id, tool, params, context) ?? null,
    },
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
    voiceFor: () =>
      characterVoice(speakingVoiceKey(manager.getConfig().models), avatarId) ?? undefined,
    // Through memoryEngine at call time: it is set up after this service.
    memory: {
      brief: () => memoryEngine?.voiceFor(avatarId).brief() ?? Promise.resolve(null),
      recall: (text, recalled) =>
        memoryEngine?.voiceFor(avatarId).recall(text, recalled) ?? Promise.resolve(null),
      activity: (busy) => memoryEngine?.voiceFor(avatarId).activity?.(busy),
    },
  });
}

async function applyProviderSettings(manager: ConfigManager): Promise<void> {
  const config = manager.getConfig();
  const { providers, models } = config;
  // The coder model while a task has Echo's place, else Echo's model on the controller's lease URL.
  const llmOverride =
    codingService?.chatOverride() ?? echoRouteOverride(models, aicontroller.echoUrl());
  const engines = buildVoiceEngines(models, (id) => manager.getServerKey(id), {
    logger,
    llmOverride,
  });
  voiceEngines = engines;
  voiceConfigManager = manager;
  if (voiceServices) {
    voiceServices.configure(engines);
  } else {
    voiceServices = new VoiceServices({ create: createVoiceService });
  }
  localVoiceService = voiceServices.get(DEFAULT_AVATAR_ID);

  const motionServer = localMotionServer(manager);
  // This PC's own motion service is leased from the model controller (when it has one) while motion is enabled.
  const motionLeased = motionServer?.id === BUILT_IN_SERVER_IDS.motion && motionServer.managed;
  aicontroller.setMotionWanted(motionLeased);
  const motionUrl =
    (motionLeased ? aicontroller.motionUrl() : null) ??
    motionServer?.url ??
    providers.motion.localServiceUrl;
  if (avatarAnimationService && currentMotionServiceUrl !== motionUrl) {
    localMotionService = new LocalMotionGenerationService({
      client: new LocalMotionClient({
        baseUrl: motionUrl,
        trace: (kind, build) => motionTrace.log('main', kind, build),
      }),
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
    .catch((error: unknown) =>
      logger.warn('Coding runner setup failed.', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );

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
function getLocalLlmTools(manager: ConfigManager): {
  library: LlmLibrary;
  control: LocalLlmControl;
} {
  if (localLlmTools) return localLlmTools;
  // pnpm dev:run moves the profile folders; downloads go to the real one so they outlive .dev-home.
  const home = process.env.AIEMBODIED_HOST_USERPROFILE?.trim() || os.homedir();
  const library = new LlmLibrary({
    file: path.join(app.getPath('userData'), 'local-llm.json'),
    modelsDirectory:
      process.env.LOCAL_LLM_MODELS_DIR?.trim() ||
      path.join(home, '.cache', 'aiembodied', 'llm-models'),
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
    viaController: () => aicontroller.inUse(),
    // Picking a model re-leases echo-llm with it (the controller loads the model).
    useModelViaController: (pick) => aicontroller.useEchoModel(pick),
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
    const server = manager
      .getConfig()
      .models.servers.find((entry) => entry.id === BUILT_IN_SERVER_IDS.vision);
    return server && isLocalUrl(server.url) ? serverUrl(server.type, server.url) : null;
  };
  const model = new VisionModel({
    file: path.join(app.getPath('userData'), 'local-vision.json'),
    modelsDirectory:
      process.env.LOCAL_LLM_MODELS_DIR?.trim() ||
      path.join(home, '.cache', 'aiembodied', 'llm-models'),
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
    leases: aicontroller,
    logger,
  });
  visionTools = { model, server };
  return visionTools;
}

/** Run a helper job on the vision model when `use` is routed to it (starting it first), else as is. */
function withVision<T>(
  manager: ConfigManager,
  use: 'describe' | 'posecheck',
  job: () => Promise<T>,
): Promise<T> {
  return withVisionServer(manager.getConfig().models, use, getVisionTools(manager).server, job);
}

/**
 * Run a downloaded model (or, with null, the start script's default) for Thinking: point Thinking
 * at this PC's llama-server and restart it with that model. Returns what happened, in words.
 */
async function useLocalLlm(
  manager: ConfigManager,
  id: string | null,
  settings?: Partial<LocalLlmSettings>,
): Promise<string> {
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
  logger.info('Thinking model changed.', {
    model: model?.id ?? 'default',
    restarted: result.restarted,
  });
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
        viaController: () => aicontroller.inUse(),
      }),
    controller: aicontroller,
    controllerLine: () => aicontroller.status().line,
    onOverrideChange: () => applyProviderSettings(manager),
    gpuMemory: gpuMemoryReader,
    notify: (text, options) => notifyAvatar(CODING_NUDGE_AVATAR_ID, text, options?.urgent === true),
    logger,
  });
  const service = codingService;
  const workspaceName = (id: string | undefined) =>
    manager.getCoding().workspaces.find((ws) => ws.id === id)?.name ?? id ?? 'a workspace';
  codingNudger = new CodingNudger({
    notify: (text, options) => notifyAvatar(CODING_NUDGE_AVATAR_ID, text, options?.urgent === true),
    getTask: (id) =>
      service
        .runnerClient()
        ?.getTask(id)
        .catch(() => null) ?? Promise.resolve(null),
    workspaceName,
    logger,
  });
  service.onRunnerEvent((event) => void codingNudger?.handleEvent(event));
  service.onRunnerEvent((event) => mirrorFor(CODING_NUDGE_AVATAR_ID)?.runnerEvent(event));
  // Finished tasks become memories. The memory engine is set up later, so it is read at call time.
  const memoryWriter = new CodingMemoryWriter({
    getTask: (id) =>
      service
        .runnerClient()
        ?.getTask(id)
        .catch(() => null) ?? Promise.resolve(null),
    workspaceName,
    post: (task) => memoryEngine?.outbox.enqueue({ kind: 'coding_task', task }),
    agentName: () =>
      memoryStore ? avatarAgent(memoryStore, avatarRegistry, CODING_NUDGE_AVATAR_ID).name : null,
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
  logger.info('Coding tools registered', {
    server: CODING_SERVER_ID,
    workspaces: workspaces.length,
  });
}

/** One line for Echo's prompt: where the coding agent can work. Empty when it can't be reached. */
function codingBrief(manager: ConfigManager): string | null {
  const workspaces = manager.getCoding().workspaces;
  if (workspaces.length === 0 || !codingService?.status().runnerUp) return null;
  const names = workspaces
    .map((ws) => (ws.kind === 'self' ? `${ws.name} (your own code)` : ws.name))
    .join(', ');
  return `You can hand coding work to the coding agent in: ${names}. Use the coding tools.`;
}

async function codingView(manager: ConfigManager): Promise<CodingView> {
  const service = getCodingService(manager);
  return {
    coding: manager.getCoding(),
    runnerId: service.runnerServer()?.id ?? null,
    status: service.status(),
  };
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
  const onIpc: OnIpc = (channel, listener) => {
    ipcMain.on(channel, listener);
  };
  const applySettings = () => applyProviderSettings(manager);
  const motionServer = () => localMotionServer(manager);
  const ensureAvatarDescription = async () => {
    if (!avatarDescriptionService) await refreshAvatarDescriptionService(manager);
    return avatarDescriptionService;
  };
  const ensureVrmaGeneration = async () => {
    if (!vrmaGenerationService) await refreshVrmaGenerationService(manager);
    return vrmaGenerationService;
  };
  const ensurePoseGeneration = async () => {
    if (!poseGenerationService) await refreshPoseGenerationService(manager);
    return poseGenerationService;
  };
  const ensurePoseEvaluation = async () => {
    if (!poseEvaluationService) await refreshPoseEvaluationService(manager);
    return poseEvaluationService;
  };

  registerConfigIpc({
    handle: handleIpc,
    logger,
    manager,
    applyProviderSettings: applySettings,
    refreshPoseGenerationService: () => refreshPoseGenerationService(manager),
  });
  registerDiagnosticsIpc({ handle: handleIpc, on: onIpc, logger, manager, gpuMemoryReader });
  registerCodingIpc({
    handle: handleIpc,
    manager,
    getMainWindow: () => mainWindow,
    getCodingService: () => getCodingService(manager),
    codingView: () => codingView(manager),
    applyProviderSettings: applySettings,
    broadcast: broadcastToWindows,
  });
  if (approvalBroker) {
    registerApprovalsIpc({
      handle: handleIpc,
      broker: approvalBroker,
      broadcast: broadcastToWindows,
    });
  }
  registerModelsIpc({
    handle: handleIpc,
    manager,
    memoryEngine: () => memoryEngine,
    aicontroller,
    modelDownloads,
    comfyAddonDirectory,
    getLocalLlmTools: () => getLocalLlmTools(manager),
    getVisionTools: () => getVisionTools(manager),
    useLocalLlm: (id, settings) => useLocalLlm(manager, id, settings),
    applyProviderSettings: applySettings,
  });
  registerTalkIpc({ handle: handleIpc, pushToTalk });
  registerWakeWordIpc({
    handle: handleIpc,
    manager,
    trainedWakeWordDirectory,
    wakeWordListening,
    wakeWordTrainer: () => wakeWordTrainer,
  });
  registerConversationIpc({ handle: handleIpc, conversation });
  registerMetricsIpc({ handle: handleIpc, metrics });
  registerAvatarIpc({
    handle: handleIpc,
    logger,
    avatarModels,
    avatarAnimations,
    avatarPoses,
    aicontroller,
    localMotion: () => localMotionService,
    localMotionServer: motionServer,
    ensureAvatarDescriptionService: ensureAvatarDescription,
    ensureVrmaGenerationService: ensureVrmaGeneration,
    ensurePoseGenerationService: ensurePoseGeneration,
    ensurePoseEvaluationService: ensurePoseEvaluation,
    withVision: (use, job) => withVision(manager, use, job),
    emitCameraDetection,
  });
  registerAvatarGenerationIpc({
    handle: handleIpc,
    manager,
    imageModels: () => avatarImageModels,
    characterModels: () => avatarCharacterModels,
    generation: () => avatarGenerationService,
    comfyPool: () => avatarComfyPool,
  });
  registerAvatarMotionIpc({
    handle: handleIpc,
    on: onIpc,
    manager,
    aicontroller,
    localMotion: () => localMotionService,
    localMotionServer: motionServer,
    motionTrace,
  });
  registerBackgroundsIpc({ handle: handleIpc, backgrounds: () => backgroundService });
  registerFurnitureIpc({ handle: handleIpc, furniture: () => furnitureService });
  registerRoomsIpc({
    handle: handleIpc,
    logger,
    manager,
    aicontroller,
    broadcast: broadcastToWindows,
    rooms: () => roomService,
    backgrounds: () => backgroundService,
    roomGeneration: () => roomGeneration,
  });
  registerPlacesIpc({
    handle: handleIpc,
    requirePlaces,
    talkedAgoMs,
    placeOf,
    floorFor,
    avatarRegistry: () => avatarRegistry,
  });
  registerStationsIpc({
    handle: handleIpc,
    stationRegistry: () => stationRegistry,
    stationTrips: () => stationTrips,
  });
  registerPursuitsIpc({
    handle: handleIpc,
    pursuitManager: () => pursuitManager,
    stationRegistry: () => stationRegistry,
    memoryStore: () => memoryStore,
  });
  registerAgentTimeIpc({
    handle: handleIpc,
    agentSleep,
    agentTime,
    workflowsClient: () => workflowsClient,
  });
  registerRoomHubIpc({
    handle: handleIpc,
    roomHub: () => roomHub,
    requirePlaces,
    placePresence,
    placeDevices: () => placeDevices,
  });
  registerAvatarsIpc({
    handle: handleIpc,
    avatarRegistry: () => avatarRegistry,
    memoryStore: () => memoryStore,
    voiceServices: () => voiceServices,
    pursuitManager: () => pursuitManager,
    agentSync: () => agentSync,
    agentSleep,
    placeOf,
    startAvatarPlumbing: (profile) => startAvatarPlumbing(profile, manager),
    stopAvatarPlumbing: (avatarId) => {
      avatarPlumbing.get(avatarId)?.inbox.stop();
      avatarPlumbing.delete(avatarId);
    },
    setTagInstructions: (placeId, instructions) => {
      avatarTagInstructionsByPlace.set(placeId, instructions);
    },
    characterIdleHabitsKey,
    avatarPersona,
  });
  registerAvatarSettingsIpc({
    handle: handleIpc,
    logger,
    manager,
    memoryStore: () => memoryStore,
    avatarRegistry: () => avatarRegistry,
    characterVoiceKey,
    characterIdleHabitsKey,
    characterPromptKey,
    characterVoice,
  });
  registerLocalVoiceIpc({
    handle: handleIpc,
    localVoiceService: () => localVoiceService,
    getVoiceService,
    voiceConfigManager: () => voiceConfigManager,
    aicontroller,
    codingService: () => codingService,
    placeManager: () => placeManager,
    avatarRegistry: () => avatarRegistry,
    placeOf,
    floorFor,
    noteEchoInstructions: (placeId, instructions) => {
      lastEchoInstructions.set(placeId, instructions);
    },
    setFloorSender: (sender) => {
      floorSender = sender;
    },
    runVoiceTurn,
  });
  registerPresenceIpc({
    handle: handleIpc,
    presence,
    placePresence,
    placeOf,
    localPlaceId: () => placeManager?.localPlaceId() ?? HOME_PLACE_ID,
  });
  registerFloorIpc({
    handle: handleIpc,
    placeOf,
    existingFloor: (placeId) => floors.get(placeId),
    floor: () => floor,
  });
  registerSwitchboardIpc({
    handle: handleIpc,
    switchboardClient: () => switchboardClient,
    switchboardBus: () => switchboardBus,
    decisionLog,
    avatarRegistry: () => avatarRegistry,
  });
  registerLifecycleIpc({
    handle: handleIpc,
    logger,
    aicontroller,
    serverManager: () => serverManager,
  });
  if (toolRegistry && mcpManager) {
    registerMCPHandlers({ handle: handleIpc, mcpManager, toolRegistry });
    logger.info('MCP IPC handlers registered');
  }
}

/**
 * Stations: tools that live at an object in a 3D room. The registry knows which tool lives where; the trips
 * send an avatar to the object while the tool runs (stations/station-trips.ts); the voice gets both through
 * `voiceStations`. Needs the places, the rooms, the tools and the MCP servers, so it is set up after them.
 */
function setupStations(store: MemoryStore): void {
  const places = placeManager;
  if (!places || !toolRegistry || !mcpManager || !roomService) return;
  const tools = toolRegistry;
  const manager = mcpManager;
  const rooms = roomService;
  const registry = new StationRegistry({
    store,
    // Sync on purpose (the registry is pure and sync): listServerAddresses reads only unencrypted columns.
    servers: () => manager.listServerAddresses(),
    describeRoom: async (roomId) => {
      const room = await rooms.load(roomId);
      return {
        name: room.name,
        objects: room.objects.map((object) => ({ id: object.id, name: object.name })),
      };
    },
    tools: { get: (id) => tools.get(id) },
  });
  const trips = new StationTrips({
    stations: registry,
    places,
    // The local place draws the stage's room; only a 3D room (`room:...`) has objects to walk to.
    activeRoom: () => backgroundService?.getActive() ?? null,
    send: (avatarId, event) => {
      const placeId = places.locationOf(avatarId);
      const reachable =
        placeId === places.localPlaceId()
          ? BrowserWindow.getAllWindows().some((window) => !window.isDestroyed())
          : Boolean(roomHub?.deviceForPlace(placeId));
      if (!reachable) return false;
      sendForAvatar(avatarId, 'station:use', event);
      return true;
    },
    logger,
  });
  stationRegistry = registry;
  stationTrips = trips;
  // Reading stations are offered to the conversation as one tool each (env STATION_SINGLE_TOOL=0 turns it off).
  voiceStations = createVoiceStations(
    registry,
    trips,
    new StationLookup({ stations: registry, tools, logger }),
  );
}

/**
 * Pursuits (pursuits/): reading sessions a character starts on its own at a station. Each runs on the avatar's own
 * conversation model, with only the station's tools; its body walks to the station like a tool call would. Needs
 * the stations, the tools and the voice services.
 */
function setupPursuits(store: MemoryStore): void {
  const registry = stationRegistry;
  const trips = stationTrips;
  const tools = toolRegistry;
  if (!registry || !trips || !tools) return;
  pursuitManager = new PursuitManager({
    stations: registry,
    tools,
    voiceFor: (avatarId) => {
      const service = getVoiceService(avatarId);
      return service
        ? { chat: () => service.chat(), recentLines: (count) => service.recentLines(count) }
        : null;
    },
    // The character's own prompt only (no scene tags): Echo's saved prompt, another's by avatarPersona().
    persona: (avatarId) => {
      if (avatarId === DEFAULT_AVATAR_ID) {
        const key = characterPromptKey(DEFAULT_AVATAR_ID);
        return (key ? store.getValue(key) : null)?.trim() ?? '';
      }
      return avatarPersona(avatarId).persona ?? '';
    },
    habits: (avatarId) => {
      const key = characterIdleHabitsKey(avatarId);
      return key ? normalizeIdleHabits(store.getValue(key)) : '';
    },
    avatarName: (avatarId) => avatarRegistry?.get(avatarId)?.name ?? avatarId,
    isAsleep: (avatarId) => agentSleep.isAsleep(avatarId),
    gate: agentLlmGate,
    memoryFor: (avatarId) => ({
      brief: () => memoryEngine?.voiceFor(avatarId).brief() ?? Promise.resolve(null),
    }),
    notes: store,
    // Also in long-term memory, through the outbox (so it waits for the engine when it is down).
    saveToMemory: (note, avatarName) =>
      memoryEngine?.outbox.enqueue(readingOutboxItem(note, avatarName, conversationModelName())),
    // An update from the avatar itself: the inbox decides to ignore, remember or say it. Never spoken from the pursuit.
    tell: (avatarId, text) => {
      const mirror = mirrorFor(avatarId);
      if (mirror) mirror.noteQueued(text, false, 'your own reading');
      else getVoiceService(avatarId)?.notify(text, { urgent: false, source: 'your own reading' });
    },
    visit: (avatarId, station) => trips.beginAt(avatarId, station),
    onChanged: (running) => {
      broadcastToWindows('pursuits:changed', running);
      roomHub?.sendToAll({ op: 'ipc', channel: 'pursuits:changed', args: [running] });
    },
    logger,
  });
}

/** The avatar's own prompt text (no scene tags), as pursuits and agent thinking use it. */
function avatarPersonaText(avatarId: string): string {
  if (avatarId === DEFAULT_AVATAR_ID) {
    const key = characterPromptKey(DEFAULT_AVATAR_ID);
    return (key ? memoryStore?.getValue(key) : null)?.trim() ?? '';
  }
  return avatarPersona(avatarId).persona ?? '';
}

/**
 * Agent time (agent-time/, docs/features/agent-time.md): the workflow tools, the handler that does what the workflows
 * service asks (acts), and the sync that tells the service which avatars exist. Everything the handler needs from the app
 * is looked up when it is used, because several parts (pursuits, places) are set up later than this.
 */
function setupAgentTime(registry: ToolRegistry, broker: ApprovalBroker): void {
  const client = new WorkflowsClient({ baseUrl: agentTime.url, token: agentTime.token });
  workflowsClient = client;
  for (const tool of createAgentTimeTools({ client })) registry.register(tool);
  logger.info('Agent time is on: workflow tools registered', {
    url: agentTime.url,
    agentLife: agentTime.agentLife,
  });
  const places = () => placeManager;
  agentActHandler?.stop();
  agentActHandler = new AgentActHandler({
    bus: () => switchboardBus,
    logger,
    sleep: agentSleep,
    quietSaves,
    presence,
    avatarName: (avatarId) => avatarRegistry?.get(avatarId)?.name ?? null,
    persona: avatarPersonaText,
    habits: (avatarId) => {
      const key = characterIdleHabitsKey(avatarId);
      return key && memoryStore ? normalizeIdleHabits(memoryStore.getValue(key)) : '';
    },
    placeOf: (avatarId) => {
      const manager = places();
      if (!manager) return HOME_PLACE_ID;
      const placeId = manager.locationOf(avatarId);
      return manager.get(placeId)?.node === 'offscreen' ? 'next-door' : placeId;
    },
    restlessness: () => {
      const idle = backgroundService?.getIdleSettings();
      return idle?.enabled ? idle.restlessness : null;
    },
    conversationActive: (avatarId) => {
      if (activeVoiceRequests.has(avatarId)) return true;
      const ago = talkedAgoMs(avatarId);
      return ago !== null && ago < CONVERSATION_MS;
    },
    pursuits: {
      isRunning: (avatarId) => pursuitManager?.isRunning(avatarId) === true,
      offers: () => pursuitManager?.offers() ?? [],
      start: (avatarId, stationId) =>
        pursuitManager?.start(avatarId, stationId) ?? {
          ok: false,
          reason: 'pursuits are not available yet',
        },
      interrupt: (avatarId, reason) => pursuitManager?.interrupt(avatarId, reason) === true,
    },
    say: (avatarId, text, urgent, source) => {
      const mirror = mirrorFor(avatarId);
      if (mirror) mirror.noteQueued(text, urgent, source);
      else getVoiceService(avatarId)?.notify(text, { urgent, source });
    },
    chatFor: (avatarId) => getVoiceService(avatarId)?.chat() ?? null,
    brief: (avatarId) => memoryEngine?.voiceFor(avatarId).brief() ?? Promise.resolve(null),
    llmGate: agentLlmGate,
    tools: registry,
    approvals: broker,
    nextDoor: {
      tryAvatar: (avatarId) =>
        nextDoorReturn?.tryAvatar(avatarId) ?? { moved: false, reason: 'places are not ready' },
    },
  });
  agentActHandler.start();
  agentSleep.onChanged((asleep) => {
    broadcastToWindows('agents:changed', asleep);
    roomHub?.sendToAll({ op: 'ipc', channel: 'agents:changed', args: [asleep] });
  });
  agentSync?.stop();
  agentSync = new AgentSync({
    client,
    avatars: () =>
      (avatarRegistry?.list() ?? []).map((profile) => ({ id: profile.id, name: profile.name })),
    logger,
  });
  void agentSync.sync();
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

/** Keeps a trained wake word model bija sent, named by what it holds, and gives its path. */
async function storeSharedWakeModel(_name: string, bytes: Uint8Array): Promise<string> {
  const directory = path.join(app.getPath('userData'), 'wake-word-cache');
  await mkdir(directory, { recursive: true });
  const file = path.join(
    directory,
    `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.onnx`,
  );
  if (!existsSync(file)) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, file);
  }
  return file;
}

/**
 * "Start when I sign in" for a satellite (Windows only; off until Kevin turns it on). A packaged app starts itself; a repo
 * checkout (`pnpm satellite`) starts Electron on the built main.js. Both pass --satellite, so the role does not depend on
 * the environment of a login start.
 */
function satelliteStartAtLogin():
  { isEnabled(): Promise<boolean>; set(on: boolean): Promise<boolean> } | undefined {
  if (process.platform !== 'win32') return undefined;
  const manager = new AutoLaunchManager({
    logger,
    appName: `${APP_NAME} Satellite`,
    appPath: app.getPath('exe'),
    args: app.isPackaged ? [SATELLITE_FLAG] : [__filename, SATELLITE_FLAG],
  });
  return { isEnabled: () => manager.isEnabled(), set: (on) => manager.sync(on) };
}

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
    startAtLogin: satelliteStartAtLogin(),
    logger: satelliteLogger,
  });
  satellite = runtime;
  // The privacy gate: the mic is live only while an avatar is here, the screen is unlocked, the link is up, the
  // room is open and no other app is full screen. It lives here, in the main process, and fails closed.
  const startIcon = stateIcon('off');
  const tray = new Tray(
    nativeImage.createFromBitmap(toBgra(startIcon.data), {
      width: startIcon.width,
      height: startIcon.height,
      scaleFactor: 2,
    }),
  );
  // The wake word runs here too, but only while the gate allows it: with an avatar in the room, or as the doorbell
  // (the room's setting) with nobody there. In doorbell mode a wake sends only its name and score to bija.
  satelliteWake = new SatelliteWakeRunner({
    fetchModel: async () => (await runtime.callHub('wake-word:model')) as SharedWakeWord | null,
    storeModel: storeSharedWakeModel,
    start: (config, onWake) => launchWakeWordService(config, { onWake }),
    onWake: (event, mode) => {
      logger.info('Wake word heard on a satellite', {
        keyword: event.keywordLabel,
        confidence: event.confidence,
        mode,
      });
      if (mode === 'doorbell') {
        runtime.sendOp({ op: 'wake.heard', model: event.keywordLabel, score: event.confidence });
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wake-word:event', event);
      }
    },
    logger: satelliteLogger,
  });
  const devices = new DeviceRuntime({
    onGate: (state) => satelliteWake?.setGate(state),
    settings,
    powerMonitor,
    globalShortcut,
    session: session.defaultSession,
    getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    sendOp: (op) => runtime.sendOp(op),
    tray,
    makeImage: (icon) =>
      nativeImage.createFromBitmap(toBgra(icon.data), {
        width: icon.width,
        height: icon.height,
        scaleFactor: 2,
      }),
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
  // "Someone used this PC" goes to bija as it is: no mic and no camera are involved.
  satelliteActivity = new ActivityMonitor({
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onActive: (at) => void runtime.sendOp({ op: 'presence', activeAt: at }),
    logger: satelliteLogger,
  });
  satelliteActivity.start();
  await runtime.start(ipcMain, protocol);
  logger.info('Running as a satellite PC.', { hub: settings.get().hubUrl });
  let window: BrowserWindow;
  try {
    window = createWindow();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown renderer bootstrap error occurred while creating the window.';
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
    pidDirectories: [
      path.resolve(__dirname, '../../..', '.dev-home', 'logs'),
      path.join(app.getPath('userData'), 'logs'),
    ],
    // The model controller owns the language-model servers it started: their pid files are skipped.
    controllerInUse: () => aicontroller.inUse(),
    // ...and so are motion, vision and ComfyUI when the controller has those backends.
    controllerManages: (backend) => aicontroller.managesBackend(backend),
  });
  logger.info('ServerManager initialized');

  // Register for system suspend/resume notifications
  if (process.platform === 'win32') {
    // Windows: Use powerMonitor (cross-platform) with native fallback
    powerMonitor.on('suspend', async () => {
      logger.info('System suspend detected');
      await aicontroller.suspend().catch(() => undefined);
      await serverManager?.suspend().catch((error) => {
        logger.warn('Failed to suspend servers', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    powerMonitor.on('resume', async () => {
      logger.info('System resume detected');
      await aicontroller.resume().catch(() => undefined);
      await serverManager?.resume().catch((error) => {
        logger.warn('Failed to resume servers', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    logger.info('System suspend/resume handlers registered');
  } else {
    logger.info('Suspend/resume handlers not available on this platform');
  }

  // MCP servers start once the configuration (and the keys saved with it) has loaded; see releaseMcpStart().
  let releaseMcpStart: () => void = () => {};
  const mcpMayStart = new Promise<void>((resolve) => {
    releaseMcpStart = resolve;
  });

  const manager = new ConfigManager({
    secretStore,
    preferencesStore: new FilePreferencesStore(
      path.join(app.getPath('userData'), 'preferences.json'),
    ),
    logger,
    openAIClientFactory: getOpenAIClient,
    repoRoot: path.resolve(__dirname, '../../..'),
  });

  if (!switchboardBus) {
    if (process.env.SWITCHBOARD_ENABLED !== '0') {
      switchboardClient = new SwitchboardClient({
        baseUrl: process.env.SWITCHBOARD_URL?.trim() || 'http://127.0.0.1:8196',
        logger,
      });
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
    const places = new PlaceManager({
      store: memoryStore,
      registry,
      bus: () => switchboardBus,
      activeAt: (placeId) => placePresence.get(placeId)?.activeAt ?? null,
      logger,
    });
    placeManager = places;
    places.onChanged((snapshot) => broadcastToWindows('places:changed', snapshot));
    // The wake word holds the microphone only while an avatar is here or the doorbell is on.
    places.onChanged(() => syncWakeGate());
    syncWakeGate();
    // Camera presence across places: the decision step hears about each other place's camera and who is there, and an
    // avatar that walks in where a face was just seen waves at it.
    presence.setPlaceLines((now) =>
      places
        .list()
        .filter((place) => place.node !== 'local' && place.node !== 'offscreen')
        .map((place) =>
          describePlaceLine(
            {
              name: place.name,
              faceSeenAt: placePresence.get(place.id)?.faceSeenAt ?? null,
              avatars: places
                .avatarsAt(place.id)
                .map((avatarId) => registry.get(avatarId)?.name ?? avatarId),
            },
            now,
          ),
        ),
    );
    const greetOnArrival = createArrivalGreeting({
      faceSeenAt: (placeId) =>
        placeId === places.localPlaceId()
          ? presence.faceSeenAt()
          : cameraPresenceOn(places.get(placeId))
            ? (placePresence.get(placeId)?.faceSeenAt ?? null)
            : null,
      send: (avatarId, payload) => delivery.sendForAvatar(avatarId, 'camera:detection', payload),
    });
    places.onArrived((avatarId, placeId) => {
      if (greetOnArrival(avatarId, placeId))
        logger.info('An avatar waved at a face on arrival.', { avatarId, placeId });
    });
    // Desktop rooms: a second PC that draws one place. The hub only listens when a PC is paired or a code is active.
    const hub = new RoomHub({
      registry: new RoomDeviceRegistry(path.join(app.getPath('userData'), 'room-devices.json')),
      places,
      tailscale: createTailscaleLookup(),
      assetRoot: path.join(app.getPath('userData'), 'rooms', ASSET_FOLDER),
      // The renderer build the window loads, also served to a browser at /app/ (web and phone rooms).
      webRoot: webRootFor(__dirname),
      appVersion: app.getVersion(),
      firewallNoted: fileMarker(path.join(app.getPath('userData'), 'room-hub-firewall-noted')),
      avatars: () => registry.list(),
      settings: () => ({
        wakeWord: manager.getRendererConfig().wakeWord ?? null,
        pushToTalk: pushToTalk.getStatus(),
      }),
      bus: () => switchboardBus,
      onSatelliteMessage: (from, op) => {
        if (op.op === 'presence' || op.op === 'wake.heard')
          placePresence.onSatelliteOp(from.placeId, op);
        else placeDevices?.onMessage(from.placeId, op);
        // The doorbell on a satellite heard its wake word with nobody in the room: call an avatar over (only a name and a score came, never audio).
        if (op.op === 'wake.heard' && typeof op.score === 'number')
          void doorbellFor(from.placeId)?.onWake();
      },
      logger,
    });
    roomHub = hub;
    const pushHubStatus = () =>
      broadcastToWindows('room-hub:changed', roomHubStatus(hub, placePresence));
    placeDevices = new PlaceDevices({
      places,
      presence: placePresence,
      bus: () => switchboardBus,
      onChanged: pushHubStatus,
      logger,
    });
    hub.onChanged(pushHubStatus);
    places.settleOffline();
    // Someone using bija's PC is "active" at its place (no mic or camera involved). Satellites report theirs over the link.
    activityMonitor?.stop();
    activityMonitor = new ActivityMonitor({
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      onActive: (at) => void placePresence.update(places.localPlaceId(), { activeAt: at }),
      logger,
    });
    activityMonitor.start();
    // Avatars next door have no screen, so they have no idle life: now and then one may come back to where someone is.
    nextDoorReturn?.stop();
    nextDoorReturn = new NextDoorReturn({
      places,
      restlessness: () => {
        const idle = backgroundService?.getIdleSettings();
        return idle?.enabled ? idle.restlessness : null;
      },
      talkedAgoMs,
      logger,
    });
    // With agent life on, the life workflows decide when someone comes back (act return_home); the class stays for that.
    if (!agentTime.agentLife) nextDoorReturn.start();
    void hub.start().catch((error) =>
      logger.warn('Room hub failed to start', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    // One floor per place: the scene is the avatars at that place, and what the floor starts (answers, chatter)
    // is delivered where that place is drawn (this window, or a satellite's link).
    makeFloor = (placeId) =>
      new FloorController({
        registry,
        places: scopedPlaces(places, placeId),
        // Kevin's line picked an avatar that is somewhere else: it walks in, and its turn waits for it.
        summon: (avatarId, reason) => summon(scopedPlaces(places, placeId), avatarId, reason),
        reportError: (avatarId, requestId, message) => {
          const sink = sinkFor(placeId);
          if (sink && !sink.isDestroyed())
            sink.send(
              'local-voice:event',
              tagEvent({ requestId, type: 'error', message }, avatarId),
            );
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
          if (sink && !sink.isDestroyed())
            sink.send('local-voice:event', tagEvent(voiceEvent, chatterAvatarId));
        },
        saveLine: (line) =>
          conversationManager?.appendToRecentSession([
            { role: 'assistant', content: line.content, speaker: line.speaker, ts: line.ts },
          ]),
        instructionsFor: (avatarId) =>
          withPlacesNote(avatarInstructions(avatarId, undefined, placeId), false, placeId),
        bus: () => switchboardBus,
        // Quick decisions (Laya) answer first; the clients are built per call so a changed route applies at once.
        // When the route is off or fails, bids go to the Idle thoughts model and the addressee check (avatar lines only) is skipped.
        addressee: (input, signal) => {
          const client = createSystemOne({
            routing: manager.getConfig().models,
            keyFor: (id) => manager.getServerKey(id),
            logger,
          });
          if (!client) return Promise.reject(new Error('Quick decisions are off'));
          return createSystemOneAddressee(client, (id) => registry.get(id)?.name ?? id)(
            input,
            signal,
          );
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
            routes: {
              ...routing.routes,
              decide: {
                ...decide,
                model,
                backups: decide.backups?.map((backup) => ({ ...backup, model })),
              },
            },
          };
          const client = createSystemOne({
            routing: floorRouting,
            keyFor: (id) => manager.getServerKey(id),
            logger,
          });
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
          const nameOfSpeaker = (from: string) =>
            from.startsWith('avatar:')
              ? (registry.get(from.slice('avatar:'.length))?.name ?? from)
              : 'Kevin';
          const client = createSystemOne({
            routing: manager.getConfig().models,
            keyFor: (id) => manager.getServerKey(id),
            logger,
          });
          if (client) {
            try {
              return await createSystemOneBid(client, nameOfSpeaker)(
                candidates,
                recentLines,
                signal,
              );
            } catch (error) {
              logger.warn('Quick-decision bids failed; asking the Idle thoughts model.', {
                message: error instanceof Error ? error.message : String(error),
              });
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
      makeClient: () =>
        createSystemOne({
          routing: manager.getConfig().models,
          keyFor: (id) => manager.getServerKey(id),
          logger,
        }),
      notify: (text, options) => getVoiceService(DEFAULT_AVATAR_ID)?.notify(text, options),
      avatarName: () => avatarRegistry?.get(DEFAULT_AVATAR_ID)?.name ?? 'Echo',
      bus: () => switchboardBus,
      logger,
    });
    if (agentTime.agentLife) {
      logger.info(
        'Agent life is on: the life workflows replace the proactive tick and the next-door return',
      );
    } else {
      logger.info('Agent life is off: using the proactive tick and the next-door return', {
        workflows: agentTime.enabled,
      });
      proactiveTick.start();
    }
    // Provider settings may have been applied before the engine existed.
    syncMemoryStorage();

    // Initialize MCP tool registry and manager
    toolRegistry = new ToolRegistry();
    toolRegistry.register(createReadingNotesTool({ notes: memoryStore }));
    // The agents' yes/no questions (agent-time/ask.ts) are answered by the wrapper; the nudger does not announce them.
    approvalBroker = new ApprovalBroker({
      registry: withQuestionTool(toolRegistry),
      avatarId: DEFAULT_AVATAR_ID,
      logger,
    });
    approvalBroker.on('outcome', (outcome: ApprovalOutcome) => {
      if (outcome.approval.toolId !== QUESTION_TOOL_ID) codingNudger?.handleApproval(outcome);
    });
    approvalBroker.on('outcome', (outcome: ApprovalOutcome) =>
      mirrorFor(avatarIdOfAddress(outcome.approval.requestedBy))?.approvalOutcome(outcome),
    );
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
    if (agentTime.enabled) setupAgentTime(toolRegistry, approvalBroker);
    // openExternal is only used for an explicit "Sign in" press; start-up never opens the browser.
    mcpManager = new MCPManager(memoryStore.database, toolRegistry, {
      openExternal: (url) => shell.openExternal(url),
      // Home Assistant homes of Models and servers become ready-made servers; their tokens are read here, in main,
      // when the server connects (never sent to the renderer).
      homeAssistantHomes: () =>
        manager
          .getConfig()
          .models.servers.filter((server) => server.type === 'homeassistant')
          .map((server) => ({ id: server.id, name: server.name, url: server.url })),
      modelServerToken: (id) => manager.getServerKey(id),
    });
    // Servers connect in the background so a slow one cannot hold up start-up. They wait for the configuration
    // (and its saved keys) to load first: a Home Assistant server needs its token to connect.
    void mcpMayStart
      .then(() => mcpManager?.initialize())
      .catch((error) => {
        logger.warn('MCP auto-start failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    logger.info('MCP Manager initialized', {
      autoStartedServers: (await mcpManager.listServers()).filter((s) => s.autoStart && s.enabled)
        .length,
    });

    // Seed default model if this is the first run
    await avatarModelService.seedDefaultModelIfMissing(DEFAULT_MODEL_ASSET_PATH);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown database initialization error occurred.';
    logger.error('Failed to initialize memory store', { message });
    dialog.showErrorBox('Database Error', message);
    app.quit();
    return;
  }

  try {
    await manager.load();
    releaseMcpStart();
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
    // With the model controller in use, this PC's ComfyUI is leased from it per job instead of started here.
    leases: aicontroller,
  });
  avatarComfyPool = comfyPool;
  const imageModelScript = path
    .join(__dirname, '../assets/avatar-generation/image-models.py')
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  // Model lists come from the first ComfyUI server of each step: this PC's files are read
  // directly, another machine's are listed over its HTTP API.
  const scanComfyModels = (stage: 'image' | 'mesh') => async () => {
    const server = comfyPool.primary(stage);
    if (!server)
      throw new Error('No ComfyUI server is set for this step. Choose one in Models and servers.');
    if (server.managed && aicontroller.inUse() && aicontroller.managesBackend('comfyui')) {
      // This PC's ComfyUI is the controller's: list the models of every machine it can send a job to.
      return createControllerModelScanner(
        async () =>
          (await aicontroller.listAllModels()).map((entry) => ({
            kind: entry.kind,
            subfolder: entry.subfolder,
            fileName: entry.fileName,
            host: entry.host,
            state: entry.state,
          })),
        createImageModelScanner(imageModelScript, server.url),
      )();
    }
    return server.managed
      ? createImageModelScanner(imageModelScript, server.url)()
      : createRemoteComfyModelScanner(server.url)();
  };
  avatarImageModels = new AvatarImageModelService(
    scanComfyModels('image'),
    memoryStore ?? undefined,
    poseControlInstaller,
  );
  const characterRunner = new BlenderCharacterRunner(
    path
      .join(__dirname, '../assets/avatar-generation/rig-character.py')
      .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
  );
  avatarCharacterModels = new AvatarCharacterModelService(
    scanComfyModels('mesh'),
    () => characterRunner.assertAvailable(),
    memoryStore ?? undefined,
  );
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
          return avatarImageModels.resolveObjectModel();
        },
        geometryModel: () => {
          if (!avatarCharacterModels) throw new Error('3D models are unavailable.');
          return pickSingleImageGeometry(avatarCharacterModels);
        },
      },
      onRoomUpdated: (roomId) => {
        broadcastToWindows('rooms:updated', roomId);
        stationRegistry?.clearLabels();
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
        isAvailable: async (): Promise<boolean> =>
          (backgroundComfy ?? fallbackComfy)?.isAvailable() ?? false,
        run: (graph: unknown, options?: { signal?: AbortSignal }) =>
          (backgroundComfy ?? fallbackComfy).run(graph as ComfyGraph, options),
      },
      ensureComfyReady: async () => {
        backgroundComfy = await comfyPool.pick('image');
      },
    });
    furnitureService = new FurnitureService({
      store: memoryStore,
      directory: path.join(app.getPath('userData'), 'furniture'),
      pickComfy: (stage) => comfyPool.pick(stage),
      imageModel: () => {
        if (!avatarImageModels) throw new Error('Image models are unavailable.');
        return avatarImageModels.resolveObjectModel();
      },
      geometryModel: () => {
        if (!avatarCharacterModels) throw new Error('3D models are unavailable.');
        return pickSingleImageGeometry(avatarCharacterModels);
      },
      paint: (input) => characterRunner.paintViews(input),
      // Sizes and names the piece with the 'describe' helper; the keyword table answers when there is none.
      // The describe route is usually the on-demand local vision server: start it first, as avatar descriptions do.
      askHelper: (system, user) =>
        withVision(manager, 'describe', async () => {
          const target = helperTarget(manager, 'describe');
          if (!target) return null;
          const response = await (
            target.client as unknown as {
              responses: { create: (args: unknown) => Promise<{ output_text: string }> };
            }
          ).responses.create({
            model: target.model ?? 'gpt-4.1-mini',
            instructions: system,
            input: user,
            max_output_tokens: 300,
            temperature: 0.2,
          });
          return response?.output_text ?? null;
        }),
      onChanged: (item) => broadcastToWindows('furniture:changed', item),
      logger,
    });
    furnitureService.initialize().catch((error: unknown) => {
      logger.warn('Furniture service initialization failed.', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    setupStations(memoryStore);
    setupPursuits(memoryStore);
  }

  await applyProviderSettings(manager);
  // After the config is loaded: the lease asks for the Thinking model picked there.
  void aicontroller.start();

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

  // Opt-in: an installed copy on a shared PC should not start itself at every sign-in, and the portable exe
  // unpacks to a temp folder, so a start-up entry pointing at it would break. ENABLE_AUTO_LAUNCH=1 turns it on.
  const shouldEnableAutoLaunch = process.env.ENABLE_AUTO_LAUNCH === '1';
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
        handle: handleIpc,
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
      error instanceof Error
        ? error.message
        : 'Unknown renderer bootstrap error occurred while creating the window.';
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
  agentActHandler?.stop();
  agentSync?.stop();
  activityMonitor?.stop();
  satelliteActivity?.stop();
  nextDoorReturn?.stop();
  void satelliteWake?.dispose();
  void roomHub?.stop();
  satellite?.stop();
  satelliteDevices?.stop();
  for (const { inbox } of avatarPlumbing.values()) inbox.stop();
  await pursuitManager?.stopAll().catch(() => undefined);
  void switchboardClient?.stop();

  // Stop MCP programs this app started (stdio servers) so none is left running.
  await mcpManager?.disconnectAll().catch((error) => {
    logger.warn('Failed to disconnect MCP servers during shutdown', {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  // Give the model controller its leases back.
  await aicontroller.shutdown().catch((error) => {
    logger.warn('Failed to release model controller leases during shutdown', {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  // Stop the local servers this app started, as hibernation does.
  if (serverManager) {
    await serverManager.shutdown().catch((error) => {
      logger.warn('Failed to stop servers during shutdown', {
        message: error instanceof Error ? error.message : String(error),
      });
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
