import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { RendererConfig } from '../../main/src/config/config-manager.js';
import type { AudioDevicePreferences } from '../../main/src/config/preferences-store.js';
import { AudioGraph } from './audio/audio-graph.js';
import { VisemeDriver, type VisemeFrame } from './audio/viseme-driver.js';
import { useAudioDevices } from './hooks/use-audio-devices.js';
import { getPreloadApi, type PreloadApi } from './preload-api.js';
import { RealtimeClient, type RealtimeClientState } from './realtime/realtime-client.js';

type AudioGraphStatus = 'idle' | 'starting' | 'ready' | 'error';

interface AudioGraphState {
  level: number;
  isActive: boolean;
  status: AudioGraphStatus;
  error: string | null;
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

function usePreloadBridge() {
  const [api, setApi] = useState<PreloadApi | undefined>(undefined);
  const [ping, setPing] = useState<'available' | 'unavailable'>('unavailable');

  useEffect(() => {
    const bridge = getPreloadApi();
    setApi(bridge);
    if (bridge) {
      try {
        const result = bridge.ping();
        setPing(result === 'pong' ? 'available' : 'unavailable');
      } catch (error) {
        console.error('Failed to call preload ping bridge', error);
        setPing('unavailable');
      }
    } else {
      setPing('unavailable');
    }
  }, []);

  return { api, ping };
}

export default function App() {
  const { api, ping } = usePreloadBridge();
  const [config, setConfig] = useState<RendererConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [realtimeKey, setRealtimeKey] = useState<string | null>(null);
  const [realtimeKeyError, setRealtimeKeyError] = useState<string | null>(null);
  const [realtimeState, setRealtimeState] = useState<RealtimeClientState>({ status: 'idle' });
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [visemeFrame, setVisemeFrame] = useState<VisemeFrame | null>(null);

  const { inputs, outputs, error: deviceError, refresh: refreshDevices } = useAudioDevices();

  const [selectedInput, setSelectedInput] = useState('');
  const [selectedOutput, setSelectedOutput] = useState('');

  const configInputDeviceId = config?.audioInputDeviceId ?? '';
  const configOutputDeviceId = config?.audioOutputDeviceId ?? '';
  const hasRealtimeSupport = typeof RTCPeerConnection === 'function';
  const hasRealtimeApiKey = config?.hasRealtimeApiKey ?? false;

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const visemeDriverRef = useRef<VisemeDriver | null>(null);
  const latestRemoteStreamRef = useRef<MediaStream | null>(null);
  const attachRequestIdRef = useRef(0);
  const realtimeClient = useMemo(() => {
    if (!hasRealtimeSupport) {
      return null;
    }

    return new RealtimeClient({
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
  }, [hasRealtimeSupport]);

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
    latestRemoteStreamRef.current = remoteStream;
  }, [remoteStream]);

  useEffect(() => {
    const driver = visemeDriverRef.current;
    if (!driver) {
      return;
    }

    const requestId = attachRequestIdRef.current + 1;
    attachRequestIdRef.current = requestId;
    let disposed = false;

    const attach = async () => {
      try {
        await driver.attachToStream(remoteStream);
      } catch (error) {
        if (!disposed) {
          console.error('Failed to attach viseme driver', error);
        }
        return;
      }

      if (attachRequestIdRef.current !== requestId) {
        const latestStream = latestRemoteStreamRef.current ?? null;
        if (latestStream !== remoteStream) {
          try {
            await driver.attachToStream(latestStream);
          } catch (reattachError) {
            console.error('Failed to update viseme driver attachment', reattachError);
          }
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
    if (!api) {
      setConfigError('Renderer preload API is unavailable.');
      setLoadingConfig(false);
      return;
    }

    let cancelled = false;
    api.config
      .get()
      .then((value) => {
        if (cancelled) {
          return;
        }
        setConfig(value);
        setConfigError(null);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to load renderer configuration.';
        setConfigError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingConfig(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    setSelectedInput((previous) => (previous === configInputDeviceId ? previous : configInputDeviceId));
    setSelectedOutput((previous) => (previous === configOutputDeviceId ? previous : configOutputDeviceId));
  }, [configInputDeviceId, configOutputDeviceId]);

  const audioGraph = useAudioGraphState(selectedInput || undefined, !loadingConfig);

  useEffect(() => {
    if (!api || !hasRealtimeApiKey || !hasRealtimeSupport) {
      setRealtimeKey(null);
      setRealtimeKeyError(null);
      return;
    }

    let cancelled = false;
    api.config
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
  }, [api, hasRealtimeApiKey, hasRealtimeSupport]);

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
    if (!realtimeClient) {
      return;
    }

    void realtimeClient.setOutputDeviceId(selectedOutput || undefined);
  }, [realtimeClient, selectedOutput]);

  useEffect(() => {
    if (!realtimeClient || !hasRealtimeApiKey) {
      return;
    }

    realtimeClient.notifySpeechActivity(audioGraph.isActive);
  }, [realtimeClient, hasRealtimeApiKey, audioGraph.isActive]);

  const realtimeStatusLabel = useMemo(() => {
    if (!hasRealtimeApiKey) {
      return 'disabled (API key unavailable)';
    }

    if (!hasRealtimeSupport) {
      return 'unavailable (WebRTC not supported)';
    }

    if (realtimeKeyError) {
      return `error — ${realtimeKeyError}`;
    }

    switch (realtimeState.status) {
      case 'idle':
        return audioGraph.upstreamStream ? 'standby' : 'waiting for microphone';
      case 'connecting':
        return 'connecting';
      case 'connected':
        return 'connected';
      case 'reconnecting':
        return `reconnecting (attempt ${realtimeState.attempt ?? 0})`;
      case 'error':
        return `error — ${realtimeState.error ?? 'unknown'}`;
      default:
        return realtimeState.status;
    }
  }, [hasRealtimeApiKey, hasRealtimeSupport, realtimeKeyError, realtimeState, audioGraph.upstreamStream]);

  useEffect(() => {
    if (audioGraph.status === 'ready') {
      void refreshDevices();
    }
  }, [audioGraph.status, refreshDevices]);

  const persistPreferences = useCallback(
    async (preferences: AudioDevicePreferences) => {
      if (!api) {
        setSaveError('Cannot update audio preferences without preload bridge access.');
        return;
      }

      setIsSaving(true);
      setSaveError(null);

      try {
        const nextConfig = await api.config.setAudioDevicePreferences(preferences);
        setConfig(nextConfig);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to persist audio device preferences.';
        setSaveError(message);
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [api],
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

  const levelPercentage = useMemo(() => Math.min(100, Math.round(audioGraph.level * 100)), [audioGraph.level]);

  const audioGraphStatusLabel = useMemo(() => {
    switch (audioGraph.status) {
      case 'starting':
        return 'Starting microphone capture…';
      case 'ready':
        return audioGraph.isActive ? 'Listening (speech gate open)' : 'Idle (speech gate closed)';
      case 'error':
        return audioGraph.error ?? 'Audio capture error';
      default:
        return loadingConfig ? 'Waiting for configuration…' : 'Idle';
    }
  }, [audioGraph.status, audioGraph.isActive, audioGraph.error, loadingConfig]);

  return (
    <main className="app">
      <header className="app__header">
        <h1>Embodied Assistant MVP</h1>
        <p className="app__tagline">Audio device control &amp; capture pipeline</p>
      </header>

      <section className="app__status">
        <div>
          <span className="label">Preload bridge:</span> {ping === 'available' ? 'connected' : 'unavailable'}
        </div>
        <div>
          <span className="label">Configuration:</span>{' '}
          {loadingConfig ? 'loading…' : configError ? `error — ${configError}` : 'loaded'}
        </div>
        <div>
          <span className="label">Audio graph:</span> {audioGraphStatusLabel}
        </div>
        <div>
          <span className="label">Device scan:</span> {deviceError ? `error — ${deviceError}` : 'ok'}
        </div>
        <div>
          <span className="label">Realtime:</span> {realtimeStatusLabel}
        </div>
        <div>
          <span className="label">Viseme:</span>{' '}
          {visemeFrame
            ? `v${visemeFrame.index} · ${(visemeFrame.intensity * 100).toFixed(0)}%${
                visemeFrame.blink ? ' (blink)' : ''
              }`
            : 'idle'}
        </div>
      </section>

      <section className="app__controls">
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

      <section className="app__meter" aria-live="polite">
        <div className="meter">
          <div className="meter__fill" style={{ width: `${levelPercentage}%` }} />
        </div>
        <p className="meter__label">Input level: {levelPercentage}%</p>
        <p className="meter__status">Speech gate: {audioGraph.isActive ? 'open' : 'closed'}</p>
      </section>

      {isSaving ? <p className="app__info">Saving audio preferences…</p> : null}
      {saveError ? (
        <p role="alert" className="app__error">
          {saveError}
        </p>
      ) : null}
      {audioGraph.status === 'error' && audioGraph.error ? (
        <p role="alert" className="app__error">
          {audioGraph.error}
        </p>
      ) : null}
      {/* Hidden audio sink for realtime playback (no user-facing controls). */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={remoteAudioRef} autoPlay aria-hidden="true" style={{ display: 'none' }} />
    </main>
  );
}
