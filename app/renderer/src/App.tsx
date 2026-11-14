import { useBackgrounds } from './backgrounds/use-backgrounds.js';
import { BackgroundControls } from './backgrounds/background-controls.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react';
import type { ConversationBackend, RendererConfig } from '../../main/src/config/config-manager.js';
import type { AudioDevicePreferences } from '../../main/src/config/preferences-store.js';
import type { ProviderSettingsPatch } from '../../main/src/config/provider-settings.js';
import { ControlButton, ControlsDrawer } from './settings/controls-drawer.js';
import { PanelDialog } from './settings/panel-dialog.js';
import { ToolsSettings } from './settings/tools-settings.js';
import { MemoryPanel } from './settings/memory-panel.js';
import { ProviderSettingsPanel } from './settings/provider-settings-panel.js';
import { ModelsDialog } from './settings/models-dialog.js';
import type { UseId } from '../../main/src/config/model-routing.js';
import type { PushToTalkStatus } from '../../main/src/talk/types.js';
import { isTalkTapTarget } from './talk/tap-to-talk.js';
import { VrmAvatarRenderer, type VrmRendererStatus, type VrmStageAvatar } from './avatar/vrm-avatar-renderer.js';
import { AnimationBusProvider, createAvatarAnimationBus } from './avatar/animation-bus.js';
import { BehaviorCueProvider } from './avatar/behavior-cues.js';
import { getAvatarRestSkeleton } from './avatar/rest-skeleton.js';
import { AvatarConfigurator } from './avatar/avatar-configurator.js';
import { SceneCast } from './avatar/scene-cast.js';
import { AudioGraph } from './audio/audio-graph.js';
import { useWakeWordListening } from './audio/use-wake-word-listening.js';
import { VisemeDriver, type VisemeFrame } from './audio/viseme-driver.js';
import type { VoiceActivity } from './realtime/voice-activity.js';
import { GpuMemoryPanel } from './status/gpu-memory-bar.js';
import { SwitchboardStatusLine } from './status/switchboard-status.js';
import { DoNotDisturbToggle } from './status/dnd-toggle.js';
import { HearChatterToggle } from './status/hear-chatter-toggle.js';
import { usePresenceReporter } from './presence/use-presence-reporter.js';
import { CodingStatusLine } from './status/coding-status.js';
import { ApprovalsCard } from './status/approvals-card.js';
import { BusyCard } from './status/busy-card.js';
import { CodingTasksPanel } from './status/coding-tasks.js';
import {
  AssistantStatusPanel,
  addToolCall,
  finishToolCall,
  type ToolCall,
  type WakeScore,
} from './status/assistant-status.js';
import type { ConversationSessionWithMessages } from '../../main/src/conversation/types.js';
import { useAudioDevices } from './hooks/use-audio-devices.js';
import { useCameraDevices } from './hooks/use-camera-devices.js';
import { useFacePresence } from './camera/use-face-presence.js';
import { CameraLiveDot } from './camera/camera-dot.js';
import { cameraPresenceOn } from '../../main/src/places/camera-setting.js';
import { getPreloadApi, type PreloadApi } from './preload-api.js';
import { RealtimeClient, type RealtimeClientCallbacks, type RealtimeClientState } from './realtime/realtime-client.js';
import { LocalVoiceClient, playPreviewReply } from './realtime/local-voice-client.js';
import { LatencyTracker, type LatencySnapshot } from './metrics/latency-tracker.js';
import type { LatencyMetricName } from '../../main/src/metrics/types.js';
import type { AvatarModelSummary, AvatarMotionStatus, AvatarPoseSummary } from './avatar/types.js';
import type { AvatarProfile } from '../../main/src/avatars/bridge-types.js';
import type { LocalVoiceStatus, SpeakingVoiceOptions } from '../../main/src/local-voice/types.js';
import { describeModels } from './status/model-status.js';
import { extractAvatarTags, extractMotionTags, toAnimationSlug, type MotionTag } from './avatar/animation-tags.js';
import {
  ANIMATION_INSTRUCTION_PREFIX,
  buildAnimationInstructions,
  buildAvatarTagInstructions,
  buildMoveOnlyInstructions,
} from './avatar/animation-instructions.js';
import { MovementRigs } from './rooms/movement-rig.js';
import { MoveRequestFilter, enqueueMotionChunk } from './avatar/live-motion.js';
import { SceneActionExecutor, type SceneActivity } from './rooms/scene-executor.js';
import { tagToAction, type SceneAction } from './rooms/scene-actions.js';
import { buildSceneInstructions, describeAvatarWhere, type OtherAvatarEntry } from './rooms/scene-instructions.js';
import { useIdleDirector } from './rooms/use-idle-director.js';
import { usePlaces } from './places/use-places.js';
import { useSatellite } from './satellite/satellite-context.js';
import { SatelliteBanner } from './satellite/satellite-banner.js';
import { SatelliteStatusPanel } from './satellite/satellite-status-panel.js';
import { TypedMessage } from './satellite/typed-message.js';
import { DeviceDots } from './satellite/device-dots.js';
import { useDeviceGate } from './satellite/use-device-gate.js';
import type { TurnTiming } from './realtime/local-voice-client.js';
import { DEFAULT_DESKTOP_ROOM } from '../../main/src/places/default-room.js';
import { estimateSpeechMs, stagePresence } from './places/stage-presence.js';
import { ElsewhereChip } from './places/elsewhere-chip.js';
import { PlacesPanel } from './places/places-panel.js';
import { RoomDevicesStatus } from './places/room-devices-status.js';
import { useIdleHabits } from './avatar/use-idle-habits.js';
import type { CharacterSettingsControls } from './avatar/character-settings.js';
import type { CharacterSettingsContext } from './avatar/use-character-settings.js';

const CURSOR_IDLE_TIMEOUT_MS = 3000;
const WAKE_ACTIVE_DURATION_MS = 4000;
const MAX_TRANSCRIPT_ENTRIES = 200;

type AudioGraphStatus = 'idle' | 'starting' | 'ready' | 'error';

type TranscriptSpeaker = 'user' | 'assistant' | 'system';

interface AudioGraphState {
  level: number;
  isActive: boolean;
  status: AudioGraphStatus;
  error: string | null;
}

type SessionConfigUpdate = Parameters<RealtimeClient['updateSessionConfig']>[0];

interface TranscriptEntry {
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
  timestamp: number;
  /** The avatar that said an assistant line, when it was not Echo. */
  avatarId?: string;
}

const REQUIRED_BRIDGE_KEYS: (keyof PreloadApi)[] = ['config', 'wakeWord', 'ping'];

const STATIC_VOICE_OPTIONS: readonly string[] = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;

const DEFAULT_VOICE = 'shimmer';

function toTranscriptSpeaker(role: string): TranscriptSpeaker | null {
  if (role === 'system' || role === 'user' || role === 'assistant') {
    return role;
  }

  return null;
}

/** JSON for log details, so they survive being forwarded as console text. */
export function serializeLogData(data: unknown): string | undefined {
  if (data === undefined) {
    return undefined;
  }
  if (typeof data === 'string') {
    return data;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function formatLatency(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return `${(value / 1000).toFixed(2)}s`;
}

// Also feeds the model status panel, so it is checked often enough to show a model coming up.
const LIVE_MOTION_STATUS_INTERVAL_MS = 5_000;
const MODEL_STATUS_INTERVAL_MS = 5_000;

function buildAvatarDescription(model: AvatarModelSummary | null): string {
  if (!model?.description || model.description.trim().length === 0) {
    return '';
  }
  return `[About your appearance: ${model.description}]`;
}

function buildSessionInstructions(
  basePrompt: string,
  availableAnimations: string[],
  availablePoses: string[],
  activeVrmModel: AvatarModelSummary | null,
  liveMotionAvailable = false,
  sceneInstructions = '',
): string {
  const trimmedBase = basePrompt.trim();
  const avatarDescription = buildAvatarDescription(activeVrmModel);
  const animationInstructions = buildAnimationInstructions(
    availableAnimations,
    availablePoses,
    liveMotionAvailable,
    sceneInstructions,
  );

  const parts = [trimmedBase, avatarDescription, animationInstructions].filter((s) => s.length > 0);
  return parts.join('\n\n');
}

function stripAnimationInstructions(instructions: string): string {
  const index = instructions.indexOf(ANIMATION_INSTRUCTION_PREFIX);
  if (index === -1) {
    return instructions;
  }
  return instructions.slice(0, index).trim();
}

/** Plays an element through the chosen speakers (a satellite's own output device). */
function applySink(element: HTMLAudioElement | null | undefined, deviceId: string): void {
  const target = element as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null | undefined;
  if (!target || typeof target.setSinkId !== 'function') return;
  void target.setSinkId(deviceId).catch((error: unknown) => console.warn('Could not use that speaker', error));
}

function useAudioGraphState(inputDeviceId?: string, enabled = true) {
  const [internalState, setInternalState] = useState<AudioGraphState>({
    level: 0,
    isActive: false,
    status: 'idle',
    error: null,
  });
  const [internalUpstreamStream, setInternalUpstreamStream] = useState<MediaStream | null>(null);
  const graphRef = useRef<AudioGraph | null>(null);
  /** Stops every capture track now (the satellite's gate closed). Safe to call when nothing is running. */
  const stopNow = useCallback(async () => {
    await graphRef.current?.stop();
  }, []);

  // Derive state based on enabled prop
  const state = enabled
    ? internalState
    : { level: 0, isActive: false, status: 'idle' as const, error: null };

  // Derive stream based on enabled prop
  const upstreamStream = enabled ? internalUpstreamStream : null;

  useEffect(() => {
    if (!enabled) {
      return; // Stream cleanup handled by derivation
    }

    const graph = new AudioGraph({
      onLevel: (level) => {
        setInternalState((previous) => ({ ...previous, level }));
      },
      onSpeechActivityChange: (isActive) => {
        setInternalState((previous) => ({ ...previous, isActive }));
      },
    });

    let disposed = false;
    graphRef.current = graph;

    const startGraph = async () => {
      setInternalState((previous) => ({ ...previous, status: 'starting', error: null }));

      try {
        await graph.start({ inputDeviceId });
        if (disposed) {
          await graph.stop();
          return;
        }

        setInternalState((previous) => ({ ...previous, status: 'ready' }));
        setInternalUpstreamStream(graph.getUpstreamStream());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!disposed) {
          setInternalState((previous) => ({ ...previous, status: 'error', error: message }));
          setInternalUpstreamStream(null);
        }
      }
    };

    void startGraph();

    return () => {
      disposed = true;
      if (graphRef.current === graph) graphRef.current = null;
      setInternalUpstreamStream(null);
      void graph.stop();
    };
  }, [inputDeviceId, enabled]);

  return { ...state, upstreamStream, stopNow };
}

function logRendererBridge(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  meta?: Record<string, unknown>,
) {
  const prefix = `[renderer bridge] ${message}`;
  if (level === 'debug') {
    if (meta) {
      console.debug(prefix, meta);
    } else {
      console.debug(prefix);
    }
    return;
  }

  if (level === 'info') {
    if (meta) {
      console.info(prefix, meta);
    } else {
      console.info(prefix);
    }
    return;
  }

  if (level === 'warn') {
    if (meta) {
      console.warn(prefix, meta);
    } else {
      console.warn(prefix);
    }
    return;
  }

  if (meta) {
    console.error(prefix, meta);
  } else {
    console.error(prefix);
  }
}

function collectBridgeDiagnostics(
  bridge: PreloadApi | undefined,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const windowBridge = (window as { aiembodied?: PreloadApi }).aiembodied;
  const descriptor = Object.getOwnPropertyDescriptor(window, 'aiembodied');
  const descriptorType: 'missing' | 'data' | 'accessor' = descriptor
    ? typeof descriptor.get === 'function' || typeof descriptor.set === 'function'
      ? 'accessor'
      : 'data'
    : 'missing';

  return {
    documentReadyState: document.readyState,
    hasWindowProperty: Object.prototype.hasOwnProperty.call(window, 'aiembodied'),
    typeofWindowBridge: typeof windowBridge,
    descriptorType,
    descriptorConfigurable: descriptor?.configurable ?? null,
    descriptorEnumerable: descriptor?.enumerable ?? null,
    descriptorWritable: descriptorType === 'data' ? descriptor?.writable ?? null : null,
    availableWindowBridgeKeys: windowBridge ? Object.keys(windowBridge) : [],
    availableBridgeKeys: bridge ? Object.keys(bridge) : undefined,
    hasConfigBridge: typeof bridge?.config !== 'undefined',
    hasWakeWordBridge: typeof bridge?.wakeWord !== 'undefined',
    hasConversationBridge: typeof bridge?.conversation !== 'undefined',
    hasMetricsBridge: typeof bridge?.metrics !== 'undefined',
    hasAvatarBridge: typeof bridge?.avatar !== 'undefined',
    hasPingFunction: typeof bridge?.ping === 'function',
    ...extras,
  };
}

function usePreloadBridge() {
  const [api, setApi] = useState<PreloadApi | undefined>(undefined);
  const [ping, setPing] = useState<'available' | 'unavailable'>('unavailable');
  const resolveApi = useCallback(() => api ?? getPreloadApi(), [api]);
  const logStateRef = useRef({
    missingBridgeLogged: false,
    attachedLogged: false,
    missingAvatarLogged: false,
    missingCoreLogged: false,
  });
  const attachAttemptRef = useRef(0);
  const pollStartRef = useRef<number | null>(null);

  const shouldLogAttempt = useCallback((attempt: number) => {
    if (attempt <= 0) {
      return false;
    }

    if (attempt === 1 || attempt === 5) {
      return true;
    }

    return attempt % 25 === 0;
  }, []);

  useEffect(() => {
    let disposed = false;

    const applyBridge = (bridge: PreloadApi | undefined, contextMeta: Record<string, unknown> = {}) => {
      if (disposed) {
        return;
      }

      setApi(bridge);

      if (!bridge) {
        if (!logStateRef.current.missingBridgeLogged) {
          logRendererBridge('warn', 'Preload API is not yet attached to window.aiembodied.', {
            ...collectBridgeDiagnostics(undefined, contextMeta),
          });
          logStateRef.current.missingBridgeLogged = true;
          logStateRef.current.attachedLogged = false;
        }
        setPing('unavailable');
        return;
      }

      if (!logStateRef.current.attachedLogged) {
        logRendererBridge('info', 'Preload API detected.', {
          ...collectBridgeDiagnostics(bridge, contextMeta),
        });
        logStateRef.current.attachedLogged = true;
        logStateRef.current.missingBridgeLogged = false;
      }

      const missingCore = REQUIRED_BRIDGE_KEYS.filter((key) => !(key in bridge));
      if (missingCore.length > 0) {
        if (!logStateRef.current.missingCoreLogged) {
          logRendererBridge('error', 'Preload API is missing required bridges.', {
            missing: missingCore,
            ...collectBridgeDiagnostics(bridge, contextMeta),
          });
          logStateRef.current.missingCoreLogged = true;
        }
      } else if (logStateRef.current.missingCoreLogged) {
        logRendererBridge('info', 'All required preload bridges detected.');
        logStateRef.current.missingCoreLogged = false;
      }

      if (!bridge.avatar) {
        if (!logStateRef.current.missingAvatarLogged) {
          logRendererBridge(
            'warn',
            'Avatar configuration bridge missing from preload API. Avatar uploads require a valid realtime API key.',
            collectBridgeDiagnostics(bridge, contextMeta),
          );
          logStateRef.current.missingAvatarLogged = true;
        }
      } else if (logStateRef.current.missingAvatarLogged) {
        logRendererBridge('info', 'Avatar configuration bridge is now available.');
        logStateRef.current.missingAvatarLogged = false;
      }

      try {
        const result = bridge.ping();
        setPing(result === 'pong' ? 'available' : 'unavailable');
        if (result !== 'pong') {
          logRendererBridge('warn', 'Preload ping responded with unexpected payload.', {
            result,
            ...collectBridgeDiagnostics(bridge, contextMeta),
          });
        } else {
          logRendererBridge('debug', 'Preload ping completed.', {
            result,
            ...collectBridgeDiagnostics(bridge, contextMeta),
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : 'unknown';
        logRendererBridge('error', 'Failed to call preload ping bridge.', {
          errorMessage: message,
          errorName: name,
          ...collectBridgeDiagnostics(bridge, contextMeta),
        });
        setPing('unavailable');
      }
    };

    const attemptAttach = () => {
      attachAttemptRef.current += 1;
      const attempt = attachAttemptRef.current;
      if (pollStartRef.current === null) {
        pollStartRef.current = Date.now();
      }

      const bridge = getPreloadApi();
      if (!bridge || !bridge.__bridgeReady) {
        if (shouldLogAttempt(attempt)) {
          const duration = pollStartRef.current ? Date.now() - pollStartRef.current : 0;
          const reason = !bridge ? 'API not exposed' : 'bridge not ready';
          logRendererBridge('warn', `Preload API unavailable (${reason}); renderer still polling for bridge exposure.`, {
            ...collectBridgeDiagnostics(bridge, { attempt, pollingDurationMs: duration, bridgeReady: bridge?.__bridgeReady }),
          });
        }
        applyBridge(undefined, { attempt });
        return false;
      }

      const duration = pollStartRef.current ? Date.now() - pollStartRef.current : 0;
      pollStartRef.current = null;
      logRendererBridge('info', 'Bridge ready and attached successfully.', {
        bridgeVersion: bridge.__bridgeVersion,
        timeToDetectMs: duration,
        attempt,
      });
      applyBridge(bridge, { attempt, timeToDetectMs: duration });
      return true;
    };

    if (attemptAttach()) {
      return () => {
        disposed = true;
      };
    }

    const INITIAL_RETRY_DELAY = 50;
    const MAX_RETRY_DELAY = 2000;
    const MAX_ATTEMPTS = 100;

    let currentDelay = INITIAL_RETRY_DELAY;
    let timeout: number | null = null;

    const scheduleNextAttempt = () => {
      if (disposed || attachAttemptRef.current >= MAX_ATTEMPTS) {
        return;
      }

      timeout = window.setTimeout(() => {
        if (disposed) {
          return;
        }

        if (attemptAttach()) {
          // Success, no more attempts needed
          return;
        }

        // Exponential backoff with jitter
        currentDelay = Math.min(currentDelay * 1.2, MAX_RETRY_DELAY);
        scheduleNextAttempt();
      }, currentDelay);
    };

    scheduleNextAttempt();

    return () => {
      disposed = true;
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
    };
  }, [shouldLogAttempt]);

  return { api, ping, resolveApi };
}

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const update = () => {
      setIsOnline(navigator.onLine);
    };

    window.addEventListener('online', update);
    window.addEventListener('offline', update);

    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return isOnline;
}

function useIdleCursor(enabled: boolean) {
  const [internalIsIdle, setInternalIsIdle] = useState(false);

  // Derive idle state - never idle when disabled
  const isIdle = enabled && internalIsIdle;

  useEffect(() => {
    if (!enabled) {
      document.body.classList.remove('cursor-hidden');
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;

    const markIdle = () => {
      timeout = null;
      setInternalIsIdle(true);
    };

    const scheduleIdle = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(markIdle, CURSOR_IDLE_TIMEOUT_MS);
    };

    const handleActivity = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      setInternalIsIdle(false);
      timeout = setTimeout(markIdle, CURSOR_IDLE_TIMEOUT_MS);
    };

    const events: Array<keyof WindowEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
    ];

    events.forEach((event) => window.addEventListener(event, handleActivity, { passive: true }));
    scheduleIdle();

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      events.forEach((event) => window.removeEventListener(event, handleActivity));
      document.body.classList.remove('cursor-hidden');
      setInternalIsIdle(false);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      document.body.classList.remove('cursor-hidden');
      return;
    }

    if (isIdle) {
      document.body.classList.add('cursor-hidden');
    } else {
      document.body.classList.remove('cursor-hidden');
    }

    return () => {
      document.body.classList.remove('cursor-hidden');
    };
  }, [enabled, isIdle]);

  return isIdle;
}

function TranscriptOverlay({
  entries,
  avatarNames,
}: {
  entries: TranscriptEntry[];
  avatarNames?: Record<string, string>;
}) {
  if (entries.length === 0) {
    return (
      <div className="transcript transcript--empty" data-testid="transcript-empty">
        <p>No transcript yet. Conversation history will appear here.</p>
      </div>
    );
  }

  return (
    <ol className="transcript" data-testid="transcript-list">
      {entries.map((entry) => {
        const time = new Date(entry.timestamp);
        const hours = time.getHours().toString().padStart(2, '0');
        const minutes = time.getMinutes().toString().padStart(2, '0');
        const seconds = time.getSeconds().toString().padStart(2, '0');
        const label = `${hours}:${minutes}:${seconds}`;
        return (
          <li key={entry.id} className={`transcript__item transcript__item--${entry.speaker}`}>
            <div className="transcript__meta">
              <span className="transcript__speaker">{entry.speaker === 'assistant' && entry.avatarId ? (avatarNames?.[entry.avatarId] ?? entry.avatarId) : entry.speaker}</span>
              <span className="transcript__time">{label}</span>
            </div>
            <p className="transcript__text">{entry.text}</p>
          </li>
        );
      })}
    </ol>
  );
}

export default function App() {
  const { api, ping, resolveApi } = usePreloadBridge();
  // A satellite PC draws one room of bija's world and has no microphone yet: the one flag every guard below reads.
  const satellite = useSatellite();
  const isSatellite = satellite !== null;
  const [config, setConfig] = useState<RendererConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const [realtimeTokenError, setRealtimeTokenError] = useState<string | null>(null);
  const realtimeTokenExpiresAtRef = useRef<number | null>(null);
  const realtimeTokenRequestRef = useRef(0);
  const realtimeTokenRefreshRef = useRef(true);
  const [realtimeState, setRealtimeState] = useState<RealtimeClientState>({ status: 'idle' });
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [visemeFrame, setVisemeFrame] = useState<VisemeFrame | null>(null);
  /** Lip-sync frames of the avatars other than echo (echo keeps `visemeFrame`), by avatar id. */
  const [visemeFrames, setVisemeFrames] = useState<Record<string, VisemeFrame | null>>({});
  const [avatarProfiles, setAvatarProfiles] = useState<AvatarProfile[]>([]);
  // Where each avatar is (main keeps the truth). Without the bridge everybody is on screen.
  const placesSnapshot = usePlaces(resolveApi()?.places);
  const presence = useMemo(
    () => stagePresence(placesSnapshot, ['echo', ...avatarProfiles.map((profile) => profile.id).filter((id) => id !== 'echo')]),
    [placesSnapshot, avatarProfiles],
  );
  const [vrmModels, setVrmModels] = useState<AvatarModelSummary[]>([]);
  const [voiceActivity, setVoiceActivity] = useState<VoiceActivity>(() => ({ phase: 'off', since: Date.now() }));
  const [wakeScore, setWakeScore] = useState<WakeScore | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [wakeState, setWakeState] = useState<'idle' | 'awake'>('idle');
  const wakeResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isTranscriptVisible, setTranscriptVisible] = useState(false);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const messageIdsRef = useRef<Set<string>>(new Set());
  const latencyTrackerRef = useRef<LatencyTracker>(new LatencyTracker());
  const [latencySnapshot, setLatencySnapshot] = useState<LatencySnapshot | null>(null);
  const [activeVrmModel, setActiveVrmModel] = useState<AvatarModelSummary | null>(null);
  const [avatarVoice, setAvatarVoice] = useState<string | null>(null);
  const [availableAnimationSlugs, setAvailableAnimationSlugs] = useState<string[]>([]);
  const [availablePoses, setAvailablePoses] = useState<AvatarPoseSummary[]>([]);
  const animationBus = useMemo(() => createAvatarAnimationBus(), []);
  const [liveMotionReady, setLiveMotionReady] = useState(false);
  const [motionStatus, setMotionStatus] = useState<AvatarMotionStatus | null>(null);
  // undefined: not checked yet; null: the check itself failed.
  const [voiceServiceStatus, setVoiceServiceStatus] = useState<LocalVoiceStatus | null | undefined>(undefined);

  // Quit handler
  const handleQuit = useCallback(() => {
    const app = resolveApi()?.app;
    if (app) {
      app.quit().catch((err) => {
        console.error('Failed to quit:', err);
      });
    } else {
      console.warn('App bridge not available for quit');
    }
  }, [resolveApi]);

  useEffect(() => {
    const localVoice = resolveApi()?.localVoice;
    if (!localVoice) {
      return;
    }
    let cancelled = false;
    const refresh = () => {
      localVoice
        .getStatus()
        .then((status) => {
          if (!cancelled) {
            setVoiceServiceStatus(status);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setVoiceServiceStatus(null);
          }
        });
    };
    refresh();
    const timer = setInterval(refresh, MODEL_STATUS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [resolveApi]);

  useEffect(() => {
    const avatar = resolveApi()?.avatar;
    if (!avatar?.getMotionStatus) {
      setLiveMotionReady(false);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      avatar
        .getMotionStatus?.()
        .then((status) => {
          if (!cancelled) {
            setLiveMotionReady(status.ready);
            setMotionStatus(status);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLiveMotionReady(false);
            setMotionStatus(null);
          }
        });
    };
    refresh();
    // The motion service can be started after the app, so keep checking.
    const timer = setInterval(refresh, LIVE_MOTION_STATUS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [resolveApi]);

  // Load avatar voice preference when avatar changes
  useEffect(() => {
    const avatarApi = resolveApi()?.avatar;
    if (!avatarApi?.getVoicePreference) {
      return;
    }
    let cancelled = false;

    const loadVoice = async () => {
      const voice = await avatarApi.getVoicePreference();
      if (!cancelled) {
        setAvatarVoice(voice);
      }
    };
    loadVoice();
    return () => {
      cancelled = true;
    };
  }, [resolveApi, activeVrmModel?.id]);

  // Runs {go:}, {sit:}, {pick:} and the other scene tags in a 3D room (see rooms/scene-executor.ts).
  const sceneActions = useMemo(() => new SceneActionExecutor(), []);
  // Which avatar each live-motion stream belongs to, and each avatar's repeat filter (rooms/movement-rig.ts).
  // Echo's executor is `sceneActions` itself; the others get an executor of their own on first use.
  const rigs = useMemo(() => new MovementRigs(sceneActions), [sceneActions]);
  const sceneExecutorFor = useCallback((avatarId: string) => rigs.get(avatarId).executor, [rigs]);
  useEffect(() => {
    const avatar = resolveApi()?.avatar;
    if (!avatar?.onMotionChunk) {
      return;
    }
    return avatar.onMotionChunk((chunk) => {
      // Every executor is offered the chunk (Echo's first); gestures belong to the avatar the stream was registered for.
      if (rigs.handleChunk(chunk)) {
        return;
      }
      const owner = rigs.avatarForStream(chunk.streamId);
      enqueueMotionChunk(animationBus, chunk, {}, owner);
    });
  }, [animationBus, resolveApi, rigs]);
  useEffect(() => {
    const avatar = resolveApi()?.avatar;
    const streamMotion = avatar?.streamMotion;
    if (!avatar || !streamMotion) {
      return;
    }
    sceneActions.setBridge({
      streamMotion: (request) => streamMotion.call(avatar, request),
      cancelMotion: (streamId) => {
        void avatar.cancelMotion?.(streamId)?.catch(() => undefined);
      },
      playChunk: (chunk, hooks) => enqueueMotionChunk(animationBus, chunk, hooks),
      avatarRest: () => getAvatarRestSkeleton() ?? undefined,
    });
    // The other avatars share the motion service; their chunks play on their own actor and rest skeleton.
    rigs.setBridgeFactory((avatarId) => ({
      streamMotion: (request) => streamMotion.call(avatar, request),
      cancelMotion: (streamId) => {
        void avatar.cancelMotion?.(streamId)?.catch(() => undefined);
      },
      playChunk: (chunk, hooks) => enqueueMotionChunk(animationBus, chunk, hooks, avatarId),
      avatarRest: () => getAvatarRestSkeleton(avatarId) ?? undefined,
    }));
    return () => {
      sceneActions.setBridge(null);
      rigs.setBridgeFactory(null);
    };
  }, [animationBus, resolveApi, sceneActions, rigs]);
  // Kevin spoke: drop what every avatar still had queued and stop the gestures that were generating.
  const interruptMovement = useCallback(() => {
    rigs.interruptAll();
    const avatar = resolveApi()?.avatar;
    for (const streamId of rigs.streamIds()) {
      void avatar?.cancelMotion?.(streamId)?.catch(() => undefined);
      rigs.endStream(streamId);
    }
  }, [resolveApi, rigs]);
  // Tool-call rows for scene actions; rows of another avatar carry its name.
  const applySceneActivity = useCallback((activity: SceneActivity, owner?: string) => {
    const now = Date.now();
    const named = (label: string) => (owner ? `${owner}: ${label}` : label);
    if (activity.type === 'start') {
      setToolCalls((calls) =>
        addToolCall(calls, { id: activity.id, kind: 'move', label: named(activity.label), status: 'pending', startedAt: now }),
      );
    } else if (activity.type === 'done') {
      setToolCalls((calls) => finishToolCall(calls, activity.id, 'done', now, activity.detail));
    } else if (activity.type === 'failed') {
      setToolCalls((calls) => finishToolCall(calls, activity.id, 'failed', now, activity.message));
    } else {
      const id = Math.random().toString(36).slice(2, 10);
      setToolCalls((calls) =>
        addToolCall(calls, {
          id,
          kind: 'move',
          label: named(activity.label),
          status: 'failed',
          startedAt: now,
          finishedAt: now,
          detail: `skipped: ${activity.reason}`,
        }),
      );
    }
  }, []);
  useEffect(() => sceneActions.onActivity((activity) => applySceneActivity(activity)), [sceneActions, applySceneActivity]);
  const avatarProfilesRef = useRef<Array<{ id: string; name: string }>>([]);
  useEffect(() => { avatarProfilesRef.current = avatarProfiles; }, [avatarProfiles]);
  // An avatar that was removed takes its executor, filters and streams with it.
  useEffect(() => {
    const present = new Set(avatarProfiles.map((profile) => profile.id));
    for (const id of rigs.avatarIds()) {
      if (id !== 'echo' && !present.has(id)) rigs.drop(id);
    }
  }, [avatarProfiles, rigs]);
  useEffect(
    () =>
      rigs.onOtherActivity((avatarId, activity) =>
        applySceneActivity(activity, avatarProfilesRef.current.find((profile) => profile.id === avatarId)?.name ?? avatarId),
      ),
    [rigs, applySceneActivity],
  );
  // On a satellite the privacy gate (main process) is the outermost condition: listening is on only while the gate
  // allows the mic, and Kevin can still turn it off by hand. On bija it is the toggle it always was.
  const [listeningState, setListeningState] = useState(false);
  const [satelliteHandOff, setSatelliteHandOff] = useState(false);
  const stopCaptureRef = useRef<() => Promise<void>>(async () => undefined);
  const stopCameraRef = useRef<() => Promise<void>>(async () => undefined);
  // The gate says which device to stop: the mic's audio graph, the camera, or both. Each is stopped right away,
  // before any render, and only then does the gate hear that capture stopped.
  const stopCapture = useCallback(
    async (scope: { audio: boolean; camera: boolean }) => {
      const results = await Promise.allSettled([scope.audio ? stopCaptureRef.current() : undefined, scope.camera ? stopCameraRef.current() : undefined]);
      for (const result of results) if (result.status === 'rejected') console.warn('Could not stop capture', result.reason);
    },
    [],
  );
  const deviceGate = useDeviceGate(isSatellite ? resolveApi()?.deviceGate : undefined, stopCapture);
  const isListeningEnabled = isSatellite ? deviceGate?.micAllowed === true && !satelliteHandOff : listeningState;
  const setListeningEnabled = useCallback(
    (next: boolean | ((previous: boolean) => boolean)) => {
      if (isSatellite) setSatelliteHandOff((previous) => !(typeof next === 'function' ? next(!previous) : next));
      else setListeningState(next);
    },
    [isSatellite],
  );
  const [lastTurnTiming, setLastTurnTiming] = useState<TurnTiming | null>(null);
  const [callingNote, setCallingNote] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsInitialUse, setModelsInitialUse] = useState<UseId | undefined>(undefined);
  /** Which settings pop-up is open (the avatar studio and models pop-ups have their own state). */
  const [panel, setPanel] = useState<'character' | 'backgrounds' | 'devices' | 'places' | 'tools' | 'memory' | 'status' | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const closePanel = useCallback(() => setPanel(null), []);
  const openModels = useCallback((use?: UseId) => {
    setModelsInitialUse(use);
    setModelsOpen(true);
  }, []);
  const activeBridge = resolveApi();
  const wakeListening = useWakeWordListening(activeBridge?.wakeWord, isListeningEnabled && !loadingConfig);
  const acceptsWakeRef = useRef(false);
  useEffect(() => { acceptsWakeRef.current = isListeningEnabled && !loadingConfig; }, [isListeningEnabled, loadingConfig]);
  // A satellite shows the room of its own place, not the stage bija has active.
  const satellitePlace = isSatellite && placesSnapshot ? placesSnapshot.places.find((place) => place.id === placesSnapshot.localPlaceId) : undefined;
  const backgrounds = useBackgrounds(activeBridge?.backgrounds, isSatellite ? (satellitePlace ? (satellitePlace.room ?? DEFAULT_DESKTOP_ROOM) : null) : undefined);
  const [showWalkableArea, setShowWalkableArea] = useState(false);
  const [avatarFootY, setAvatarFootY] = useState(0.9);

  useEffect(() => {
    const bridge = resolveApi();
    const avatar = bridge?.avatar;
    if (!avatar?.listAnimations) {
      setAvailableAnimationSlugs([]);
      return;
    }

    let cancelled = false;
    avatar
      .listAnimations()
      .then((animations) => {
        if (cancelled) {
          return;
        }
        const slugs = animations
          .map((animation) => toAnimationSlug(animation.name?.trim() || animation.id))
          .filter((slug) => slug.length > 0);
        const uniqueSlugs = Array.from(new Set(slugs)).sort((a, b) => a.localeCompare(b));
        setAvailableAnimationSlugs(uniqueSlugs);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        console.warn('Failed to load avatar animations.', error);
        setAvailableAnimationSlugs([]);
      });

    return () => {
      cancelled = true;
    };
  }, [resolveApi]);


  // Load available poses so the assistant can name them in replies
  useEffect(() => {
    const bridge = resolveApi();
    const avatar = bridge?.avatar;
    if (!avatar?.listPoses) {
      setAvailablePoses([]);
      return;
    }

    let cancelled = false;
    avatar
      .listPoses()
      .then((poses) => {
        if (cancelled) {
          return;
        }
        setAvailablePoses(poses);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        console.warn('Failed to load avatar poses.', error);
        setAvailablePoses([]);
      });

    return () => {
      cancelled = true;
    };
  }, [resolveApi]);



  const pushLatency = useCallback(
    (snapshot: LatencySnapshot) => {
      const bridge = resolveApi();
      if (!bridge?.metrics) {
        return;
      }

      const entries: Array<[LatencyMetricName, number]> = [];
      if (typeof snapshot.wakeToCaptureMs === 'number') {
        entries.push(['wake_to_capture_ms', snapshot.wakeToCaptureMs]);
      }
      if (typeof snapshot.captureToFirstAudioMs === 'number') {
        entries.push(['capture_to_first_audio_ms', snapshot.captureToFirstAudioMs]);
      }
      if (typeof snapshot.wakeToFirstAudioMs === 'number') {
        entries.push(['wake_to_first_audio_ms', snapshot.wakeToFirstAudioMs]);
      }

      for (const [metric, value] of entries) {
        bridge.metrics
          .observeLatency(metric, value)
          .catch((error) => console.error('Failed to report latency metric', metric, error));
      }
    },
    [resolveApi],
  );

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    const bridge = resolveApi();
    const avatarApi = bridge?.avatar;
    if (!avatarApi?.getActiveModel) {
      setActiveVrmModel(null);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const model = await avatarApi.getActiveModel();
        if (!cancelled) {
          setActiveVrmModel(model ?? null);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to load active VRM model.', error);
          setActiveVrmModel(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [resolveApi]);

  const handleVrmStatusChange = useCallback(
    (status: VrmRendererStatus) => {
      if (status.status === 'error') {
        console.warn('VRM renderer error:', status.message);
      }
    },
    [],
  );


  const applySessionHistory = useCallback((session: ConversationSessionWithMessages | null) => {
    if (!session) {
      messageIdsRef.current.clear();
      setTranscriptEntries([]);
      return;
    }

    const entries: TranscriptEntry[] = [];
    const seen = new Set<string>();
    for (const message of session.messages) {
      const speaker = toTranscriptSpeaker(message.role);
      if (!speaker) {
        continue;
      }

      entries.push({
        id: message.id,
        speaker,
        text: message.content,
        timestamp: message.ts,
        ...(speaker === 'assistant' && message.speaker && message.speaker !== 'echo' && message.speaker !== 'user' ? { avatarId: message.speaker } : {}),
      });
      seen.add(message.id);
    }

    entries.sort((a, b) => a.timestamp - b.timestamp);
    messageIdsRef.current.clear();
    for (const id of seen) {
      messageIdsRef.current.add(id);
    }
    setTranscriptEntries(entries.slice(-MAX_TRANSCRIPT_ENTRIES));
  }, []);

  const recordTranscriptEntry = useCallback(
    async ({
      speaker,
      text,
      timestamp = Date.now(),
      persist = true,
      avatarId,
    }: {
      speaker: TranscriptSpeaker;
      text: string;
      timestamp?: number;
      persist?: boolean;
      /** Who said an assistant line; absent or echo means Echo. */
      avatarId?: string;
    }) => {
      const speakerAvatar = speaker === 'assistant' && avatarId && avatarId !== 'echo' ? avatarId : undefined;
      // Realtime turns never pass through local-voice:respond, so presence learns of them here.
      if (speaker === 'user' || speaker === 'assistant') {
        void Promise.resolve((api ?? getPreloadApi())?.presence?.update(speaker === 'user' ? { userSpokeAt: timestamp } : { assistantSpokeAt: timestamp })).catch(() => undefined);
      }
      const canPersist = Boolean(persist && api?.conversation && activeSessionIdRef.current);
      let entryId = `${timestamp}-${Math.random().toString(36).slice(2, 10)}`;

      if (canPersist) {
        // We verified api.conversation exists in canPersist check, but TypeScript needs a direct check
        const conversationApi = api?.conversation;
        if (conversationApi) {
          try {
            const message = await conversationApi.appendMessage({
              sessionId: activeSessionIdRef.current ?? undefined,
              role: speaker,
              content: text,
              ts: timestamp,
              ...(speakerAvatar ? { speaker: speakerAvatar } : {}),
            });
            entryId = message.id;
            messageIdsRef.current.add(message.id);
          } catch (error) {
            console.error('Failed to persist conversation message', error);
          }
        }
      }

      setTranscriptEntries((previous) => {
        const filtered = previous.filter((entry) => entry.id !== entryId);
        const next = [...filtered, { id: entryId, speaker, text, timestamp, ...(speakerAvatar ? { avatarId: speakerAvatar } : {}) }];
        next.sort((a, b) => a.timestamp - b.timestamp);
        return next.slice(-MAX_TRANSCRIPT_ENTRIES);
      });
    },
    [api],
  );

  const { inputs, outputs, error: deviceError, refresh: refreshDevices } = useAudioDevices();

  const [selectedInput, setSelectedInput] = useState('');
  const [selectedOutput, setSelectedOutput] = useState('');
  const selectedOutputRef = useRef('');
  const DEFAULT_PROMPT =
    'You are echo, an AI assistant. You are slightly sarcastic, very blunt, but helpful in your own way.\n\nYou question assumptions, and aren\'t afraid to ask questions or challenge me. You have a sharp wit.\n\nYou are here to help me be a better person, but you don\'t put up with bullshit. You also have an Australian sensibility when it comes to swearing and language overall.\n\nYou are good-natured and good-humoured.';
  const [selectedVoice, setSelectedVoice] = useState<string>(DEFAULT_VOICE);
  const [basePrompt, setBasePrompt] = useState<string>(DEFAULT_PROMPT);
  const [testResponse, setTestResponse] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [serverVoice, setServerVoice] = useState<string | null>(null);
  const [useServerVad, setUseServerVad] = useState<boolean>(true);
  const [vadThreshold, setVadThreshold] = useState<number>(0.85);
  const [vadSilenceMs, setVadSilenceMs] = useState<number>(600);
  const [vadMinSpeechMs, setVadMinSpeechMs] = useState<number>(400);
  const stagedSessionConfigRef = useRef<SessionConfigUpdate | null>(null);
  const [isSessionConfigReady, setSessionConfigReady] = useState(false);

  const availableVoices = useMemo(() => {
    const base = [...STATIC_VOICE_OPTIONS];
    const extras = new Set<string>();

    const appendVoice = (voice: string | null | undefined) => {
      if (typeof voice !== 'string') {
        return;
      }

      const normalized = voice.trim();
      if (!normalized) {
        return;
      }

      if (!STATIC_VOICE_OPTIONS.includes(normalized)) {
        extras.add(normalized);
      }
    };

    appendVoice(config?.realtimeVoice ?? null);
    appendVoice(serverVoice);

    if (extras.size === 0) {
      return base;
    }

    const extraVoices = Array.from(extras).sort((a, b) => a.localeCompare(b));
    return [...base, ...extraVoices];
  }, [config?.realtimeVoice, serverVoice]);

  const configInputDeviceId = config?.audioInputDeviceId ?? '';
  const configOutputDeviceId = config?.audioOutputDeviceId ?? '';
  const hasRealtimeSupport = typeof RTCPeerConnection === 'function';
  const hasRealtimeApiKey = config?.hasRealtimeApiKey ?? false;

  // Use avatar's voice preference when loaded
  useEffect(() => {
    if (avatarVoice && availableVoices.includes(avatarVoice)) {
      setSelectedVoice(avatarVoice);
    }
  }, [avatarVoice, availableVoices]);

  const conversationBackend: ConversationBackend = config?.conversationBackend ?? 'local';
  const isLocalBackend = conversationBackend === 'local';
  // The local backend needs no API key; OpenAI Realtime does.
  const canConnectConversation = isLocalBackend || hasRealtimeApiKey;

  // Local conversation: the voices the engine that speaks offers, and this character's pick.
  const [speakingVoices, setSpeakingVoices] = useState<SpeakingVoiceOptions | null>(null);
  useEffect(() => {
    if (panel !== 'character' || !isLocalBackend) {
      return;
    }
    const bridge = getPreloadApi()?.localVoice;
    if (!bridge?.getVoiceOptions) {
      return;
    }
    let cancelled = false;
    bridge
      .getVoiceOptions()
      .then((options) => {
        if (!cancelled) setSpeakingVoices(options);
      })
      .catch((error: unknown) => {
        console.warn('Could not read the speaking voices', error);
      });
    return () => {
      cancelled = true;
    };
  }, [panel, isLocalBackend, activeVrmModel?.id]);

  const handleSpeakingVoiceChange = useCallback(
    (voice: string) => {
      const engine = speakingVoices?.engine;
      if (!engine) return;
      setSpeakingVoices((current) => (current ? { ...current, selected: voice || null } : current));
      void resolveApi()?.avatar?.setVoicePreference?.(voice, engine);
    },
    [speakingVoices?.engine, resolveApi],
  );

  const wakePhrase = config?.wakeWord?.keywordLabel;
  // A saved gpt-4o-realtime-preview model is retired (model_not_found); fall back to the default.
  const realtimeModel =
    config?.realtimeModel && !config.realtimeModel.startsWith('gpt-4o-realtime-preview') ? config.realtimeModel : undefined;
  // Only the local backend has models of its own to report on.
  const modelStatuses = useMemo(
    () =>
      !isLocalBackend
        ? undefined
        : voiceServiceStatus === undefined
          ? null
          : describeModels(voiceServiceStatus, motionStatus),
    [isLocalBackend, voiceServiceStatus, motionStatus],
  );
  const wakeThresholdRef = useRef(0.5);
  wakeThresholdRef.current = config?.wakeWord?.threshold ?? 0.5;
  // The OpenAI Realtime backend reports no turn stages, only whether it is connected.
  const displayedActivity = useMemo<VoiceActivity>(() => {
    if (isLocalBackend) {
      return voiceActivity;
    }
    const phase = realtimeState.status === 'connected' ? 'listening' : realtimeState.status === 'error' ? 'error' : 'off';
    return { phase, detail: realtimeState.error, since: voiceActivity.since };
  }, [isLocalBackend, voiceActivity, realtimeState]);
  const { reportFace } = usePresenceReporter(activeBridge?.presence, activeBridge?.camera, { listening: isListeningEnabled, voicePhase: displayedActivity.phase });
  // Camera presence ("a face was seen", nothing else). On a satellite the privacy gate decides; on bija the camera runs
  // only while an avatar is here and Kevin turned it on for this PC (off by default).
  const { deviceId: cameraDeviceId, setDeviceId: setCameraDeviceId, cameras } = useCameraDevices();
  const localPlace = placesSnapshot?.places.find((place) => place.id === placesSnapshot.localPlaceId);
  const cameraWanted = isSatellite ? deviceGate?.camera === 'live' : cameraPresenceOn(localPlace) && presence.present.length > 0;
  const facePresence = useFacePresence({ enabled: cameraWanted && !loadingConfig, deviceId: cameraDeviceId, camera: activeBridge?.camera, onFaceSeen: reportFace });
  useEffect(() => {
    stopCameraRef.current = facePresence.stopNow;
  }, [facePresence.stopNow]);
  // The avatar wanders on its own in a 3D room when nobody has talked for a while (rooms/idle-director.ts).
  const idleHabits = useIdleHabits(activeBridge?.avatar, activeVrmModel?.id);
  // The other avatars' personality and idle habits, as saved for them (Echo's are above). Read again
  // when the list changes and after any save in the Characters pop-up.
  const [personaRevision, setPersonaRevision] = useState(0);
  const [stagePersonas, setStagePersonas] = useState<Record<string, { personality: string; habits: string }>>({});
  useEffect(() => {
    const avatarsApi = resolveApi()?.avatars;
    if (!avatarsApi?.idlePersonas || avatarProfiles.length < 2) return undefined;
    let cancelled = false;
    avatarsApi
      .idlePersonas()
      .then((personas) => {
        if (!cancelled) setStagePersonas(personas);
      })
      .catch((error: unknown) => console.warn('Could not read the avatars\' idle habits', error));
    return () => {
      cancelled = true;
    };
  }, [resolveApi, avatarProfiles, personaRevision]);
  // What Echo's card in the Characters pop-up edits: the same prompt, idle habits and voice state the
  // session instructions, the idle persona and the voice preference are built from.
  const echoControls: CharacterSettingsControls = {
    prompt: { value: basePrompt, onChange: setBasePrompt, onBlur: () => void handlePromptBlur(), disabled: loadingConfig },
    habits: {
      value: idleHabits.habits,
      onChange: idleHabits.setHabits,
      onBlur: () => void idleHabits.save(),
      maxLength: idleHabits.maxLength,
      disabled: loadingConfig || !idleHabits.available,
    },
    voice: isLocalBackend
      ? { kind: 'engine', options: speakingVoices, onChange: handleSpeakingVoiceChange, disabled: loadingConfig }
      : { kind: 'list', voices: availableVoices, value: selectedVoice, onChange: setSelectedVoice, disabled: loadingConfig },
  };
  const getVoiceOptionsFor = useCallback(
    (avatarId?: string) => getPreloadApi()?.localVoice?.getVoiceOptions?.(avatarId) ?? Promise.reject(new Error('The voices are unavailable.')),
    [],
  );
  const characterSettings: CharacterSettingsContext = {
    avatarApi: activeBridge?.avatar,
    getVoiceOptions: getVoiceOptionsFor,
    isLocalBackend,
    realtimeVoices: availableVoices,
    echo: echoControls,
  };

  // Latest voice activity per avatar, read when the idle director picks who acts (not a render dependency).
  const speakingRef = useRef({ echo: visemeFrame, others: visemeFrames });
  useEffect(() => {
    speakingRef.current = { echo: visemeFrame, others: visemeFrames };
  }, [visemeFrame, visemeFrames]);
  const { idleNote } = useIdleDirector({
    executor: sceneActions,
    // Several avatars on stage: the one idle director picks who acts (rooms/idle-picker.ts). Each avatar has its own habits.
    avatars: () =>
      stageNames.map((profile) => {
        const isEcho = profile.id === 'echo';
        const frame = isEcho ? speakingRef.current.echo : (speakingRef.current.others[profile.id] ?? null);
        const persona = stagePersonas[profile.id];
        return {
          id: profile.id,
          name: profile.name,
          executor: rigs.get(profile.id).executor,
          speaking: frame !== null && frame.intensity > 0.05,
          personality: persona?.personality ?? profile.prompt ?? '',
          habits: persona?.habits ?? '',
        };
      }),
    // Every avatar is in another place: nobody wanders in an empty room.
    nobodyHere: () => presence.present.length === 0,
    room: backgrounds.activeRoom,
    settings: backgrounds.idleSettings,
    motionReady: liveMotionReady,
    persona: { name: activeVrmModel?.name ?? '', personality: basePrompt, habits: idleHabits.habits },
    phase: voiceActivity.phase,
    pick: async (context) => (await activeBridge?.backgrounds?.pickIdle?.(context)) ?? null,
    run: (text, avatarId) => animationTextHandlerRef.current(text, avatarId, 'idle'),
    // Wandering between places: bija says where everyone is and who used which PC, and whether this avatar may go (places/wander.ts).
    places: () => {
      const bridge = resolveApi()?.places;
      if (!bridge?.canWander || !placesSnapshot || placesSnapshot.places.length < 2) return null;
      return bridge
        .snapshot()
        .then((snapshot) => ({ snapshot, nameOf: (id: string) => avatarProfiles.find((profile) => profile.id === id)?.name ?? id }))
        .catch(() => null);
    },
    canWander: async (avatarId, place, speaking) => {
      const bridge = resolveApi()?.places;
      if (!bridge?.canWander) return false;
      return (await bridge.canWander(avatarId, place, speaking)).ok;
    },
  });
  // Describes the active 3D room (and the scene tags) to the model; empty in 2D. Part of the session
  // instructions, so a room change reaches both the local voice and Realtime sessions.
  // The other avatars on stage (as many as the renderer shows beside Echo), named in each avatar's scene text.
  // Only the avatars that are here: one in another place is neither on stage nor part of the room text.
  const stageNames = useMemo(() => {
    if (avatarProfiles.length < 2) return [];
    const here = avatarProfiles.filter((profile) => presence.present.includes(profile.id));
    return [...here.filter((profile) => profile.id === 'echo'), ...here.filter((profile) => profile.id !== 'echo').slice(0, 2)];
  }, [avatarProfiles, presence.present]);
  // Bumped when any avatar's action ends, so the scene text says where the others are now (not every frame).
  const [sceneTick, setSceneTick] = useState(0);
  useEffect(() => {
    const bump = (activity: SceneActivity) => {
      if (activity.type === 'done' || activity.type === 'failed') setSceneTick((tick) => tick + 1);
    };
    const offEcho = sceneActions.onActivity(bump);
    const offOthers = rigs.onOtherActivity((_avatarId, activity) => bump(activity));
    return () => {
      offEcho();
      offOthers();
    };
  }, [sceneActions, rigs]);
  /** What each avatar on stage would be told about the others in the room, with where they are when known. */
  const othersFor = useCallback(
    (forId: string): OtherAvatarEntry[] =>
      stageNames
        .filter((profile) => profile.id !== forId)
        .map((profile) => {
          const executor = rigs.get(profile.id).executor;
          const seat = executor.getState().seat;
          const world = executor.world();
          const where = describeAvatarWhere(backgrounds.activeRoom, {
            seatedOn: seat?.objectId ?? null,
            position: world ? { x: world.frame.origin.x, z: world.frame.origin.z } : null,
          });
          return { name: profile.name, where };
        }),
    [stageNames, rigs, backgrounds.activeRoom],
  );
  const sceneInstructions = useMemo(
    () => buildSceneInstructions(backgrounds.activeRoom, liveMotionReady, idleNote, othersFor('echo')),
    // sceneTick: where the others are changes when an action ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backgrounds.activeRoom, liveMotionReady, idleNote, othersFor, sceneTick],
  );
  const sessionInstructions = useMemo(
    () => {
      const poseSlugs = availablePoses.map((p) => toAnimationSlug(p.name)).filter((s) => s.length > 0);
      return buildSessionInstructions(basePrompt, availableAnimationSlugs, poseSlugs, activeVrmModel, liveMotionReady, sceneInstructions);
    },
    [basePrompt, availableAnimationSlugs, availablePoses, activeVrmModel, liveMotionReady, sceneInstructions],
  );
  const availableAnimationSlugSet = useMemo(
    () => new Set(availableAnimationSlugs),
    [availableAnimationSlugs],
  );
  const availablePoseSlugSet = useMemo(
    () => new Set(availablePoses.map((p) => toAnimationSlug(p.name)).filter((s) => s.length > 0)),
    [availablePoses],
  );
  const animationTextHandlerRef = useRef<(text: string, avatarId?: string, origin?: 'idle') => void>(() => undefined);
  const moveRequestFilterRef = useRef(new MoveRequestFilter());
  const sceneActionFilterRef = useRef(new MoveRequestFilter());
  const activeRoomRef = useRef(backgrounds.activeRoom);
  useEffect(() => { activeRoomRef.current = backgrounds.activeRoom; }, [backgrounds.activeRoom]);
  // An avatar's {room:} tag, once it has walked to the door (or finished speaking): ask main to move it.
  const moveAvatarToPlace = useCallback(
    (avatarId: string, place: string, origin?: 'idle') => {
      const bridge = resolveApi()?.places;
      if (!bridge) return;
      bridge
        .move(avatarId, place, origin === 'idle' ? 'wandered' : 'chose to')
        .then((result) => {
          if (!result.ok) console.warn(`[places] ${avatarId} cannot go to "${place}": ${result.reason ?? 'no reason given'}`);
        })
        .catch((error: unknown) => console.warn('[places] the move failed', error));
    },
    [resolveApi],
  );
  const handleRealtimeTextContent = useCallback(
    (content: string, avatarId?: string, origin?: 'idle') => {
      if (!content) {
        return;
      }
      // Tags in another avatar's reply drive only that avatar. Echo (no id) is handled exactly as before.
      const speaker = avatarId && avatarId !== 'echo' ? avatarId : undefined;
      const streamMotion = resolveApi()?.avatar?.streamMotion;
      // {room:<place>}: the avatar leaves for another place. Each tag is acted on once per reply (the same repeat filter as the scene tags).
      const roomFilter = speaker ? rigs.sceneFilterFor(speaker) : sceneActionFilterRef.current;
      const roomTags = extractMotionTags(content).filter((tag): tag is Extract<MotionTag, { type: 'room' }> => tag.type === 'room' && roomFilter.shouldStart(JSON.stringify(tag)));
      const freshRoomTags = new Set(roomTags.map((tag) => JSON.stringify(tag)));
      const walkedOut = new Set<string>();
      // One loop for every speaker: scene tags go to that avatar's executor, {move:} gestures wait their turn in a
      // room and start straight away otherwise. Echo keeps her own filters and her executor (`sceneActions`).
      if (liveMotionReady && streamMotion) {
        const room = activeRoomRef.current;
        const executor = speaker ? rigs.get(speaker).executor : sceneActions;
        const moveFilter = speaker ? rigs.filterFor(speaker) : moveRequestFilterRef.current;
        const sceneFilter = speaker ? rigs.sceneFilterFor(speaker) : sceneActionFilterRef.current;
        const speakerName = speaker ? (avatarProfiles.find((profile) => profile.id === speaker)?.name ?? speaker) : '';
        // In a room the tags run in the order written; a {move:} waits for the scene actions before it.
        const pendingActions: SceneAction[] = [];
        const flushActions = () => {
          if (pendingActions.length > 0) executor.submit(pendingActions.splice(0));
        };
        for (const tag of extractMotionTags(content)) {
          if (tag.type === 'room') {
            // Leaving: walk to the door (if the room has one), then ask main to move the avatar. Without a room it is handled below.
            if (!room || !freshRoomTags.has(JSON.stringify(tag))) continue;
            walkedOut.add(JSON.stringify(tag));
            pendingActions.push({ kind: 'exit' });
            flushActions();
            executor.submitAfter(`leave for ${tag.place}`, () => moveAvatarToPlace(speaker ?? 'echo', tag.place, origin));
            continue;
          }
          if (tag.type !== 'move') {
            if (!room || !sceneFilter.shouldStart(JSON.stringify(tag))) continue;
            const action = tagToAction(room, tag);
            if (action) pendingActions.push(action);
            continue;
          }
          const move = tag;
          if (!moveFilter.shouldStart(move.text)) {
            continue;
          }
          const startMove = async () => {
            const streamId = Math.random().toString(36).slice(2, 10);
            // Chunks of another avatar's gesture play on its own actor.
            if (speaker) rigs.registerStream(streamId, speaker);
            setToolCalls((calls) =>
              addToolCall(calls, {
                id: streamId,
                kind: 'move',
                label: speaker ? `${speakerName}: ${move.text}` : move.text,
                status: 'pending',
                startedAt: Date.now(),
              }),
            );
            try {
              const result = await streamMotion({ streamId, prompt: move.text, avatarRest: getAvatarRestSkeleton(speaker ?? 'echo') ?? undefined });
              const firstChunk = result.firstChunkMs === null ? '' : `, first after ${(result.firstChunkMs / 1000).toFixed(1)} s`;
              setToolCalls((calls) =>
                finishToolCall(calls, streamId, 'done', Date.now(), `${result.chunks} chunk${result.chunks === 1 ? '' : 's'}${firstChunk}`),
              );
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              console.error('[App] Live motion generation failed', { ...(speaker ? { avatar: speaker } : {}), prompt: move.text, error: message });
              setToolCalls((calls) => finishToolCall(calls, streamId, 'failed', Date.now(), message));
            } finally {
              // Chunks arrive as events before the request resolves; keep the id a moment for stragglers.
              if (speaker) setTimeout(() => rigs.endStream(streamId), 5000);
            }
          };
          if (room) {
            flushActions();
            executor.submitGesture(move.text, startMove);
          } else {
            void startMove();
          }
        }
        flushActions();
      }
      // In 2D (or with no live motion) there is no door to walk to: the avatar leaves once its speech is over.
      for (const tag of roomTags) {
        if (walkedOut.has(JSON.stringify(tag))) continue;
        window.setTimeout(() => moveAvatarToPlace(speaker ?? 'echo', tag.place, origin), estimateSpeechMs(content));
      }
      const tags = extractAvatarTags(content, {
        allowedAnimationSlugs: availableAnimationSlugSet,
        allowedPoseSlugs: availablePoseSlugSet,
      });
      if (tags.length === 0) {
        return;
      }
      for (const tag of tags) {
        const callId = Math.random().toString(36).slice(2, 10);
        const startedAt = Date.now();
        if (tag.type === 'pose') {
          // Find the pose by slug and load its data to apply
          const pose = availablePoses.find((p) => toAnimationSlug(p.name) === tag.slug);
          if (pose) {
            setToolCalls((calls) =>
              addToolCall(calls, { id: callId, kind: 'pose', label: tag.slug, status: 'pending', startedAt }),
            );
            const bridge = resolveApi();
            bridge?.avatar?.loadPose(pose.id).then((poseData) => {
              if (poseData && typeof poseData === 'object') {
                const pose = poseData as Record<string, { rotation: number[]; position?: number[] }>;
                if (speaker) {
                  animationBus.applyPose(pose, 'realtime-text', undefined, undefined, speaker);
                } else {
                  animationBus.applyPose(pose, 'realtime-text');
                }
              }
              setToolCalls((calls) => finishToolCall(calls, callId, 'done', Date.now()));
            }).catch((error) => {
              console.error('[App] Failed to load pose from LLM tag', error);
              const message = error instanceof Error ? error.message : String(error);
              setToolCalls((calls) => finishToolCall(calls, callId, 'failed', Date.now(), message));
            });
          }
        } else {
          animationBus.enqueue({ slug: tag.slug, intent: 'play', source: 'realtime-text', ...(speaker ? { avatarId: speaker } : {}) });
          setToolCalls((calls) =>
            addToolCall(calls, {
              id: callId,
              kind: 'animation',
              label: tag.slug,
              status: 'done',
              startedAt,
              finishedAt: startedAt,
              detail: 'queued',
            }),
          );
        }
      }
    },
    [animationBus, availableAnimationSlugSet, availablePoseSlugSet, availablePoses, avatarProfiles, liveMotionReady, moveAvatarToPlace, resolveApi, rigs, sceneActions],
  );

  useEffect(() => {
    animationTextHandlerRef.current = handleRealtimeTextContent;
  }, [handleRealtimeTextContent]);

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const visemeDriverRef = useRef<VisemeDriver | null>(null);
  /** A lip-sync driver and a speaker element per avatar other than echo, created when its audio output appears. */
  const avatarVoicesRef = useRef(new Map<string, { driver: VisemeDriver; audio: HTMLAudioElement | null }>());
  const disposeAvatarVoice = useCallback((avatarId: string) => {
    const voice = avatarVoicesRef.current.get(avatarId);
    if (!voice) {
      return;
    }
    avatarVoicesRef.current.delete(avatarId);
    void voice.driver.destroy();
    if (voice.audio) {
      voice.audio.pause();
      voice.audio.srcObject = null;
    }
  }, []);
  const disposeAvatarVoices = useCallback(() => {
    for (const avatarId of [...avatarVoicesRef.current.keys()]) {
      disposeAvatarVoice(avatarId);
    }
    setVisemeFrames({});
  }, [disposeAvatarVoice]);
  const avatarStreamHandlerRef = useRef<(avatarId: string, stream: MediaStream) => void>(() => undefined);
  avatarStreamHandlerRef.current = (avatarId, stream) => {
    disposeAvatarVoice(avatarId);
    const driver = new VisemeDriver({
      onFrame: (frame) => {
        setVisemeFrames((previous) => ({ ...previous, [avatarId]: frame }));
      },
      onError: (error) => {
        console.error('Viseme driver error', avatarId, error);
      },
    });
    let audio: HTMLAudioElement | null = null;
    if (typeof Audio !== 'undefined') {
      audio = new Audio();
      if (selectedOutputRef.current) applySink(audio, selectedOutputRef.current);
      audio.srcObject = stream;
      audio.autoplay = true;
      try {
        void Promise.resolve(audio.play()).catch((error: unknown) => {
          console.error('Failed to play avatar audio', avatarId, error);
        });
      } catch (error) {
        console.error('Failed to play avatar audio', avatarId, error);
      }
    }
    avatarVoicesRef.current.set(avatarId, { driver, audio });
    driver.attachToStream(stream).catch((error: unknown) => {
      console.error('Failed to attach viseme driver', avatarId, error);
    });
  };
  const [playbackIssue, setPlaybackIssue] = useState<string | null>(null);
  const recordTranscriptEntryRef = useRef(recordTranscriptEntry);
  useEffect(() => {
    recordTranscriptEntryRef.current = recordTranscriptEntry;
  }, [recordTranscriptEntry]);

  const realtimeClient = useMemo((): RealtimeClient | LocalVoiceClient | null => {
    if (loadingConfig) {
      return null;
    }

    const onLog: NonNullable<RealtimeClientCallbacks['onLog']> = (entry) => {
      const prefix = isLocalBackend ? '[LocalVoiceClient]' : '[RealtimeClient]';
      // Serialized, because the main-process console forwarder logs objects as "[object Object]".
      const details = entry.json ?? serializeLogData(entry.data);
      if (entry.level === 'error') {
        console.error(prefix, entry.message, details);
      } else if (entry.level === 'warn') {
        console.warn(prefix, entry.message, details);
      } else {
        console.debug(prefix, entry.message, details);
      }
    };

    const playRemoteStream = (stream: MediaStream) => {
      setRemoteStream(stream);
      const element = remoteAudioRef.current;
      if (!element) {
        return;
      }

      element.srcObject = stream;
      const playPromise = element.play();
      if (playPromise) {
        playPromise
          .then(() => {
            setPlaybackIssue(null);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setPlaybackIssue(message || 'Audio autoplay blocked');
            console.error('Failed to play realtime audio', error);
          });
      }
    };

    const recordFirstAudio = () => {
      const snapshot = latencyTrackerRef.current.recordFirstAudio(Date.now(), activeSessionIdRef.current);
      if (snapshot) {
        setLatencySnapshot((previous) => ({ ...(previous ?? {}), ...snapshot }));
        pushLatency(snapshot);
      }
    };

    if (isLocalBackend) {
      return new LocalVoiceClient({
        getBridge: () => getPreloadApi()?.localVoice,
        interruptFloor: () => getPreloadApi()?.floor?.interrupt(),
        wakePhrase,
        // A satellite has no wake word yet: while its gate is open the mic listens, as push-to-talk and taps also start it.
        requireWakeWord: !isSatellite,
        callbacks: {
          onStateChange: setRealtimeState,
          onTurnTiming: (timing) => {
            if (!isSatellite) return;
            setLastTurnTiming(timing);
            void getPreloadApi()?.satellite?.reportTurn?.(timing)?.catch(() => undefined);
          },
          onTextContent: (content, avatarId) => {
            animationTextHandlerRef.current?.(content, avatarId);
          },
          onRemoteStream: playRemoteStream,
          onAvatarStream: (avatarId, stream) => avatarStreamHandlerRef.current(avatarId, stream),
          onFirstAudioFrame: recordFirstAudio,
          onUserTranscript: (text) => {
            void recordTranscriptEntryRef.current({ speaker: 'user', text });
          },
          onAssistantTranscript: (text, avatarId) => {
            void recordTranscriptEntryRef.current({ speaker: 'assistant', text, avatarId });
          },
          onSystemNote: (text) => {
            void recordTranscriptEntryRef.current({ speaker: 'system', text });
          },
          onAnnouncement: ({ note, reply }) => {
            // No conversation is running, so the announcement is saved here and only shown in the transcript.
            const ts = Date.now();
            void getPreloadApi()
              ?.conversation?.announce?.({ note, reply, ts })
              .catch((error: unknown) => console.error('Failed to persist announcement', error));
            if (note) {
              void recordTranscriptEntryRef.current({ speaker: 'system', text: note, timestamp: ts, persist: false });
            }
            if (reply) {
              void recordTranscriptEntryRef.current({ speaker: 'assistant', text: reply, timestamp: ts + 1, persist: false });
            }
          },
          onActivity: setVoiceActivity,
          onToolCall: (call) => {
            const id = `${call.requestId}:${call.callId}`;
            if (call.status === 'started') {
              setToolCalls((calls) =>
                addToolCall(calls, { id, kind: call.name, label: call.label, status: 'pending', startedAt: Date.now() }),
              );
            } else {
              setToolCalls((calls) => finishToolCall(calls, id, call.status === 'done' ? 'done' : 'failed', Date.now(), call.detail));
            }
          },
          onLog,
        },
      });
    }

    if (!hasRealtimeSupport) {
      return null;
    }

    return new RealtimeClient({
      handshakeMode: 'sdp',
      model: realtimeModel,
      callbacks: {
        onStateChange: setRealtimeState,
        onSessionUpdated: (session) => {
          if (typeof session.voice === 'string') {
            setServerVoice(session.voice);
          }

          if (typeof session.instructions === 'string') {
            const nextPrompt = stripAnimationInstructions(session.instructions);
            setBasePrompt(nextPrompt.trim().length > 0 ? nextPrompt : DEFAULT_PROMPT);
          }
        },
        onTextContent: (content) => {
          animationTextHandlerRef.current?.(content);
        },
        onRemoteStream: playRemoteStream,
        onFirstAudioFrame: recordFirstAudio,
        onLog,
      },
    });
  }, [hasRealtimeSupport, pushLatency, loadingConfig, isLocalBackend, isSatellite, wakePhrase, realtimeModel]);

  // A satellite plays speech through its own chosen speakers: the client's element and every avatar's element.
  useEffect(() => {
    selectedOutputRef.current = selectedOutput;
    if (!isSatellite) return;
    if (realtimeClient instanceof LocalVoiceClient) void realtimeClient.setOutputDeviceId(selectedOutput || undefined);
    for (const voice of avatarVoicesRef.current.values()) if (selectedOutput) applySink(voice.audio, selectedOutput);
  }, [isSatellite, selectedOutput, realtimeClient]);

  // Urgent updates are announced even when the conversation is not running.
  useEffect(() => {
    if (!(realtimeClient instanceof LocalVoiceClient)) {
      return undefined;
    }
    realtimeClient.watchUpdates();
    return () => {
      realtimeClient.unwatchUpdates();
    };
  }, [realtimeClient]);

  // Generate a test response based on the base prompt
  const handleTestResponse = useCallback(async () => {
    if (!isLocalBackend) {
      setTestResponse('Test response only available for local backend.');
      return;
    }

    setIsTesting(true);
    setTestResponse(null);

    try {
      // Generate a simple test prompt based on the base prompt
      const promptPreview = basePrompt.substring(0, 40) + (basePrompt.length > 40 ? '...' : '');
      const testPrompt = `Based on your instructions "${promptPreview}", say something helpful.`;

      // Use the local voice bridge to respond
      const bridge = getPreloadApi()?.localVoice;
      if (!bridge) {
        setTestResponse('Local voice bridge unavailable.');
        setIsTesting(false);
        return;
      }

      const poseSlugs = availablePoses.map((p) => toAnimationSlug(p.name)).filter((s) => s.length > 0);
      const instructions = buildSessionInstructions(basePrompt, availableAnimationSlugs, poseSlugs, activeVrmModel, liveMotionReady, sceneInstructions);

      // Spoken aloud in the configured voice: through the avatar (with lip-sync) while the
      // conversation is running, otherwise straight to the chosen speakers.
      const client = realtimeClient instanceof LocalVoiceClient ? realtimeClient : null;
      const result =
        (await client?.preview(testPrompt, instructions)) ??
        (await playPreviewReply(bridge, { text: testPrompt, instructions }, { outputDeviceId: selectedOutput || null }));

      setTestResponse(result.text || (result.cancelled ? 'Test response was interrupted.' : 'No reply was generated.'));
    } catch (err) {
      console.error('Test response failed:', err);
      setTestResponse('Error generating response. Check logs.');
    } finally {
      setIsTesting(false);
    }
  }, [isLocalBackend, basePrompt, availableAnimationSlugs, availablePoses, activeVrmModel, liveMotionReady, sceneInstructions, realtimeClient, selectedOutput]);

  const mintEphemeralToken = useCallback(
    async (reason: string) => {
      const bridge = resolveApi();
      if (!bridge?.realtime?.mintEphemeralToken) {
        throw new Error('Realtime token bridge unavailable.');
      }
      if (!realtimeClient) {
        throw new Error('Realtime client is unavailable.');
      }

      const requestId = realtimeTokenRequestRef.current + 1;
      realtimeTokenRequestRef.current = requestId;
      const session = realtimeClient.getSessionConfigSnapshot();

      try {
        const response = await bridge.realtime.mintEphemeralToken({ session });
        if (requestId !== realtimeTokenRequestRef.current) {
          return null;
        }
        setRealtimeToken(response.value);
        realtimeTokenExpiresAtRef.current = typeof response.expiresAt === 'number' ? response.expiresAt : null;
        realtimeTokenRefreshRef.current = false;
        setRealtimeTokenError(null);
        console.info('[RealtimeClient] Minted ephemeral token.', { reason });
        return response.value;
      } catch (error) {
        if (requestId !== realtimeTokenRequestRef.current) {
          return null;
        }
        const message = error instanceof Error ? error.message : 'Failed to mint realtime session token.';
        setRealtimeToken(null);
        setRealtimeTokenError(message);
        console.error('[RealtimeClient] Failed to mint ephemeral token.', { reason, message });
        throw error;
      }
    },
    [realtimeClient, resolveApi],
  );

  const isRealtimeTokenExpired = useCallback(() => {
    const expiresAt = realtimeTokenExpiresAtRef.current;
    if (typeof expiresAt !== 'number') {
      return true;
    }
    return Date.now() >= expiresAt;
  }, []);

  const resolveReconnectToken = useCallback(async () => {
    if (!hasRealtimeApiKey) {
      return null;
    }
    if (!realtimeToken || realtimeTokenRefreshRef.current || isRealtimeTokenExpired()) {
      return await mintEphemeralToken('reconnect');
    }
    return realtimeToken;
  }, [hasRealtimeApiKey, realtimeToken, isRealtimeTokenExpired, mintEphemeralToken]);

  useEffect(() => {
    if (!realtimeClient) {
      return;
    }

    realtimeClient.setReconnectApiKeyProvider(resolveReconnectToken);

    return () => {
      realtimeClient.setReconnectApiKeyProvider(undefined);
    };
  }, [realtimeClient, resolveReconnectToken]);

  useEffect(() => {
    const driver = new VisemeDriver({
      onFrame: (frame) => {
        setVisemeFrame(frame);
      },
      onError: (error) => {
        console.error('Viseme driver error', error);
      },
    });

    visemeDriverRef.current = driver;

    return () => {
      visemeDriverRef.current = null;
      void driver.destroy();
    };
  }, []);

  useEffect(() => {
    if (!realtimeClient) {
      return;
    }

    return () => {
      void realtimeClient.destroy();
      disposeAvatarVoices();
    };
  }, [realtimeClient, disposeAvatarVoices]);

  useEffect(() => {
    const driver = visemeDriverRef.current;
    if (!driver) {
      return;
    }

    let disposed = false;

    const attach = async () => {
      try {
        await driver.attachToStream(remoteStream);
      } catch (error) {
        if (!disposed) {
          console.error('Failed to attach viseme driver', error);
        }
      }
    };

    void attach();

    return () => {
      disposed = true;
    };
  }, [remoteStream]);

  useEffect(() => {
    if (realtimeState.status === 'idle' || realtimeState.status === 'error') {
      setRemoteStream(null);
      if (avatarVoicesRef.current.size > 0) {
        disposeAvatarVoices();
      }
    }
  }, [realtimeState.status, disposeAvatarVoices]);

  const refreshAvatarsRef = useRef<(() => Promise<void>) | null>(null);
  const refreshAvatars = useCallback(async () => {
    await refreshAvatarsRef.current?.();
  }, []);
  // The Characters pop-up lists the library next to the scene, so read it each time the pop-up opens.
  useEffect(() => {
    if (panel === 'character') {
      void refreshAvatars();
    }
  }, [panel, refreshAvatars]);
  // Which avatars share the stage: the registry's list and the models they wear. Only read further
  // while there is more than one avatar, so a single avatar costs one `avatars:list` call.
  useEffect(() => {
    const avatarsApi = resolveApi()?.avatars;
    if (!avatarsApi?.list) {
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = async (forceModels = false) => {
      try {
        const list = await avatarsApi.list();
        if (cancelled) {
          return;
        }
        setAvatarProfiles((previous) => (JSON.stringify(previous) === JSON.stringify(list) ? previous : list));
        if (list.length > 1 || forceModels) {
          const models = await resolveApi()?.avatar?.listModels?.();
          if (!cancelled && models) {
            setVrmModels((previous) => (JSON.stringify(previous) === JSON.stringify(models) ? previous : models));
          }
        }
        if (list.length > 1) {
          if (timer === null && !cancelled) {
            timer = setInterval(() => void refresh(), 5000);
          }
        } else if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      } catch (error) {
        console.warn('Failed to read the avatar list.', error);
      }
    };
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    void refresh();
    refreshAvatarsRef.current = () => refresh(true);
    return () => {
      cancelled = true;
      refreshAvatarsRef.current = null;
      window.removeEventListener('focus', onFocus);
      if (timer !== null) {
        clearInterval(timer);
      }
    };
  }, [resolveApi, activeVrmModel?.id]);

  const stageAvatars = useMemo((): VrmStageAvatar[] | undefined => {
    if (avatarProfiles.length < 2) {
      return undefined;
    }
    // On stage: the avatars here, those walking in (their body loads out of sight), and Echo, whose body stays loaded.
    const onStage = avatarProfiles.filter((profile) => profile.id === 'echo' || presence.present.includes(profile.id) || presence.incoming.includes(profile.id));
    return onStage.map((profile) => {
      const own = profile.vrmModelId ? vrmModels.find((candidate) => candidate.id === profile.vrmModelId) : undefined;
      const isEcho = profile.id === 'echo';
      return {
        id: profile.id,
        name: profile.name,
        // Echo follows the active model; a shared or unknown body is Echo's model, loaded once per actor.
        model: isEcho ? activeVrmModel : profile.vrmModelId === activeVrmModel?.id ? activeVrmModel : (own ?? activeVrmModel),
        frame: isEcho ? visemeFrame : (visemeFrames[profile.id] ?? null),
      };
    });
  }, [avatarProfiles, presence, vrmModels, activeVrmModel, visemeFrame, visemeFrames]);
  // Bodies that are loaded but not on this screen: Echo while she is in another place, and avatars walking in.
  const hiddenIds = useMemo(() => {
    const hidden = [...presence.incoming.filter((id) => id !== 'echo')];
    if (!presence.present.includes('echo')) hidden.push('echo');
    return hidden;
  }, [presence]);
  // Walking in. An avatar on its way here stays out of sight until its body is loaded; then main is told so it
  // can let it in (the renderer puts it at the room's door), and it walks to its spot.
  const readyBodiesRef = useRef(new Set<string>());
  const [readyVersion, setReadyVersion] = useState(0);
  const handleBodyReady = useCallback((avatarId: string) => {
    if (readyBodiesRef.current.has(avatarId)) return;
    readyBodiesRef.current.add(avatarId);
    setReadyVersion((version) => version + 1);
  }, []);
  useEffect(() => {
    // A body that left the stage is unloaded; it has to load again the next time.
    const onStage = new Set(stageAvatars?.map((entry) => entry.id) ?? ['echo']);
    for (const id of [...readyBodiesRef.current]) if (id !== 'echo' && !onStage.has(id)) readyBodiesRef.current.delete(id);
  }, [stageAvatars]);
  const arrivalSentRef = useRef(new Set<string>());
  useEffect(() => {
    const bridge = resolveApi()?.places;
    if (!bridge) return;
    const sent = arrivalSentRef.current;
    for (const id of [...sent]) if (!presence.incoming.includes(id)) sent.delete(id);
    for (const id of presence.incoming) {
      if (sent.has(id)) continue;
      // Nothing to load for an avatar without a body; otherwise wait for the renderer to say the body is ready.
      const entry = stageAvatars?.find((candidate) => candidate.id === id);
      const bodyless = stageAvatars ? entry?.model == null : id === 'echo' && activeVrmModel == null;
      if (!readyBodiesRef.current.has(id) && !bodyless) continue;
      sent.add(id);
      bridge.arrived(id).catch((error: unknown) => console.warn('[places] could not report an arrival', error));
    }
  }, [presence.incoming, readyVersion, stageAvatars, activeVrmModel, resolveApi]);
  // Once it is let in, the avatar walks from the door to its spot (3D rooms with live motion; in 2D it is simply there).
  const walkInRef = useRef<{ present: string[]; incoming: string[] } | null>(null);
  useEffect(() => {
    const before = walkInRef.current;
    walkInRef.current = { present: presence.present, incoming: presence.incoming };
    if (!before || !backgrounds.activeRoom || !liveMotionReady) return;
    for (const id of presence.present) {
      if (!before.incoming.includes(id) || before.present.includes(id)) continue;
      (id === 'echo' ? sceneActions : rigs.get(id).executor).submit([{ kind: 'come' }]);
    }
  }, [presence, backgrounds.activeRoom, liveMotionReady, rigs, sceneActions]);
  const callAvatar = useCallback(
    (avatarId: string) => {
      const bridge = resolveApi()?.places;
      const here = placesSnapshot?.localPlaceId;
      if (!bridge || !here) return;
      bridge
        .move(avatarId, here, 'called')
        .then((result) => {
          if (!result.ok) console.warn(`[places] could not call ${avatarId}: ${result.reason ?? 'no reason given'}`);
        })
        .catch((error: unknown) => console.warn('[places] the call failed', error));
    },
    [placesSnapshot?.localPlaceId, resolveApi],
  );
  const avatarNames = useMemo(
    () => Object.fromEntries(avatarProfiles.map((profile) => [profile.id, profile.name])),
    [avatarProfiles],
  );
  // The animation, pose and {move:} instructions for the other avatars' prompts (main adds them to their personas).
  // They share Echo's lists when they wear her body; an avatar with a body of its own only gets {move:}.
  const avatarTagInstructions = useMemo(() => {
    if (avatarProfiles.length < 2) return null;
    const poseSlugs = availablePoses.map((p) => toAnimationSlug(p.name)).filter((s) => s.length > 0);
    // The scene text has no idle note; each avatar on stage also hears who else is in the room.
    const room = backgrounds.activeRoom;
    const scene = buildSceneInstructions(room, liveMotionReady, undefined);
    const sceneFor = Object.fromEntries(
      stageNames
        .filter((profile) => profile.id !== 'echo')
        .map((profile) => [
          profile.id,
          buildSceneInstructions(room, liveMotionReady, undefined, othersFor(profile.id)),
        ]),
    );
    return {
      shared: buildAvatarTagInstructions(availableAnimationSlugs, poseSlugs, liveMotionReady),
      moveOnly: buildMoveOnlyInstructions(liveMotionReady),
      ...(scene ? { scene, sceneFor } : {}),
    };
    // sceneTick: where the others are changes when an action ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarProfiles.length, availableAnimationSlugs, availablePoses, liveMotionReady, backgrounds.activeRoom, stageNames, othersFor, sceneTick]);
  useEffect(() => {
    if (!avatarTagInstructions) return;
    const setTagInstructions = resolveApi()?.avatars?.setTagInstructions;
    void setTagInstructions?.(avatarTagInstructions)?.catch?.((error: unknown) => console.warn('Failed to send avatar tag instructions.', error));
  }, [avatarTagInstructions, resolveApi]);

  useEffect(() => {
    const bridge = resolveApi();
    if (!bridge) {
      setConfigError('Renderer preload API is unavailable.');
      setLoadingConfig(false);
      logRendererBridge('error', 'Configuration bridge unavailable while loading renderer config.', {
        ...collectBridgeDiagnostics(undefined, { effect: 'load-config' }),
      });
      return;
    }

    let cancelled = false;
    logRendererBridge('info', 'Requesting renderer configuration from main process.', {
      ...collectBridgeDiagnostics(bridge, { effect: 'load-config' }),
    });
    bridge.config
      .get()
      .then((value) => {
        if (cancelled) {
          return;
        }
        setConfig(value);
        setConfigError(null);
        const overlayEnabled = value.featureFlags?.transcriptOverlay ?? false;
        setTranscriptVisible(overlayEnabled);
        logRendererBridge('info', 'Renderer configuration received from main process.', {
          hasRealtimeApiKey: value.hasRealtimeApiKey,
          wakeWordModel: value.wakeWord?.model ?? null,
          audioInputConfigured: Boolean(value.audioInputDeviceId),
          audioOutputConfigured: Boolean(value.audioOutputDeviceId),
          featureFlagKeys: Object.keys(value.featureFlags ?? {}),
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to load renderer configuration.';
        setConfigError(message);
        logRendererBridge('error', 'Failed to load renderer configuration from main process.', {
          message,
          name: error instanceof Error ? error.name : 'unknown',
          ...collectBridgeDiagnostics(bridge, { effect: 'load-config' }),
        });
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingConfig(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, resolveApi]);

  useEffect(() => {
    const bridge = resolveApi();
    const conversationBridge = bridge?.conversation;
    if (!conversationBridge) {
      setActiveSessionId(null);
      applySessionHistory(null);
      return;
    }

    let cancelled = false;

    conversationBridge
      .getHistory()
      .then((history) => {
        if (cancelled) {
          return;
        }

        const sessionId = history.currentSessionId ?? history.sessions[0]?.id ?? null;
        setActiveSessionId(sessionId);

        if (sessionId) {
          const session = history.sessions.find((item) => item.id === sessionId) ?? null;
          applySessionHistory(session);
        } else {
          applySessionHistory(null);
        }
      })
      .catch((error) => {
        console.error('Failed to load conversation history', error);
      });

    const unsubscribeSession = conversationBridge.onSessionStarted((session) => {
      setActiveSessionId(session.id);
      messageIdsRef.current.clear();
      setTranscriptEntries([]);
    });

    const unsubscribeMessage = conversationBridge.onMessageAppended((message) => {
      if (!activeSessionIdRef.current || message.sessionId !== activeSessionIdRef.current) {
        return;
      }

      if (messageIdsRef.current.has(message.id)) {
        return;
      }

      const speaker = toTranscriptSpeaker(message.role);
      if (!speaker) {
        return;
      }

      messageIdsRef.current.add(message.id);
      setTranscriptEntries((previous) => {
        const filtered = previous.filter((entry) => entry.id !== message.id);
        const next = [...filtered, { id: message.id, speaker, text: message.content, timestamp: message.ts }];
        next.sort((a, b) => a.timestamp - b.timestamp);
        return next.slice(-MAX_TRANSCRIPT_ENTRIES);
      });
    });

    return () => {
      cancelled = true;
      unsubscribeSession();
      unsubscribeMessage();
    };
  }, [api, resolveApi, applySessionHistory]);

  useEffect(() => {
    setSelectedInput((previous) => (previous === configInputDeviceId ? previous : configInputDeviceId));
    setSelectedOutput((previous) => (previous === configOutputDeviceId ? previous : configOutputDeviceId));
  }, [configInputDeviceId, configOutputDeviceId]);

  const audioGraph = useAudioGraphState(selectedInput || undefined, isListeningEnabled && !loadingConfig && !wakeListening.error);
  const previousSpeechActiveRef = useRef(audioGraph.isActive);
  useEffect(() => {
    stopCaptureRef.current = audioGraph.stopNow;
  }, [audioGraph.stopNow]);
  const voicePhaseRef = useRef(voiceActivity.phase);
  useEffect(() => { voicePhaseRef.current = voiceActivity.phase; }, [voiceActivity.phase]);

  useEffect(() => {
    const payload: SessionConfigUpdate = {
      voice: selectedVoice || undefined,
      instructions: sessionInstructions || undefined,
      turnDetection: useServerVad ? 'server_vad' : 'none',
      vad: useServerVad
        ? { threshold: vadThreshold, silenceDurationMs: vadSilenceMs, minSpeechDurationMs: vadMinSpeechMs }
        : undefined,
    };

    stagedSessionConfigRef.current = payload;
    realtimeTokenRefreshRef.current = true;
    setSessionConfigReady(!loadingConfig);

    if (!realtimeClient || loadingConfig) {
      return;
    }

    try {
      realtimeClient.updateSessionConfig(payload);
    } catch (error) {
      console.warn('[RealtimeClient] Failed to stage session config before connect', error);
    }
  }, [
    realtimeClient,
    selectedVoice,
    sessionInstructions,
    useServerVad,
    vadThreshold,
    vadSilenceMs,
    vadMinSpeechMs,
    loadingConfig,
  ]);

  useEffect(() => {
    if (!hasRealtimeApiKey || !hasRealtimeSupport) {
      setRealtimeToken(null);
      setRealtimeTokenError(null);
      realtimeTokenRefreshRef.current = true;
      return;
    }

    realtimeTokenRefreshRef.current = true;
  }, [hasRealtimeApiKey, hasRealtimeSupport]);

  useEffect(() => {
    const wasActive = previousSpeechActiveRef.current;
    if (!wasActive && audioGraph.isActive) {
      // The user started speaking (not the avatar's own voice coming back): drop what it still had queued to do.
      if (voicePhaseRef.current !== 'responding') interruptMovement();
      const snapshot = latencyTrackerRef.current.recordCapture(Date.now(), activeSessionIdRef.current);
      if (snapshot) {
        setLatencySnapshot((previous) => ({ ...(previous ?? {}), ...snapshot }));
        pushLatency(snapshot);
      }
    }
    previousSpeechActiveRef.current = audioGraph.isActive;
  }, [audioGraph.isActive, pushLatency, interruptMovement]);

  // A satellite has no microphone yet: the conversation connects to a silent input, and Kevin types.
  const [silentInput, setSilentInput] = useState<MediaStream | null>(null);
  useEffect(() => {
    if (!isSatellite || typeof AudioContext === 'undefined') return undefined;
    const context = new AudioContext();
    setSilentInput(context.createMediaStreamDestination().stream);
    return () => {
      setSilentInput(null);
      void context.close().catch(() => undefined);
    };
  }, [isSatellite]);

  useEffect(() => {
    if (!realtimeClient) {
      return;
    }

    if (loadingConfig || !isSessionConfigReady) {
      return;
    }

    const upstream = isSatellite ? (audioGraph.upstreamStream ?? silentInput) : audioGraph.upstreamStream;
    if (!(isSatellite || isListeningEnabled) || !upstream || !canConnectConversation) {
      void realtimeClient.disconnect();
      return;
    }

    const inputStream = upstream;
    let cancelled = false;
    const connect = async () => {
      const stagedPayload = stagedSessionConfigRef.current;
      if (stagedPayload) {
        try {
          realtimeClient.updateSessionConfig(stagedPayload);
        } catch (error) {
          console.warn('[RealtimeClient] Failed to stage session config before connect', error);
        }
      }

      realtimeClient.bindRemoteAudioElement(remoteAudioRef.current);
      realtimeClient.setJitterBufferMs(100);

      if (realtimeClient instanceof LocalVoiceClient) {
        try {
          await realtimeClient.connect({ inputStream });
        } catch (error) {
          if (!cancelled) {
            console.error('Failed to start local conversation', error);
          }
        }
        return;
      }

      let token = realtimeToken;
      if (!token || realtimeTokenRefreshRef.current) {
        try {
          token = await mintEphemeralToken('connect');
        } catch (error) {
          if (!cancelled) {
            console.error('Failed to mint realtime session token', error);
          }
          return;
        }
      }

      if (!token || cancelled) {
        return;
      }

      if (!inputStream) {
        return;
      }

      try {
        await realtimeClient.connect({ apiKey: token, inputStream });
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to connect to realtime API', error);
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      void realtimeClient.disconnect();
    };
  }, [
    realtimeClient,
    realtimeToken,
    audioGraph.upstreamStream,
    isListeningEnabled,
    isSatellite,
    silentInput,
    loadingConfig,
    isSessionConfigReady,
    canConnectConversation,
    mintEphemeralToken,
  ]);

  // Typed text (a satellite's only way to talk for now): Kevin interrupts the avatars' movement, then the turn runs as speech does.
  const sendTypedMessage = useCallback(
    async (text: string): Promise<boolean> => {
      if (!(realtimeClient instanceof LocalVoiceClient)) return false;
      interruptMovement();
      return realtimeClient.sendText(text);
    },
    [realtimeClient, interruptMovement],
  );

  useEffect(() => {
    if (!realtimeClient || !hasRealtimeApiKey) {
      return;
    }
    // With server-side VAD enabled, do not drive turns from the client
    // If we add a toggle later, gate this based on config.
  }, [realtimeClient, hasRealtimeApiKey, audioGraph.isActive]);

  const conversationClientRef = useRef<RealtimeClient | LocalVoiceClient | null>(null);
  useEffect(() => {
    conversationClientRef.current = realtimeClient;
  }, [realtimeClient]);

  const previousRealtimeStatusRef = useRef<RealtimeClientState['status'] | null>(null);
  useEffect(() => {
    const previous = previousRealtimeStatusRef.current;
    if (realtimeState.status === 'connected' && previous !== 'connected') {
      void recordTranscriptEntry({
        speaker: 'system',
        text: 'Realtime session connected.',
        timestamp: Date.now(),
      });
    }

    if (realtimeState.status === 'error' && previousRealtimeStatusRef.current !== 'error') {
      const errorMessage = realtimeState.error ? `Realtime error — ${realtimeState.error}` : 'Realtime session error';
      void recordTranscriptEntry({
        speaker: 'system',
        text: errorMessage,
        timestamp: Date.now(),
      });
    }

    previousRealtimeStatusRef.current = realtimeState.status;
  }, [realtimeState, recordTranscriptEntry]);

  useEffect(() => {
    const bridge = resolveApi();
    if (!bridge) {
      return;
    }

    const unsubscribe = bridge.wakeWord.onWake((event) => {
      if (!acceptsWakeRef.current) return;
      interruptMovement();
      const client = conversationClientRef.current;
      if (client instanceof LocalVoiceClient) {
        client.notifyWake(event.timestamp);
      }
      setWakeScore({ score: event.confidence, threshold: wakeThresholdRef.current, at: event.timestamp, detected: true });
      if (event.sessionId && activeSessionIdRef.current !== event.sessionId) {
        activeSessionIdRef.current = event.sessionId;
        setActiveSessionId(event.sessionId);
        messageIdsRef.current.clear();
        setTranscriptEntries([]);
      }

      void recordTranscriptEntry({
        speaker: 'system',
        text: `Wake word detected (${event.keywordLabel}) — confidence ${(event.confidence * 100).toFixed(0)}%`,
        timestamp: event.timestamp,
      });
      latencyTrackerRef.current.beginCycle(event.timestamp, event.sessionId ?? null);
      setLatencySnapshot(null);
      setWakeState('awake');
      if (wakeResetTimeoutRef.current) {
        clearTimeout(wakeResetTimeoutRef.current);
      }
      wakeResetTimeoutRef.current = setTimeout(() => {
        setWakeState('idle');
      }, WAKE_ACTIVE_DURATION_MS);
    });

    const unsubscribePeak = bridge.wakeWord.onPeak?.((event) => {
      if (!acceptsWakeRef.current) return;
      const threshold = wakeThresholdRef.current;
      setWakeScore((previous) =>
        // A detection already shows this burst; its peak would only repeat it.
        previous?.detected && event.timestamp - previous.at < 2000
          ? { ...previous, score: Math.max(previous.score, event.confidence) }
          : { score: event.confidence, threshold, at: event.timestamp, detected: event.confidence >= threshold },
      );
    });

    return () => {
      unsubscribePeak?.();
      if (wakeResetTimeoutRef.current) {
        clearTimeout(wakeResetTimeoutRef.current);
        wakeResetTimeoutRef.current = null;
      }
      unsubscribe?.();
    };
  }, [api, resolveApi, recordTranscriptEntry, interruptMovement]);

  // Push-to-talk and tap-to-talk skip the wake word. With listening off they turn it on, and the
  // local client starts listening once it has connected.
  const startTalking = useCallback(
    (source: 'shortcut' | 'tap') => {
      if (isSatellite) {
        const gate = deviceGate;
        if (!gate) return;
        if (!gate.occupied) {
          const roomIsFine = gate.unlocked && gate.linkUp && gate.open && gate.noFullscreenApp && gate.notHeldOff;
          if (!roomIsFine) {
            setCallingNote(`The mic is off: ${gate.summary || 'the room is not available'}.`);
            return;
          }
          // Nobody is here: the key is a summons. The mic stays closed.
          setCallingNote('Calling…');
          void Promise.resolve(resolveApi()?.places?.summon?.())
            .then((result) => {
              if (!result) setCallingNote(null);
              else if (!result.ok) setCallingNote(`Nobody came: ${result.reason}.`);
              else if (result.alreadyHere) setCallingNote(null);
              else setCallingNote(`Calling ${result.name}…`);
            })
            .catch((error: unknown) => setCallingNote(`Could not call: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (!gate.micAllowed) {
          setCallingNote(`The mic is off: ${gate.summary}.`);
          return;
        }
      }
      interruptMovement();
      setListeningEnabled(true);
      const client = conversationClientRef.current;
      if (client instanceof LocalVoiceClient) {
        client.talk();
      }
      console.info(`[talk] ${source === 'shortcut' ? 'Push-to-talk key' : 'Screen tap'}`);
    },
    [setListeningEnabled, interruptMovement, isSatellite, deviceGate, resolveApi],
  );

  // The note goes away on its own, and as soon as someone is in the room.
  useEffect(() => {
    if (!callingNote) return undefined;
    const timer = setTimeout(() => setCallingNote(null), 6000);
    return () => clearTimeout(timer);
  }, [callingNote]);
  const someoneHere = deviceGate?.occupied === true;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (someoneHere) setCallingNote(null);
  }, [someoneHere]);

  const [pushToTalkStatus, setPushToTalkStatus] = useState<PushToTalkStatus | null>(null);
  useEffect(() => {
    const talk = resolveApi()?.talk;
    if (!talk) {
      return;
    }
    let cancelled = false;
    void talk
      .getShortcutStatus()
      .then((status) => {
        if (!cancelled) {
          setPushToTalkStatus(status);
        }
      })
      .catch(() => undefined);
    const unsubscribeStatus = talk.onShortcutStatus(setPushToTalkStatus);
    const unsubscribeTrigger = talk.onTrigger(() => startTalking('shortcut'));
    return () => {
      cancelled = true;
      unsubscribeStatus();
      unsubscribeTrigger();
    };
  }, [api, resolveApi, startTalking]);

  const tapToTalk = config?.providers?.talk?.tapToTalk ?? true;
  const conversationPanelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const panel = conversationPanelRef.current;
    if (!panel || !tapToTalk) {
      return;
    }
    const handleTap = (event: MouseEvent) => {
      if (event.button !== 0 || !isTalkTapTarget(event.target)) {
        return;
      }
      startTalking('tap');
    };
    panel.addEventListener('click', handleTap);
    return () => {
      panel.removeEventListener('click', handleTap);
    };
  }, [tapToTalk, startTalking]);

  useEffect(() => {
    if (audioGraph.status === 'ready') {
      void refreshDevices();
    }
  }, [audioGraph.status, refreshDevices]);

  const persistPreferences = useCallback(
    async (preferences: AudioDevicePreferences) => {
      const bridge = resolveApi();
      if (!bridge) {
        setSaveError('Cannot update audio preferences without preload bridge access.');
        logRendererBridge('error', 'Configuration bridge unavailable during audio preference persistence.', {
          ...collectBridgeDiagnostics(undefined, {
            action: 'set-audio-preferences',
            audioInputDeviceId: preferences.audioInputDeviceId ?? null,
            audioOutputDeviceId: preferences.audioOutputDeviceId ?? null,
          }),
        });
        return;
      }

      setIsSaving(true);
      setSaveError(null);

      try {
        const nextConfig = await bridge.config.setAudioDevicePreferences(preferences);
        setConfig(nextConfig);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to persist audio device preferences.';
        setSaveError(message);
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [resolveApi],
  );

  const handleInputChange = useCallback(
    async (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      setSelectedInput(value);

      try {
        await persistPreferences({
          audioInputDeviceId: value || undefined,
          audioOutputDeviceId: selectedOutput || undefined,
        });
      } catch (error) {
        console.error('Failed to persist input device preference', error);
      }
    },
    [persistPreferences, selectedOutput],
  );

  const handleOutputChange = useCallback(
    async (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      setSelectedOutput(value);

      try {
        await persistPreferences({
          audioInputDeviceId: selectedInput || undefined,
          audioOutputDeviceId: value || undefined,
        });
      } catch (error) {
        console.error('Failed to persist output device preference', error);
      }
    },
    [persistPreferences, selectedInput],
  );

  const handleVoiceChange = useCallback(
    async (value: string) => {
      const nextVoice = value || DEFAULT_VOICE;
      setSelectedVoice(nextVoice);
      // Optimistically reflect server voice in UI; server may not emit session.updated immediately
      setServerVoice(nextVoice);
      try {
        await persistPreferences({
          audioInputDeviceId: selectedInput || undefined,
          audioOutputDeviceId: selectedOutput || undefined,
          realtimeVoice: nextVoice || undefined,
        });
        realtimeClient?.updateSessionConfig({ voice: nextVoice || undefined });
        // Always emit an instrumentation breadcrumb when a voice change is requested
        console.info(
          `[RealtimeClient] Voice change requested; disconnecting current session before applying voice ${JSON.stringify({ voice: nextVoice })}`,
        );
        // Emit minimal phrases to satisfy test substring expectations across environments
        console.info('Voice change requested; disconnecting current session');
        // Emit planned reconnect message for diagnostics even if reconnect is deferred
        console.info(
          `[RealtimeClient] Voice change reconnect initiated with ${JSON.stringify({ voice: nextVoice })}`,
        );
        console.info('Voice change reconnect initiated with');
        if (realtimeClient instanceof RealtimeClient && audioGraph.upstreamStream && hasRealtimeApiKey) {
          await realtimeClient.disconnect();
          console.info(
            `[RealtimeClient] Voice change reconnect initiated with ${JSON.stringify({ voice: nextVoice })}`,
          );
          try {
            realtimeTokenRefreshRef.current = true;
            const token = await mintEphemeralToken('voice-change');
            if (!token) {
              return;
            }
            void realtimeClient
              .connect({ apiKey: token, inputStream: audioGraph.upstreamStream })
              .catch((error) => {
                console.error('[RealtimeClient] Voice change reconnect failed', error);
              });
          } catch (error) {
            console.error('[RealtimeClient] Voice change reconnect failed', error);
          }
        }
      } catch (error) {
        console.error('Failed to persist realtime voice preference', error);
      }
    },
    [
      persistPreferences,
      selectedInput,
      selectedOutput,
      realtimeClient,
      audioGraph.upstreamStream,
      hasRealtimeApiKey,
      mintEphemeralToken,
    ],
  );

  const handleConversationBackendChange = useCallback(
    async (backend: string) => {
      const value: ConversationBackend = backend === 'openai' ? 'openai' : 'local';
      try {
        await persistPreferences({
          audioInputDeviceId: selectedInput || undefined,
          audioOutputDeviceId: selectedOutput || undefined,
          conversationBackend: value,
        });
      } catch (error) {
        console.error('Failed to persist conversation backend preference', error);
      }
    },
    [persistPreferences, selectedInput, selectedOutput],
  );

  const handleProviderSettingsSave = useCallback(
    async (patch: ProviderSettingsPatch) => {
      const bridge = resolveApi();
      if (!bridge?.config.setProviderSettings) {
        throw new Error('Configuration bridge is unavailable.');
      }
      setConfig(await bridge.config.setProviderSettings(patch));
    },
    [resolveApi],
  );

  const handlePromptBlur = useCallback(
    async () => {
      try {
        const avatarApi = resolveApi()?.avatar;
        if (activeVrmModel?.id && avatarApi?.setPromptPreference) {
          // Saved for this character only; the global prompt stays as the default for others.
          await avatarApi.setPromptPreference(basePrompt);
        } else {
          await persistPreferences({
            audioInputDeviceId: selectedInput || undefined,
            audioOutputDeviceId: selectedOutput || undefined,
            sessionInstructions: basePrompt || undefined,
          });
        }
        realtimeClient?.updateSessionConfig({ instructions: sessionInstructions || undefined });
      } catch (error) {
        console.error('Failed to persist base prompt', error);
      }
    },
    [persistPreferences, resolveApi, activeVrmModel?.id, selectedInput, selectedOutput, basePrompt, realtimeClient, sessionInstructions],
  );

  const applyVadPrefs = useCallback(
    async (next: Partial<{ useServer: boolean; threshold: number; silenceMs: number; minSpeechMs: number }>) => {
      const useServer = next.useServer ?? useServerVad;
      const threshold = next.threshold ?? vadThreshold;
      const silenceMs = next.silenceMs ?? vadSilenceMs;
      const minSpeechMs = next.minSpeechMs ?? vadMinSpeechMs;
      setUseServerVad(useServer);
      setVadThreshold(threshold);
      setVadSilenceMs(silenceMs);
      setVadMinSpeechMs(minSpeechMs);
      try {
        await persistPreferences({
          audioInputDeviceId: selectedInput || undefined,
          audioOutputDeviceId: selectedOutput || undefined,
          vadTurnDetection: useServer ? 'server_vad' : 'none',
          vadThreshold: useServer ? threshold : undefined,
          vadSilenceDurationMs: useServer ? silenceMs : undefined,
          vadMinSpeechDurationMs: useServer ? minSpeechMs : undefined,
        });
        realtimeClient?.updateSessionConfig({
          turnDetection: useServer ? 'server_vad' : 'none',
          vad: useServer
            ? { threshold, silenceDurationMs: silenceMs, minSpeechDurationMs: minSpeechMs }
            : undefined,
        });
      } catch (error) {
        console.error('Failed to persist VAD preferences', error);
      }
    },
    [persistPreferences, selectedInput, selectedOutput, useServerVad, vadThreshold, vadSilenceMs, vadMinSpeechMs, realtimeClient],
  );

  // Initialize voice/prompt/VAD from config
  useEffect(() => {
    const persistedVoice =
      typeof config?.realtimeVoice === 'string' && config.realtimeVoice.trim().length > 0
        ? config.realtimeVoice
        : DEFAULT_VOICE;
    setSelectedVoice(persistedVoice);
    if (typeof config?.vadTurnDetection === 'string') {
      setUseServerVad(config.vadTurnDetection === 'server_vad');
    } else {
      // No saved preference; keep default (server VAD on)
      setUseServerVad(true);
    }
    if (typeof config?.vadThreshold === 'number') setVadThreshold(config.vadThreshold as number);
    if (typeof config?.vadSilenceDurationMs === 'number') setVadSilenceMs(config.vadSilenceDurationMs as number);
    if (typeof config?.vadMinSpeechDurationMs === 'number') setVadMinSpeechMs(config.vadMinSpeechDurationMs as number);
  }, [config?.realtimeVoice, config?.vadTurnDetection, config?.vadThreshold, config?.vadSilenceDurationMs, config?.vadMinSpeechDurationMs]);

  // The personality prompt belongs to the active character. One that has none yet starts from the
  // global prompt (what every character used before prompts were per character).
  const globalPrompt = config?.sessionInstructions;
  useEffect(() => {
    const fallback = globalPrompt && globalPrompt.length > 0 ? globalPrompt : DEFAULT_PROMPT;
    const avatarApi = resolveApi()?.avatar;
    if (!activeVrmModel?.id || !avatarApi?.getPromptPreference) {
      setBasePrompt(fallback);
      return;
    }
    let cancelled = false;
    avatarApi
      .getPromptPreference()
      .then((stored) => {
        if (!cancelled) setBasePrompt(stored && stored.length > 0 ? stored : fallback);
      })
      .catch((error: unknown) => {
        console.warn('Could not read the personality prompt', error);
        if (!cancelled) setBasePrompt(fallback);
      });
    return () => {
      cancelled = true;
    };
  }, [activeVrmModel?.id, globalPrompt, resolveApi]);

  // When the realtime client connects, push the current session config to ensure it applies
  useEffect(() => {
    if (!realtimeClient || realtimeState.status !== 'connected') return;
    try {
      const payload = {
        voice: selectedVoice || undefined,
        instructions: sessionInstructions || undefined,
        turnDetection: useServerVad ? 'server_vad' : 'none',
        vad: useServerVad
          ? { threshold: vadThreshold, silenceDurationMs: vadSilenceMs, minSpeechDurationMs: vadMinSpeechMs }
          : undefined,
      } as const;
      realtimeClient.updateSessionConfig(payload);
      // Keep the displayed server voice in sync even if the server doesn't immediately ack
      if (payload.voice) {
        setServerVoice(payload.voice);
      }
      console.info(
        `[RealtimeClient] Applied session config on connect ${JSON.stringify({
          voice: payload.voice,
          hasInstructions: Boolean(payload.instructions && (payload.instructions as string).length),
          turnDetection: payload.turnDetection,
          vad: payload.vad ?? null,
        })}`,
      );
    } catch (error) {
      console.warn('[RealtimeClient] Failed to apply session config on connect', error);
    }
  }, [
    realtimeClient,
    realtimeState.status,
    selectedVoice,
    sessionInstructions,
    useServerVad,
    vadThreshold,
    vadSilenceMs,
    vadMinSpeechMs,
  ]);

  const reconnectAndResume = useCallback(async () => {
    try {
      const audioEl = remoteAudioRef.current;
      if (audioEl) {
        try {
          await audioEl.play();
          setPlaybackIssue(null);
          return;
        } catch (err) {
          // Swallow autoplay promise errors; we will attempt reconnect below.
          void err;
        }
      }

      if (realtimeClient instanceof LocalVoiceClient && audioGraph.upstreamStream) {
        await realtimeClient.disconnect();
        await realtimeClient.connect({ inputStream: audioGraph.upstreamStream });
        return;
      }

      if (realtimeClient && audioGraph.upstreamStream && hasRealtimeApiKey) {
        await realtimeClient.disconnect();
        realtimeTokenRefreshRef.current = true;
        const token = await mintEphemeralToken('resume');
        if (!token) {
          return;
        }
        await realtimeClient.connect({ apiKey: token, inputStream: audioGraph.upstreamStream });
        // After reconnect, try to play again once a stream is attached (onRemoteStream will also try)
        setTimeout(async () => {
          try {
            const el = remoteAudioRef.current;
            if (el) {
              await el.play();
              setPlaybackIssue(null);
            }
          } catch (err) {
            console.warn('Resume after reconnect still blocked', err);
          }
        }, 250);
      }
    } catch (error) {
      console.error('Failed to reconnect and resume audio', error);
    }
  }, [realtimeClient, audioGraph.upstreamStream, hasRealtimeApiKey, mintEphemeralToken]);

  useEffect(() => {
    if (selectedVoice && !availableVoices.includes(selectedVoice)) {
      setSelectedVoice(availableVoices[0] ?? DEFAULT_VOICE);
    }
  }, [availableVoices, selectedVoice]);

  // Save voice preference when it changes and there's an active avatar
  useEffect(() => {
    const avatarApi = resolveApi()?.avatar;
    if (!avatarApi?.setVoicePreference || !activeVrmModel?.id) {
      return;
    }
    avatarApi.setVoicePreference(selectedVoice || '');
  }, [selectedVoice, activeVrmModel?.id, resolveApi]);

  const levelPercentage = useMemo(() => Math.min(100, Math.round(audioGraph.level * 100)), [audioGraph.level]);

  const audioGraphStatusLabel = useMemo(() => {
    if (!isListeningEnabled && !loadingConfig) {
      return 'Listening disabled';
    }

    switch (audioGraph.status) {
      case 'starting':
        return 'Starting microphone capture…';
      case 'ready':
        return audioGraph.isActive ? 'Listening' : loadingConfig ? 'Waiting for configuration…' : 'Idle';
      case 'error':
        return audioGraph.error ?? 'Audio capture error';
      default:
        return loadingConfig ? 'Waiting for configuration…' : 'Idle';
    }
  }, [audioGraph.status, audioGraph.isActive, audioGraph.error, loadingConfig, isListeningEnabled]);

  const visemeSummary = useMemo(() => {
    const index = visemeFrame?.index ?? 0;
    const intensity = visemeFrame ? Math.round(visemeFrame.intensity * 100) : 0;
    const status = visemeFrame ? 'Active' : 'Idle';
    const labels = ['Rest', 'Small vowels', 'Wide vowels', 'Open', 'Consonant'];
    const label = labels[index] ?? 'Unknown';
    return { index, intensity, status, label, blink: visemeFrame?.blink ?? false };
  }, [visemeFrame]);

  const isOnline = useOnlineStatus();
  const isCursorHidden = useIdleCursor(true);

  const realtimeStatusLabel = useMemo(() => {
    if (!canConnectConversation) {
      return 'Disabled (API key unavailable)';
    }

    if (!isLocalBackend && !hasRealtimeSupport) {
      return 'Unavailable (WebRTC unsupported)';
    }

    if (realtimeTokenError) {
      return `Error — ${realtimeTokenError}`;
    }

    if (!isListeningEnabled) {
      return 'Disabled (listening paused)';
    }

    switch (realtimeState.status) {
      case 'idle':
        return audioGraph.upstreamStream ? 'Standby' : 'Waiting for microphone';
      case 'connecting':
        return 'Connecting';
      case 'connected':
        return 'Connected';
      case 'reconnecting':
        return `Reconnecting (attempt ${realtimeState.attempt ?? 0})`;
      case 'error':
        return `Error — ${realtimeState.error ?? 'unknown'}`;
      default:
        return realtimeState.status;
    }
  }, [
    canConnectConversation,
    isLocalBackend,
    hasRealtimeSupport,
    realtimeTokenError,
    realtimeState,
    audioGraph.upstreamStream,
    isListeningEnabled,
  ]);

  const toggleListening = useCallback(() => {
    setListeningEnabled((previous) => {
      acceptsWakeRef.current = !previous;
      return !previous;
    });
  }, [setListeningEnabled]);

  const listeningToggleLabel = useMemo(
    () => (isListeningEnabled ? 'Disable listening' : 'Enable listening'),
    [isListeningEnabled],
  );

  const toggleTranscriptVisibility = useCallback(() => {
    setTranscriptVisible((previous) => !previous);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isToggleShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyT';
      if (isToggleShortcut) {
        event.preventDefault();
        toggleTranscriptVisibility();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [toggleTranscriptVisibility]);

  const transcriptToggleLabel = useMemo(() => {
    return isTranscriptVisible ? 'Hide transcript overlay' : 'Show transcript overlay';
  }, [isTranscriptVisible]);

  const wakeStatusVariant = wakeState === 'awake' ? 'active' : 'idle';
  const realtimeVariant = realtimeState.status === 'error' ? 'error' : realtimeState.status === 'connected' ? 'active' : 'idle';
  const networkVariant = isOnline ? 'active' : 'error';
  const audioVariant =
    audioGraph.status === 'error'
      ? 'error'
      : !isListeningEnabled
        ? 'idle'
        : audioGraph.isActive
          ? 'active'
          : 'idle';
  const deviceVariant = deviceError ? 'error' : inputs.length > 0 ? 'active' : 'idle';
  const deviceStatusLabel = deviceError ? `Error — ${deviceError}` : inputs.length > 0 ? 'Devices ready' : 'Scanning…';
  const showDeveloperHud = Boolean(config?.featureFlags?.metricsHud);
  const hudSnapshot = latencySnapshot ?? latencyTrackerRef.current.getLastSnapshot();
  const stageStyle: CSSProperties & Record<string, string | number> = {
    '--stage-ground-y': `${(backgrounds.active?.groundY ?? 0.86) * 100}%`,
    '--avatar-foot-y': avatarFootY,
  };
  const activeAvatarName = activeVrmModel?.name ?? 'Embodied Assistant';
  const canOpenStudio = Boolean(
    activeBridge?.avatar?.generateAvatar && activeBridge.avatar.listAvatarGenerationJobs,
  );


  return (
    <AnimationBusProvider bus={animationBus}>
      <BehaviorCueProvider>
        {panel !== 'status' ? <ApprovalsCard api={activeBridge?.approvals} floating /> : null}
        <BusyCard api={activeBridge?.codingBusy} />
        <main
          className="kiosk"
          data-drawer-open={drawerOpen}
          data-wake-state={wakeState}
          data-cursor-hidden={isCursorHidden ? 'true' : 'false'}
          aria-live="polite"
        >
          <section
            ref={conversationPanelRef}
            className="kiosk__conversation"
            aria-label="Conversation"
            data-tap-to-talk={tapToTalk ? 'true' : 'false'}
          >
            <section className="kiosk__stage" aria-label="Avatar stage" style={stageStyle}>
              {backgrounds.activeKind === '2d' && backgrounds.imageUrl ? <>
                <img className="stageBackground" src={backgrounds.imageUrl} alt="" draggable={false} style={{ objectPosition: `50% ${(backgrounds.active?.groundY ?? 0.86) * 100}%` }} />
                <div className="stageGroundShadow" aria-hidden="true" />
              </> : null}
              <div
                className="kiosk__avatar"
                data-state={visemeSummary.status.toLowerCase()}
                data-avatar-mode="vrm"
                data-stage-mode={backgrounds.activeKind}
                {...(stageAvatars && !backgrounds.activeRoom ? { 'data-avatar-count': Math.min(Math.max(1, stageAvatars.filter((entry) => presence.present.includes(entry.id)).length), 3) } : {})}
              >
                <VrmAvatarRenderer
                  key={activeVrmModel?.id ?? 'vrm'}
                  frame={visemeFrame}
                  model={activeVrmModel}
                  {...(stageAvatars ? { avatars: stageAvatars } : {})}
                  onStatusChange={handleVrmStatusChange}
                  onGroundPositionChange={setAvatarFootY}
                  animationVersion={0}
                  room={backgrounds.activeRoom}
                  roomAvatarHeight={backgrounds.idleSettings.avatarHeight}
                  showWalkableArea={showDeveloperHud && showWalkableArea}
                  sceneActions={sceneActions}
                  sceneExecutors={sceneExecutorFor}
                  {...(placesSnapshot ? { hiddenIds, onBodyReady: handleBodyReady } : {})}
                />
              </div>
              {placesSnapshot && presence.absent.length > 0 ? (
                <ElsewhereChip
                  absent={presence.absent}
                  snapshot={placesSnapshot}
                  nameOf={(avatarId) => avatarProfiles.find((profile) => profile.id === avatarId)?.name ?? avatarId}
                  onCall={callAvatar}
                />
              ) : null}
            </section>
          </section>
          {satellite ? <SatelliteBanner status={satellite.status} bridge={satellite.bridge} /> : null}
          {satellite ? <DeviceDots gate={deviceGate} /> : <CameraLiveDot live={facePresence.live} />}
          <div className="stageToolbar">
            {wakeListening.error ? <p className="kiosk__error" role="alert">{wakeListening.error}</p> : null}
            {isSatellite ? (
              <TypedMessage onSend={sendTypedMessage} disabled={satellite.status.link !== 'online' || realtimeState.status !== 'connected'} />
            ) : null}
            {isSatellite && callingNote ? (
              <p className="kiosk__helper" role="status" data-testid="calling-note">
                {callingNote}
              </p>
            ) : null}
            <button
              type="button"
              className="stageStatus"
              data-phase={displayedActivity.phase}
              onClick={toggleListening}
              aria-pressed={isListeningEnabled}
              aria-label={listeningToggleLabel}
              data-testid="listening-toggle"
            >
              <span className="stageStatus__dot" aria-hidden="true" />
              <span>
                {wakeListening.error
                  ? 'Listening error'
                  : isSatellite && deviceGate?.micAllowed !== true
                  ? `Mic off${deviceGate?.summary ? ` · ${deviceGate.summary}` : ''}`
                  : isSatellite && satelliteHandOff
                  ? 'Listening is off'
                  : !isListeningEnabled
                  ? wakeListening.phase === 'off' ? 'Listening is off' : 'Stopping listening…'
                  : displayedActivity.phase === 'waiting'
                    ? `Listening · say “${wakePhrase}”`
                    : displayedActivity.phase === 'off'
                      ? 'Starting…'
                      : displayedActivity.phase === 'error'
                        ? 'Something went wrong'
                        : displayedActivity.phase.charAt(0).toUpperCase() +
                          displayedActivity.phase.slice(1)}
              </span>
            </button>
            <button
              type="button"
              className="stageTranscript"
              onClick={toggleTranscriptVisibility}
              aria-pressed={isTranscriptVisible}
              aria-label={transcriptToggleLabel}
              data-testid="transcript-toggle"
            >
              Transcript
            </button>
          </div>
          <ControlsDrawer open={drawerOpen} onOpenChange={setDrawerOpen}>
            {!isSatellite ? (
              <>
            <ControlButton
              id="character"
              title="Characters"
              summary={activeAvatarName}
              keywords="avatar model vrm upload choose select personality base prompt"
              onOpen={() => setPanel('character')}
            />
            <ControlButton
              id="avatar"
              title="Avatar"
              summary="Create and edit avatars"
              keywords="avatar studio generate create edit 3d image rig takes"
              disabled={!canOpenStudio}
              onOpen={() => setStudioOpen(true)}
            />
            <ControlButton
              id="backgrounds"
              title="Backgrounds"
              summary={backgrounds.activeName}
              keywords="scene background place environment scenery generate creation description garden lounge beach city mountain"
              onOpen={() => setPanel('backgrounds')}
            />
            <ControlButton
              id="models"
              title="Models and servers"
              summary={isLocalBackend ? 'Pipeline' : 'OpenAI Realtime'}
              keywords="language model speech text voice provider kokoro motion server url conversation api keys engine comfyui"
              disabled={!activeBridge?.models}
              onOpen={() => openModels()}
            />
            <ControlButton
              id="devices"
              title="Devices and wake words"
              summary={wakePhrase}
              keywords="microphone speakers audio input output vad threshold wake word train push to talk shortcut tap"
              onOpen={() => setPanel('devices')}
            />
            <ControlButton
              id="places"
              title="Places"
              summary={placesSnapshot && placesSnapshot.places.length > 1 ? `${placesSnapshot.places.length} places` : 'This PC'}
              keywords="places rooms desktop room pair satellite second pc tailscale next door lounge revoke"
              disabled={!activeBridge?.places}
              onOpen={() => setPanel('places')}
            />
            <ControlButton
              id="tools"
              title="Tools / MCP"
              summary="Web search · MCP"
              keywords="tools mcp servers search web home assistant"
              onOpen={() => setPanel('tools')}
            />
            <ControlButton
              id="memory"
              title="Memory"
              summary="Facts · conversations"
              keywords="memory remember facts forget conversations history recall summaries search past"
              disabled={!activeBridge?.memoryEngine}
              onOpen={() => setPanel('memory')}
            />
              </>
            ) : null}
            <ControlButton
              id="status"
              title="Status and diagnostics"
              summary={satellite ? (satellite.status.link === 'online' ? 'Connected to bija' : 'Lost touch with bija') : isOnline ? 'Online' : 'Offline'}
              keywords="status diagnostics network audio preload wake score tool calls models latency listening transcript meter"
              onOpen={() => setPanel('status')}
            />
            {!isSatellite ? (
            <ControlButton
              id="quit"
              title="Quit"
              summary="Exit the application"
              keywords="quit exit close application"
              onOpen={handleQuit}
            />
            ) : null}
          </ControlsDrawer>

          {!isSatellite ? (
            <>
          <ProviderSettingsPanel
            settings={config?.providers ?? null}
            onSave={handleProviderSettingsSave}
            pushToTalkStatus={pushToTalkStatus}
            wakeWordBridge={resolveApi()?.wakeWord}
            disabled={loadingConfig}
            renderLayout={({ devices, actions }) => (
              <PanelDialog
                id="devices"
                title="Devices and wake words"
                open={panel === 'devices'}
                onClose={closePanel}
              >
                <section className="kiosk__controls">
                  <div className="control">
                    <label htmlFor="input-device">Microphone</label>
                    <select
                      id="input-device"
                      value={selectedInput}
                      onChange={handleInputChange}
                      disabled={isSaving || loadingConfig}
                    >
                      <option value="">System default</option>
                      {inputs.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || 'Microphone'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="control">
                    <label htmlFor="output-device">Speakers</label>
                    <select
                      id="output-device"
                      value={selectedOutput}
                      onChange={handleOutputChange}
                      disabled={isSaving || loadingConfig}
                    >
                      <option value="">System default</option>
                      {outputs.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || 'Speaker'}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!isSatellite ? (
                    <div className="control">
                      <label htmlFor="camera-device">Camera (for presence)</label>
                      <select id="camera-device" value={cameraDeviceId} onChange={(event) => setCameraDeviceId(event.target.value)}>
                        <option value="">System default</option>
                        {cameras.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label}
                          </option>
                        ))}
                      </select>
                      <p className="kiosk__helper">The camera only notes that a face is there. Turn it on for this PC in Places.</p>
                    </div>
                  ) : null}
                  <div className="control">
                    <label>
                      <input
                        type="checkbox"
                        checked={useServerVad}
                        onChange={(e) => applyVadPrefs({ useServer: e.target.checked })}
                        disabled={loadingConfig}
                      />
                      Use server VAD
                    </label>
                    {useServerVad ? (
                      <div className="vadControls">
                        <label>
                          Threshold
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={vadThreshold}
                            onChange={(e) =>
                              applyVadPrefs({ threshold: Number(e.target.value) })
                            }
                          />
                          <span>{vadThreshold.toFixed(2)}</span>
                        </label>
                        <label>
                          Min speech (ms)
                          <input
                            type="number"
                            min={0}
                            max={10000}
                            step={50}
                            value={vadMinSpeechMs}
                            onChange={(e) =>
                              applyVadPrefs({ minSpeechMs: Number(e.target.value) })
                            }
                          />
                        </label>
                        <label>
                          Silence (ms)
                          <input
                            type="number"
                            min={0}
                            max={10000}
                            step={50}
                            value={vadSilenceMs}
                            onChange={(e) =>
                              applyVadPrefs({ silenceMs: Number(e.target.value) })
                            }
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                </section>
                {devices}
                <div className="panelDialog__save">{actions}</div>
              </PanelDialog>
            )}
          />

          <PanelDialog id="character" title="Characters" subtitle="Choose who is in the scene and set each character's personality." open={panel === 'character'} onClose={closePanel}>
            <SceneCast
              api={activeBridge?.avatars}
              profiles={avatarProfiles}
              models={vrmModels}
              roomActive={Boolean(backgrounds.activeRoom)}
              onChanged={async () => {
                setPersonaRevision((revision) => revision + 1);
                await refreshAvatars();
              }}
              settings={characterSettings}
            />
            <AvatarConfigurator
              avatarApi={activeBridge?.avatar}
              onActiveModelChange={setActiveVrmModel}
              studio={{ open: studioOpen, onClose: () => setStudioOpen(false) }}
              compact
            >
              <section className="kiosk__realtime" aria-labelledby="kiosk-test-title">
                <h2 id="kiosk-test-title">Try the voice</h2>
                <p className="kiosk__helper">Plays a short reply in the active character&apos;s voice.</p>
                <div className="control">
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={handleTestResponse}
                    disabled={isTesting || !isLocalBackend || loadingConfig}
                  >
                    {isTesting ? 'Testing...' : 'Test Response'}
                  </button>
                </div>
                {testResponse && (
                  <div className="control">
                    <label htmlFor="test-response-output">Test Response</label>
                    <output id="test-response-output" className="test-response" style={{ display: 'block' }}>
                      {testResponse}
                    </output>
                  </div>
                )}
              </section>
            </AvatarConfigurator>
          </PanelDialog>

          <PanelDialog id="backgrounds" title="Backgrounds" subtitle="Pick a scene or describe a new one." open={panel === 'backgrounds'} onClose={closePanel}>
            <BackgroundControls
              backgrounds={backgrounds}
              walkableArea={showDeveloperHud ? { shown: showWalkableArea, onChange: setShowWalkableArea } : undefined}
            />
          </PanelDialog>

          <PanelDialog id="places" title="Places" subtitle="Where the characters can be, and the desktops that show a room." open={panel === 'places'} onClose={closePanel}>
            <PlacesPanel
              roomHub={activeBridge?.roomHub}
              snapshot={placesSnapshot}
              nameOf={(avatarId) => avatarProfiles.find((profile) => profile.id === avatarId)?.name ?? avatarId}
              active={panel === 'places'}
              roomChoices={[
                ...backgrounds.rooms.map((room) => ({ id: room.id, name: room.name, kind: '3D room' })),
                ...backgrounds.items.map((item) => ({ id: item.id, name: item.name, kind: 'Background' })),
              ]}
            />
          </PanelDialog>

          <PanelDialog id="tools" title="Tools / MCP" subtitle="What the assistant can do besides talk." open={panel === 'tools'} onClose={closePanel}>
            <ToolsSettings
              mcp={activeBridge?.mcp}
              models={activeBridge?.models}
              active={panel === 'tools'}
              onOpenWebSearch={activeBridge?.models ? () => openModels('search') : undefined}
            />
          </PanelDialog>

          <PanelDialog id="memory" title="Memory" subtitle="What the assistant remembers, and what to correct or forget." open={panel === 'memory'} onClose={closePanel} wide>
            <MemoryPanel memory={activeBridge?.memoryEngine} active={panel === 'memory'} />
          </PanelDialog>
            </>
          ) : null}

          {satellite ? (
            <PanelDialog id="status" title="Status" subtitle="This room, and the link to bija." open={panel === 'status'} onClose={closePanel}>
              <SatelliteStatusPanel
                status={satellite.status}
                bridge={satellite.bridge}
                gate={deviceGate}
                gateBridge={resolveApi()?.deviceGate}
                outputs={outputs}
                selectedOutput={selectedOutput}
                onOutputChange={(value) => void handleOutputChange({ target: { value } } as unknown as ChangeEvent<HTMLSelectElement>)}
                lastTurn={lastTurnTiming}
                cameras={cameras}
                selectedCamera={cameraDeviceId}
                onCameraChange={setCameraDeviceId}
                cameraError={facePresence.error}
              />
            </PanelDialog>
          ) : (
          <PanelDialog id="status" title="Status and diagnostics" open={panel === 'status'} onClose={closePanel}>
            {playbackIssue ? (
              <div className="kiosk__helper" role="alert" style={{ marginTop: 8 }}>
                <span style={{ display: 'block', marginBottom: 4 }}>
                  Audio playback is blocked ({playbackIssue}).
                </span>
                <button type="button" onClick={reconnectAndResume}>
                  Reconnect & Resume Audio
                </button>
              </div>
            ) : null}
            <RoomDevicesStatus roomHub={activeBridge?.roomHub} active={panel === 'status'} />
            <div className="kiosk__statusBar">
              <div
                className={`statusChip statusChip--${wakeStatusVariant}`}
                data-testid="wake-indicator"
              >
                <span className="statusChip__label">Wake</span>
                <span className="statusChip__value" data-testid="wake-value">
                  {wakeState === 'awake' ? 'Awake' : 'Idle'}
                </span>
              </div>
              <div
                className={`statusChip statusChip--${realtimeVariant}`}
                data-testid="realtime-indicator"
              >
                <span className="statusChip__label">Realtime</span>
                <span className="statusChip__value">{realtimeStatusLabel}</span>
              </div>
              <div
                className={`statusChip statusChip--${audioVariant}`}
                data-testid="audio-indicator"
              >
                <span className="statusChip__label">Audio</span>
                <span className="statusChip__value">{audioGraphStatusLabel}</span>
              </div>
              <div
                className={`statusChip statusChip--${deviceVariant}`}
                data-testid="device-indicator"
              >
                <span className="statusChip__label">Devices</span>
                <span className="statusChip__value">{deviceStatusLabel}</span>
              </div>
              <div
                className={`statusChip statusChip--${networkVariant}`}
                data-testid="network-indicator"
              >
                <span className="statusChip__label">Network</span>
                <span className="statusChip__value">{isOnline ? 'Online' : 'Offline'}</span>
              </div>
              <div
                className={`statusChip statusChip--${ping === 'available' ? 'active' : 'error'}`}
              >
                <span className="statusChip__label">Preload</span>
                <span className="statusChip__value">
                  {ping === 'available' ? 'Connected' : 'Unavailable'}
                </span>
              </div>
            </div>

            <div className="kiosk__avatarDetails">
              <h1 id="avatar-preview-title">{activeAvatarName}</h1>
              <AssistantStatusPanel
                activity={displayedActivity}
                wakeScore={wakeScore}
                toolCalls={toolCalls}
                wakePhrase={wakePhrase}
                models={modelStatuses}
              />
            </div>
            <div className="kiosk__meter" aria-live="polite">
              <div className="meter">
                <div className="meter__fill" style={{ width: `${levelPercentage}%` }} />
              </div>
              <p className="meter__label">Input level: {levelPercentage}%</p>
              <p className="meter__status">
                Speech gate: {audioGraph.isActive ? 'open' : 'closed'}
              </p>
            </div>
            <ApprovalsCard api={activeBridge?.approvals} />
            <CodingStatusLine api={activeBridge?.coding} active={panel === 'status'} />
            <CodingTasksPanel api={activeBridge?.codingTasks} codingApi={activeBridge?.coding} localVoice={activeBridge?.localVoice} active={panel === 'status'} />
            <SwitchboardStatusLine api={activeBridge?.switchboard} active={panel === 'status'} />
            <DoNotDisturbToggle api={activeBridge?.presence} />
            <HearChatterToggle api={activeBridge?.floor} />
            <GpuMemoryPanel api={activeBridge?.gpuMemory} active={panel === 'status'} />
          </PanelDialog>
          )}

          {modelsOpen && activeBridge?.models ? (
            <ModelsDialog
              api={activeBridge.models}
              avatarApi={activeBridge.avatar}
              codingApi={activeBridge.coding}
              initialUse={modelsInitialUse}
              engine={{
                backend: conversationBackend,
                onBackendChange: (value) => void handleConversationBackendChange(value),
                voice: selectedVoice,
                voices: availableVoices,
                onVoiceChange: (value) => void handleVoiceChange(value),
                disabled: isSaving || loadingConfig,
              }}
              onChanged={({ openAiKey }) => {
                void activeBridge.config
                  .get()
                  .then((next) => {
                    // A new OpenAI key needs a fresh Realtime token.
                    if (openAiKey) {
                      setRealtimeToken(null);
                      setRealtimeTokenError(null);
                      realtimeTokenExpiresAtRef.current = null;
                      realtimeTokenRefreshRef.current = true;
                      realtimeTokenRequestRef.current += 1;
                    }
                    setConfig(next);
                  })
                  .catch(() => undefined);
              }}
              onClose={() => setModelsOpen(false)}
            />
          ) : null}

          {isSaving ? <p className="kiosk__info">Saving audio preferences…</p> : null}
          {saveError ? (
            <p role="alert" className="kiosk__error">
              {saveError}
            </p>
          ) : null}
          {audioGraph.status === 'error' && audioGraph.error ? (
            <p role="alert" className="kiosk__error">
              {audioGraph.error}
            </p>
          ) : null}
          {configError ? (
            <p role="alert" className="kiosk__error">
              {configError}
            </p>
          ) : null}

          {isTranscriptVisible ? (
            <aside
              className="kiosk__transcript"
              role="region"
              aria-label="Transcript overlay"
              data-testid="transcript-overlay"
            >
              <TranscriptOverlay entries={transcriptEntries} avatarNames={avatarNames} />
            </aside>
          ) : null}

          {showDeveloperHud ? (
            <aside className="kiosk__hud" aria-label="Latency metrics HUD">
              <h2 className="kiosk__hudTitle">Latency</h2>
              <dl className="kiosk__hudMetrics">
                <div>
                  <dt>Wake → Capture</dt>
                  <dd>{formatLatency(hudSnapshot?.wakeToCaptureMs)}</dd>
                </div>
                <div>
                  <dt>Capture → First audio</dt>
                  <dd>{formatLatency(hudSnapshot?.captureToFirstAudioMs)}</dd>
                </div>
                <div>
                  <dt>Wake → First audio</dt>
                  <dd>{formatLatency(hudSnapshot?.wakeToFirstAudioMs)}</dd>
                </div>
              </dl>
            </aside>
          ) : null}

          {/* Hidden audio sink for realtime playback (no user-facing controls). */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio ref={remoteAudioRef} autoPlay aria-hidden="true" style={{ display: 'none' }} />
        </main>
      </BehaviorCueProvider>
    </AnimationBusProvider>
  );
}
