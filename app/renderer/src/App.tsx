﻿import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import type { ConfigSecretKey, RendererConfig } from '../../main/src/config/config-manager.js';
import type { AudioDevicePreferences } from '../../main/src/config/preferences-store.js';
import { AvatarRenderer } from './avatar/avatar-renderer.js';
import { AvatarConfigurator } from './avatar/avatar-configurator.js';
import { AudioGraph } from './audio/audio-graph.js';
import { VisemeDriver, type VisemeFrame } from './audio/viseme-driver.js';
import type { ConversationSessionWithMessages } from '../../main/src/conversation/types.js';
import { useAudioDevices } from './hooks/use-audio-devices.js';
import { getPreloadApi, type PreloadApi } from './preload-api.js';
import { RealtimeClient, type RealtimeClientState } from './realtime/realtime-client.js';
import { LatencyTracker, type LatencySnapshot } from './metrics/latency-tracker.js';
import type { LatencyMetricName } from '../../main/src/metrics/types.js';
import type { AvatarFaceDetail } from './avatar/types.js';

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

interface TranscriptEntry {
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
  timestamp: number;
}

type SecretKeyState<T> = Record<ConfigSecretKey, T>;

const SECRET_KEYS: ConfigSecretKey[] = ['realtimeApiKey', 'wakeWordAccessKey'];
const REQUIRED_BRIDGE_KEYS: (keyof PreloadApi)[] = ['config', 'wakeWord', 'ping'];

interface SecretStatusState {
  status: 'idle' | 'success' | 'error';
  message: string | null;
}

const SECRET_METADATA: Record<
  ConfigSecretKey,
  { label: string; description: string; isConfigured: (config: RendererConfig | null) => boolean }
> = {
  realtimeApiKey: {
    label: 'OpenAI Realtime API key',
    description: 'Required to negotiate realtime model sessions.',
    isConfigured: (config) => Boolean(config?.hasRealtimeApiKey),
  },
  wakeWordAccessKey: {
    label: 'Porcupine access key',
    description: 'Authorizes on-device wake word detection.',
    isConfigured: (config) => Boolean(config?.wakeWord?.hasAccessKey),
  },
};

function toTranscriptSpeaker(role: string): TranscriptSpeaker | null {
  if (role === 'system' || role === 'user' || role === 'assistant') {
    return role;
  }

  return null;
}

function formatLatency(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'ΓÇö';
  }

  return `${(value / 1000).toFixed(2)}s`;
}

function useAudioGraphState(inputDeviceId?: string, enabled = true) {
  const [state, setState] = useState<AudioGraphState>({
    level: 0,
    isActive: false,
    status: 'idle',
    error: null,
  });
  const [upstreamStream, setUpstreamStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState((previous) => ({ ...previous, status: 'idle', error: null }));
      setUpstreamStream(null);
      return;
    }

    const graph = new AudioGraph({
      onLevel: (level) => {
        setState((previous) => ({ ...previous, level }));
      },
      onSpeechActivityChange: (isActive) => {
        setState((previous) => ({ ...previous, isActive }));
      },
    });

    let disposed = false;

    const startGraph = async () => {
      setState((previous) => ({ ...previous, status: 'starting', error: null }));

      try {
        await graph.start({ inputDeviceId });
        if (disposed) {
          await graph.stop();
          return;
        }

        setState((previous) => ({ ...previous, status: 'ready' }));
        setUpstreamStream(graph.getUpstreamStream());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!disposed) {
          setState((previous) => ({ ...previous, status: 'error', error: message }));
          setUpstreamStream(null);
        }
      }
    };

    void startGraph();

    return () => {
      disposed = true;
      setUpstreamStream(null);
      void graph.stop();
    };
  }, [inputDeviceId, enabled]);

  return { ...state, upstreamStream };
}

function logRendererBridge(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  meta?: Record<string, unknown>,
) {
  const prefix = `[renderer bridge] ${message}`;
  if (level === 'debug') {
    meta ? console.debug(prefix, meta) : console.debug(prefix);
    return;
  }

  if (level === 'info') {
    meta ? console.info(prefix, meta) : console.info(prefix);
    return;
  }

  if (level === 'warn') {
    meta ? console.warn(prefix, meta) : console.warn(prefix);
    return;
  }

  meta ? console.error(prefix, meta) : console.error(prefix);
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
  const [isIdle, setIsIdle] = useState(false);

  useEffect(() => {
    if (!enabled) {
      document.body.classList.remove('cursor-hidden');
      setIsIdle(false);
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;

    const markIdle = () => {
      timeout = null;
      setIsIdle(true);
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
      setIsIdle(false);
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
      setIsIdle(false);
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
}: {
  entries: TranscriptEntry[];
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
              <span className="transcript__speaker">{entry.speaker}</span>
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
  const [config, setConfig] = useState<RendererConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [secretInputs, setSecretInputs] = useState<SecretKeyState<string>>(() => ({
    realtimeApiKey: '',
    wakeWordAccessKey: '',
  }));
  const [secretStatus, setSecretStatus] = useState<SecretKeyState<SecretStatusState>>(() => ({
    realtimeApiKey: { status: 'idle', message: null },
    wakeWordAccessKey: { status: 'idle', message: null },
  }));
  const [secretSaving, setSecretSaving] = useState<SecretKeyState<boolean>>(() => ({
    realtimeApiKey: false,
    wakeWordAccessKey: false,
  }));
  const [secretTesting, setSecretTesting] = useState<SecretKeyState<boolean>>(() => ({
    realtimeApiKey: false,
    wakeWordAccessKey: false,
  }));
  const [realtimeKey, setRealtimeKey] = useState<string | null>(null);
  const [realtimeKeyError, setRealtimeKeyError] = useState<string | null>(null);
  const [realtimeState, setRealtimeState] = useState<RealtimeClientState>({ status: 'idle' });
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [visemeFrame, setVisemeFrame] = useState<VisemeFrame | null>(null);
  const [wakeState, setWakeState] = useState<'idle' | 'awake'>('idle');
  const wakeResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isTranscriptVisible, setTranscriptVisible] = useState(false);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const messageIdsRef = useRef<Set<string>>(new Set());
  const latencyTrackerRef = useRef<LatencyTracker>(new LatencyTracker());
  const [latencySnapshot, setLatencySnapshot] = useState<LatencySnapshot | null>(null);
  const [activeAvatar, setActiveAvatar] = useState<AvatarFaceDetail | null>(null);
  const activeBridge = resolveApi();

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

  const handleActiveFaceChange = useCallback((detail: AvatarFaceDetail | null) => {
    setActiveAvatar(detail);
  }, []);

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
    }: {
      speaker: TranscriptSpeaker;
      text: string;
      timestamp?: number;
      persist?: boolean;
    }) => {
      const canPersist = Boolean(persist && api?.conversation && activeSessionIdRef.current);
      let entryId = `${timestamp}-${Math.random().toString(36).slice(2, 10)}`;

      if (canPersist) {
        try {
          const message = await api!.conversation!.appendMessage({
            sessionId: activeSessionIdRef.current ?? undefined,
            role: speaker,
            content: text,
            ts: timestamp,
          });
          entryId = message.id;
          messageIdsRef.current.add(message.id);
        } catch (error) {
          console.error('Failed to persist conversation message', error);
        }
      }

      setTranscriptEntries((previous) => {
        const filtered = previous.filter((entry) => entry.id !== entryId);
        const next = [...filtered, { id: entryId, speaker, text, timestamp }];
        next.sort((a, b) => a.timestamp - b.timestamp);
        return next.slice(-MAX_TRANSCRIPT_ENTRIES);
      });
    },
    [api],
  );

  const { inputs, outputs, error: deviceError, refresh: refreshDevices } = useAudioDevices();

  const [selectedInput, setSelectedInput] = useState('');
  const [selectedOutput, setSelectedOutput] = useState('');

  const configInputDeviceId = config?.audioInputDeviceId ?? '';
  const configOutputDeviceId = config?.audioOutputDeviceId ?? '';
  const hasRealtimeSupport = typeof RTCPeerConnection === 'function';
  const hasRealtimeApiKey = config?.hasRealtimeApiKey ?? false;

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const visemeDriverRef = useRef<VisemeDriver | null>(null);
  const realtimeClient = useMemo(() => {
    if (!hasRealtimeSupport) {
      return null;
    }

    return new RealtimeClient({
      model: config?.realtimeModel || undefined,
      sessionConfig: {
        instructions:
          config?.sessionInstructions && config.sessionInstructions.length > 0
            ? config.sessionInstructions
            : 'You are an English-speaking assistant. Always respond in concise English. Do not switch languages unless explicitly instructed.',
        turnDetection: 'server_vad',
        vad: {
          threshold: 0.85,
          silenceDurationMs: 600,
          minSpeechDurationMs: 400,
        },
        voice: config?.realtimeVoice || 'verse',
      },
      callbacks: {
        onStateChange: setRealtimeState,
        onRemoteStream: (stream) => {
          setRemoteStream(stream);
          const element = remoteAudioRef.current;
          if (!element) {
            return;
          }

          element.srcObject = stream;
          const playPromise = element.play();
          if (playPromise) {
            playPromise.catch((error) => {
              console.error('Failed to play realtime audio', error);
            });
          }
        },
        onFirstAudioFrame: () => {
          const snapshot = latencyTrackerRef.current.recordFirstAudio(Date.now(), activeSessionIdRef.current);
          if (snapshot) {
            setLatencySnapshot((previous) => ({ ...(previous ?? {}), ...snapshot }));
            pushLatency(snapshot);
          }
        },
        onLog: (entry) => {
          const prefix = '[RealtimeClient]';
          if (entry.level === 'error') {
            console.error(prefix, entry.message, entry.data);
          } else if (entry.level === 'warn') {
            console.warn(prefix, entry.message, entry.data);
          } else {
            console.debug(prefix, entry.message, entry.data);
          }
        },
      },
    });
  }, [hasRealtimeSupport, pushLatency]);

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
    };
  }, [realtimeClient]);

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
    }
  }, [realtimeState.status]);

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
          wakeWordHasAccessKey: value.wakeWord?.hasAccessKey ?? false,
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

  const audioGraph = useAudioGraphState(selectedInput || undefined, !loadingConfig);
  const previousSpeechActiveRef = useRef(audioGraph.isActive);

  useEffect(() => {
    const bridge = resolveApi();
    if (!bridge || !hasRealtimeApiKey || !hasRealtimeSupport) {
      setRealtimeKey(null);
      setRealtimeKeyError(null);
      return;
    }

    let cancelled = false;
    bridge.config
      .getSecret('realtimeApiKey')
      .then((key) => {
        if (cancelled) {
          return;
        }
        setRealtimeKey(key);
        setRealtimeKeyError(null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Failed to load realtime API key.';
        setRealtimeKey(null);
        setRealtimeKeyError(message);
      });

    return () => {
      cancelled = true;
    };
  }, [api, hasRealtimeApiKey, hasRealtimeSupport, resolveApi]);

  useEffect(() => {
    const wasActive = previousSpeechActiveRef.current;
    if (!wasActive && audioGraph.isActive) {
      const snapshot = latencyTrackerRef.current.recordCapture(Date.now(), activeSessionIdRef.current);
      if (snapshot) {
        setLatencySnapshot((previous) => ({ ...(previous ?? {}), ...snapshot }));
        pushLatency(snapshot);
      }
    }
    previousSpeechActiveRef.current = audioGraph.isActive;
  }, [audioGraph.isActive, pushLatency]);

  useEffect(() => {
    if (!realtimeClient) {
      return;
    }

    if (!realtimeKey || !audioGraph.upstreamStream) {
      void realtimeClient.disconnect();
      return;
    }

    realtimeClient.bindRemoteAudioElement(remoteAudioRef.current);
    realtimeClient.setJitterBufferMs(100);
    void realtimeClient
      .connect({ apiKey: realtimeKey, inputStream: audioGraph.upstreamStream })
      .catch((error) => {
        console.error('Failed to connect to realtime API', error);
      });

    return () => {
      void realtimeClient.disconnect();
    };
  }, [realtimeClient, realtimeKey, audioGraph.upstreamStream]);

  useEffect(() => {
    if (!realtimeClient || !hasRealtimeApiKey) {
      return;
    }
    // With server-side VAD enabled, do not drive turns from the client
    // If we add a toggle later, gate this based on config.
  }, [realtimeClient, hasRealtimeApiKey, audioGraph.isActive]);

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
      const errorMessage = realtimeState.error ? `Realtime error ΓÇö ${realtimeState.error}` : 'Realtime session error';
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
      if (event.sessionId && activeSessionIdRef.current !== event.sessionId) {
        setActiveSessionId(event.sessionId);
        messageIdsRef.current.clear();
        setTranscriptEntries([]);
      }

      void recordTranscriptEntry({
        speaker: 'system',
        text: `Wake word detected (${event.keywordLabel}) ΓÇö confidence ${(event.confidence * 100).toFixed(0)}%`,
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

    return () => {
      if (wakeResetTimeoutRef.current) {
        clearTimeout(wakeResetTimeoutRef.current);
        wakeResetTimeoutRef.current = null;
      }
      unsubscribe?.();
    };
  }, [api, resolveApi, recordTranscriptEntry]);

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

  const handleSecretInputChange = useCallback(
    (key: ConfigSecretKey) => (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setSecretInputs((previous) => ({ ...previous, [key]: value }));
      setSecretStatus((previous) => ({
        ...previous,
        [key]: previous[key].status === 'idle' && previous[key].message === null
          ? previous[key]
          : { status: 'idle', message: null },
      }));
    },
    [],
  );

  const handleSecretSubmit = useCallback(
    (key: ConfigSecretKey) =>
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const nextValue = secretInputs[key]?.trim() ?? '';

        if (!nextValue) {
          setSecretStatus((previous) => ({
            ...previous,
            [key]: { status: 'error', message: 'Enter a value to update this key.' },
          }));
          return;
        }

        const bridge = resolveApi();
        if (!bridge) {
          logRendererBridge('error', 'Configuration bridge unavailable while submitting a secret update.', {
            ...collectBridgeDiagnostics(undefined, { action: 'set-secret', key }),
          });
          setSecretStatus((previous) => ({
            ...previous,
            [key]: { status: 'error', message: 'Configuration bridge is unavailable.' },
          }));
          return;
        }

        setSecretSaving((previous) => ({ ...previous, [key]: true }));
        setSecretStatus((previous) => ({ ...previous, [key]: { status: 'idle', message: null } }));

        try {
          const nextConfig = await bridge.config.setSecret(key, nextValue);
          setConfig(nextConfig);
          setSecretInputs((previous) => ({ ...previous, [key]: '' }));

          if (key === 'realtimeApiKey') {
            setRealtimeKey(nextValue);
            setRealtimeKeyError(null);
          }

          setSecretStatus((previous) => ({
            ...previous,
            [key]: { status: 'success', message: 'API key updated successfully.' },
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to update API key.';
          setSecretStatus((previous) => ({
            ...previous,
            [key]: { status: 'error', message },
          }));
        } finally {
          setSecretSaving((previous) => ({ ...previous, [key]: false }));
        }
      },
    [resolveApi, secretInputs],
  );

  const handleSecretTest = useCallback(
    (key: ConfigSecretKey) =>
      async () => {
        const bridge = resolveApi();
        if (!bridge) {
          logRendererBridge('error', 'Configuration bridge unavailable while testing a secret.', {
            ...collectBridgeDiagnostics(undefined, { action: 'test-secret', key }),
          });
          setSecretStatus((previous) => ({
            ...previous,
            [key]: { status: 'error', message: 'Configuration bridge is unavailable.' },
          }));
          return;
        }

        setSecretTesting((previous) => ({ ...previous, [key]: true }));
        setSecretStatus((previous) => ({ ...previous, [key]: { status: 'idle', message: null } }));

        try {
          const result = await bridge.config.testSecret(key);
          setSecretStatus((previous) => ({
            ...previous,
            [key]: {
              status: result.ok ? 'success' : 'error',
              message: result.message ?? (result.ok ? 'API key is valid.' : 'API key validation failed.'),
            },
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to test API key.';
          setSecretStatus((previous) => ({
            ...previous,
            [key]: { status: 'error', message },
          }));
        } finally {
          setSecretTesting((previous) => ({ ...previous, [key]: false }));
        }
      },
    [resolveApi],
  );

  const levelPercentage = useMemo(() => Math.min(100, Math.round(audioGraph.level * 100)), [audioGraph.level]);

  const audioGraphStatusLabel = useMemo(() => {
    switch (audioGraph.status) {
      case 'starting':
        return 'Starting microphone captureΓÇª';
      case 'ready':
        return audioGraph.isActive ? 'Listening' : 'Idle';
      case 'error':
        return audioGraph.error ?? 'Audio capture error';
      default:
        return loadingConfig ? 'Waiting for configurationΓÇª' : 'Idle';
    }
  }, [audioGraph.status, audioGraph.isActive, audioGraph.error, loadingConfig]);

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
    if (!hasRealtimeApiKey) {
      return 'Disabled (API key unavailable)';
    }

    if (!hasRealtimeSupport) {
      return 'Unavailable (WebRTC unsupported)';
    }

    if (realtimeKeyError) {
      return `Error ΓÇö ${realtimeKeyError}`;
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
        return `Error ΓÇö ${realtimeState.error ?? 'unknown'}`;
      default:
        return realtimeState.status;
    }
  }, [hasRealtimeApiKey, hasRealtimeSupport, realtimeKeyError, realtimeState, audioGraph.upstreamStream]);

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
  const audioVariant = audioGraph.status === 'error' ? 'error' : audioGraph.isActive ? 'active' : 'idle';
  const deviceVariant = deviceError ? 'error' : inputs.length > 0 ? 'active' : 'idle';
  const deviceStatusLabel = deviceError ? `Error ΓÇö ${deviceError}` : inputs.length > 0 ? 'Devices ready' : 'ScanningΓÇª';
  const showDeveloperHud = Boolean(config?.featureFlags?.metricsHud);
  const hudSnapshot = latencySnapshot ?? latencyTrackerRef.current.getLastSnapshot();
  const activeAvatarName = activeAvatar?.name ?? 'Embodied Assistant';

  return (
    <main
      className="kiosk"
      data-wake-state={wakeState}
      data-cursor-hidden={isCursorHidden ? 'true' : 'false'}
      aria-live="polite"
    >
      <header className="kiosk__statusBar" role="banner">
        <div className={`statusChip statusChip--${wakeStatusVariant}`} data-testid="wake-indicator">
          <span className="statusChip__label">Wake</span>
          <span className="statusChip__value" data-testid="wake-value">
            {wakeState === 'awake' ? 'Awake' : 'Idle'}
          </span>
        </div>
        <div className={`statusChip statusChip--${realtimeVariant}`} data-testid="realtime-indicator">
          <span className="statusChip__label">Realtime</span>
          <span className="statusChip__value">{realtimeStatusLabel}</span>
        </div>
        <div className={`statusChip statusChip--${audioVariant}`} data-testid="audio-indicator">
          <span className="statusChip__label">Audio</span>
          <span className="statusChip__value">{audioGraphStatusLabel}</span>
        </div>
        <div className={`statusChip statusChip--${deviceVariant}`} data-testid="device-indicator">
          <span className="statusChip__label">Devices</span>
          <span className="statusChip__value">{deviceStatusLabel}</span>
        </div>
        <div className={`statusChip statusChip--${networkVariant}`} data-testid="network-indicator">
          <span className="statusChip__label">Network</span>
          <span className="statusChip__value">{isOnline ? 'Online' : 'Offline'}</span>
        </div>
        <div className={`statusChip statusChip--${ping === 'available' ? 'active' : 'error'}`}>
          <span className="statusChip__label">Preload</span>
          <span className="statusChip__value">{ping === 'available' ? 'Connected' : 'Unavailable'}</span>
        </div>
        <button
          type="button"
          className="kiosk__transcriptToggle"
          onClick={toggleTranscriptVisibility}
          data-testid="transcript-toggle"
        >
          {transcriptToggleLabel}
          <span className="kiosk__shortcutHint">Ctrl/Cmd + Shift + T</span>
        </button>
      </header>

      <section className="kiosk__stage" aria-labelledby="avatar-preview-title">
        <div className="kiosk__avatar" data-state={visemeSummary.status.toLowerCase()}>
          <AvatarRenderer frame={visemeFrame} assets={activeAvatar?.components ?? null} />
        </div>
        <div className="kiosk__avatarDetails">
          <h1 id="avatar-preview-title">{activeAvatarName}</h1>
          <p className="kiosk__subtitle">Real-time viseme mapping derived from the decoded audio stream.</p>
          <dl className="kiosk__metrics">
            <div>
              <dt>Viseme</dt>
              <dd>
                v{visemeSummary.index} ┬╖ {visemeSummary.label}
              </dd>
            </div>
            <div>
              <dt>Intensity</dt>
              <dd>{visemeSummary.intensity}%</dd>
            </div>
            <div>
              <dt>Blink state</dt>
              <dd>{visemeSummary.blink ? 'Blink triggered' : 'Eyes open'}</dd>
            </div>
            <div>
              <dt>Driver status</dt>
              <dd>{visemeSummary.status}</dd>
            </div>
          </dl>
        </div>
        <div className="kiosk__meter" aria-live="polite">
          <div className="meter">
            <div className="meter__fill" style={{ width: `${levelPercentage}%` }} />
          </div>
          <p className="meter__label">Input level: {levelPercentage}%</p>
          <p className="meter__status">Speech gate: {audioGraph.isActive ? 'open' : 'closed'}</p>
        </div>
      </section>

      <AvatarConfigurator avatarApi={activeBridge?.avatar} onActiveFaceChange={handleActiveFaceChange} />

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
      </section>

      <section className="kiosk__secrets" aria-labelledby="kiosk-secret-title">
        <h2 id="kiosk-secret-title">API keys</h2>
        <p className="kiosk__helper">Keys are stored securely via the system secret store. Provide a new value to update or test an existing key.</p>
        <div className="kiosk__secretList">
          {SECRET_KEYS.map((key) => {
            const metadata = SECRET_METADATA[key];
            const configured = metadata.isConfigured(config);
            const status = secretStatus[key];
            const busy = secretSaving[key] || secretTesting[key];
            const message = status.message;
            const messageRole = status.status === 'error' ? 'alert' : 'status';
            const messageClass = status.status === 'error' ? 'kiosk__error' : 'kiosk__info';

            return (
              <article key={key} className="secretCard" data-configured={configured ? 'true' : 'false'}>
                <header className="secretCard__header">
                  <h3>{metadata.label}</h3>
                  <p className="secretCard__description">{metadata.description}</p>
                  <p className="secretCard__status">Status: {configured ? 'Configured' : 'Not configured'}</p>
                </header>
                <form className="secretCard__form" onSubmit={handleSecretSubmit(key)}>
                  <input
                    id={`${key}-input`}
                    type="password"
                    aria-label={`New ${metadata.label}`}
                    placeholder="Enter new key"
                    autoComplete="off"
                    spellCheck={false}
                    value={secretInputs[key]}
                    onChange={handleSecretInputChange(key)}
                    disabled={loadingConfig || isSaving || secretSaving[key] || secretTesting[key]}
                  />
                  <div className="secretCard__actions">
                    <button
                      type="submit"
                      disabled={
                        loadingConfig ||
                        secretSaving[key] ||
                        secretTesting[key] ||
                        secretInputs[key].trim().length === 0
                      }
                    >
                      Update key
                    </button>
                    <button
                      type="button"
                      onClick={handleSecretTest(key)}
                      disabled={loadingConfig || secretSaving[key] || secretTesting[key]}
                    >
                      Test key
                    </button>
                  </div>
                </form>
                {busy ? (
                  <p className="kiosk__info" aria-live="polite">
                    {secretSaving[key] ? 'Updating secretΓÇª' : 'Testing secretΓÇª'}
                  </p>
                ) : null}
                {message ? (
                  <p role={messageRole} className={messageClass} aria-live="polite">
                    {message}
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      {isSaving ? <p className="kiosk__info">Saving audio preferencesΓÇª</p> : null}
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
          <TranscriptOverlay entries={transcriptEntries} />
        </aside>
      ) : null}

      {showDeveloperHud ? (
        <aside className="kiosk__hud" aria-label="Latency metrics HUD">
          <h2 className="kiosk__hudTitle">Latency</h2>
          <dl className="kiosk__hudMetrics">
            <div>
              <dt>Wake ΓåÆ Capture</dt>
              <dd>{formatLatency(hudSnapshot?.wakeToCaptureMs)}</dd>
            </div>
            <div>
              <dt>Capture ΓåÆ First audio</dt>
              <dd>{formatLatency(hudSnapshot?.captureToFirstAudioMs)}</dd>
            </div>
            <div>
              <dt>Wake ΓåÆ First audio</dt>
              <dd>{formatLatency(hudSnapshot?.wakeToFirstAudioMs)}</dd>
            </div>
          </dl>
        </aside>
      ) : null}

      {/* Hidden audio sink for realtime playback (no user-facing controls). */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={remoteAudioRef} autoPlay aria-hidden="true" style={{ display: 'none' }} />
    </main>
  );
}
