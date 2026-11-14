import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../main/src/conversation/types.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../../main/src/config/provider-settings.js';
import { builtInServers, defaultRoutes } from '../../main/src/config/model-routing.js';
import type { PlacesSnapshot } from '../../main/src/places/place-manager.js';
import type { AvatarModelSummary } from '../src/avatar/types.js';

interface FakeCallbacks {
  onTextContent?: (content: string, avatarId?: string) => void;
}
const localClients = vi.hoisted(() => [] as Array<{ callbacks: FakeCallbacks }>);
/** The props the stage was last given. */
const stage = vi.hoisted(() => ({ props: null as null | { avatars?: Array<{ id: string }>; hiddenIds?: string[]; onBodyReady?: (id: string) => void } }));

vi.mock('../src/realtime/local-voice-client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/realtime/local-voice-client.js')>('../src/realtime/local-voice-client.js');
  class FakeLocalVoiceClient {
    callbacks: FakeCallbacks;
    constructor(options: { callbacks?: FakeCallbacks }) {
      this.callbacks = options.callbacks ?? {};
      localClients.push(this);
      return new Proxy(this, {
        get: (target, key) => {
          if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key];
          if (key === 'getActivity') return () => ({ phase: 'off', since: 0 });
          if (key === 'getState') return () => ({ status: 'idle' });
          return vi.fn(async () => undefined);
        },
      });
    }
  }
  return { ...actual, LocalVoiceClient: FakeLocalVoiceClient };
});

vi.mock('../src/avatar/vrm-avatar-renderer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/avatar/vrm-avatar-renderer.js')>('../src/avatar/vrm-avatar-renderer.js');
  return {
    ...actual,
    VrmAvatarRenderer: (props: NonNullable<typeof stage.props>) => {
      stage.props = props;
      return <canvas data-testid="stage-canvas" />;
    },
  };
});

// The real detector needs the model file and WebGL; the camera logic around it is what these tests are about.
vi.mock('../src/camera/mediapipe-detector.js', () => ({ createMediapipeDetector: async () => ({ countFaces: () => 0, close: () => undefined }) }));

import App from '../src/App.js';

class MockMediaStream {
  getTracks() {
    return [];
  }
}
class MockAudioContext {
  currentTime = 0;
  state = 'running';
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createGain = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn() } }));
  createMediaStreamDestination = vi.fn(() => ({ stream: new MockMediaStream(), connect: vi.fn(), disconnect: vi.fn() }));
  createAnalyser = vi.fn(() => ({ fftSize: 2048, smoothingTimeConstant: 0, connect: vi.fn(), disconnect: vi.fn(), getFloatTimeDomainData: vi.fn() }));
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}

const model = (id: string): AvatarModelSummary => ({ id, name: id, createdAt: 1, version: '1.0', fileSha: id, thumbnailDataUrl: null, description: null });
const PLACES: PlacesSnapshot['places'] = [
  { id: 'home', name: 'the lounge', node: 'local' },
  { id: 'next-door', name: 'next door', node: 'offscreen' },
];
const snapshot = (locations: Record<string, string>, transit: PlacesSnapshot['transit'] = []): PlacesSnapshot => ({
  places: PLACES,
  locations: { echo: 'home', sage: 'home', ...locations },
  transit,
  localPlaceId: 'home',
});

function install(options: { places?: PlacesSnapshot | null; profiles?: Array<{ id: string; name: string; vrmModelId: string }> } = {}) {
  let changed: ((snapshot: PlacesSnapshot) => void) | undefined;
  const places = {
    snapshot: vi.fn(async () => options.places as PlacesSnapshot),
    onChanged: vi.fn((listener: (snapshot: PlacesSnapshot) => void) => {
      changed = listener;
      return () => undefined;
    }),
    move: vi.fn(async () => ({ ok: true })),
    arrived: vi.fn(async () => undefined),
  };
  const config = {
    audioInputDeviceId: '',
    audioOutputDeviceId: '',
    featureFlags: { transcriptOverlay: true },
    hasRealtimeApiKey: false,
    conversationBackend: 'local',
    providers: structuredClone(DEFAULT_PROVIDER_SETTINGS),
    realtimeVoice: 'shimmer',
    metrics: { enabled: false, host: '127.0.0.1', port: 9090, path: '/metrics' },
    wakeWord: { model: 'hey_jarvis', keywordLabel: 'Hey Jarvis', threshold: 0.5, cooldownMs: 1500, deviceIndex: undefined },
  };
  const avatarsList = vi.fn().mockResolvedValue(
    options.profiles ?? [
      { id: 'echo', name: 'Echo', vrmModelId: 'm1' },
      { id: 'sage', name: 'Sage', vrmModelId: 'm1' },
    ],
  );
  (window as unknown as { aiembodied: unknown }).aiembodied = {
    ping: () => 'pong',
    config: {
      get: vi.fn().mockResolvedValue(config),
      getSecret: vi.fn().mockResolvedValue(null),
      setAudioDevicePreferences: vi.fn().mockResolvedValue(config),
    },
    wakeWord: { onWake: () => () => undefined },
    avatars: { list: avatarsList, setTagInstructions: vi.fn().mockResolvedValue(undefined) },
    ...(options.places === null ? {} : { places }),
    avatar: new Proxy(
      { listModels: vi.fn().mockResolvedValue([model('m1')]), getActiveModel: vi.fn().mockResolvedValue(model('m1')), loadModelBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)) },
      {
        get: (target, key) => {
          if (key in target) return (target as Record<string | symbol, unknown>)[key];
          return typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => undefined : vi.fn().mockResolvedValue([]);
        },
      },
    ),
    models: {
      get: vi.fn(async () => ({
        servers: builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }).map((server) => ({ ...server, hasKey: false })),
        routes: defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
      })),
      probe: vi.fn(async () => ({ status: 'up', models: {}, checkedAt: 0 })),
    },
    conversation: {
      getHistory: vi.fn().mockResolvedValue({ currentSessionId: 'session-1', sessions: [{ id: 'session-1', startedAt: 1, title: null, messages: [] }] }),
      appendMessage: vi.fn(),
      onSessionStarted: (_listener: (session: ConversationSession) => void) => () => undefined,
      onMessageAppended: () => () => undefined,
    },
    __bridgeReady: true,
    __bridgeVersion: '1.0.0',
  };
  return { places, push: (next: PlacesSnapshot) => act(async () => changed?.(next)), avatarsList };
}

const stageIds = () => stage.props?.avatars?.map((entry) => entry.id);

describe('App with avatars in different places', () => {
  const originalAudioContext = window.AudioContext;
  const originalMediaDevices = navigator.mediaDevices;
  const originalConsole = { error: console.error, warn: console.warn, info: console.info, debug: console.debug };

  beforeEach(() => {
    localClients.length = 0;
    stage.props = null;
    (window as unknown as { AudioContext: unknown }).AudioContext = MockAudioContext;
    (navigator as Navigator & { mediaDevices: MediaDevices }).mediaDevices = {
      enumerateDevices: vi.fn().mockResolvedValue([]),
      getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      ondevicechange: null,
    } as unknown as MediaDevices;
    console.error = vi.fn();
    console.warn = vi.fn();
    console.info = vi.fn();
    console.debug = vi.fn();
  });

  afterEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
    (navigator as Navigator & { mediaDevices: MediaDevices }).mediaDevices = originalMediaDevices;
    Reflect.deleteProperty(window, 'aiembodied');
    Object.assign(console, originalConsole);
  });

  it('puts every avatar on stage, and no chip, without a places bridge', async () => {
    install({ places: null });
    render(<App />);
    await waitFor(() => expect(stageIds()).toEqual(['echo', 'sage']));
    expect(stage.props?.hiddenIds).toBeUndefined();
    expect(screen.queryByTestId('elsewhere-chip')).toBeNull();
  });

  it('puts every avatar on stage when all are here', async () => {
    install({ places: snapshot({}) });
    render(<App />);
    await waitFor(() => expect(stageIds()).toEqual(['echo', 'sage']));
    expect(stage.props?.hiddenIds).toEqual([]);
    expect(screen.queryByTestId('elsewhere-chip')).toBeNull();
  });

  it('leaves an avatar that is next door out of the stage and lists it in the Elsewhere chip', async () => {
    const h = install({ places: snapshot({ sage: 'next-door' }) });
    render(<App />);
    await waitFor(() => expect(stageIds()).toEqual(['echo']));
    expect(await screen.findByText('Sage is next door')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Call Sage' }));
    expect(h.places.move).toHaveBeenCalledWith('sage', 'home', 'called');
  });

  it('keeps Echo\'s body loaded but hidden while she is away', async () => {
    install({ places: snapshot({ echo: 'next-door' }) });
    render(<App />);
    await waitFor(() => expect(stage.props?.hiddenIds).toEqual(['echo']));
    expect(stageIds()).toEqual(['echo', 'sage']);
    expect(await screen.findByText('Echo is next door')).toBeInTheDocument();
  });

  it('hides Echo even when she is the only avatar', async () => {
    install({ places: snapshot({ echo: 'next-door' }), profiles: [{ id: 'echo', name: 'Echo', vrmModelId: 'm1' }] });
    render(<App />);
    await waitFor(() => expect(stage.props?.hiddenIds).toEqual(['echo']));
    expect(stage.props?.avatars).toBeUndefined();
  });

  describe('camera presence on bija', () => {
    const videoCalls = () => vi.mocked(navigator.mediaDevices.getUserMedia).mock.calls.filter(([constraints]) => Boolean((constraints as MediaStreamConstraints | undefined)?.video));
    const withCamera = (locations: Record<string, string>, camera?: boolean): PlacesSnapshot => ({
      ...snapshot(locations),
      places: PLACES.map((place) => (place.id === 'home' && camera !== undefined ? { ...place, camera } : place)),
    });

    it('is off until Kevin opts in: nothing is filmed and no dot is shown', async () => {
      install({ places: withCamera({}) });
      render(<App />);
      await waitFor(() => expect(stageIds()).toEqual(['echo', 'sage']));
      await act(async () => undefined);
      expect(videoCalls()).toHaveLength(0);
      expect(screen.queryByTestId('camera-live-dot')).toBeNull();
    });

    it('runs, with a dot, while an avatar is here and the setting is on; stops when everyone has left', async () => {
      const h = install({ places: withCamera({}, true) });
      render(<App />);
      await waitFor(() => expect(videoCalls()).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId('camera-live-dot')).toBeInTheDocument());
      await h.push(withCamera({ echo: 'next-door', sage: 'next-door' }, true));
      await waitFor(() => expect(screen.queryByTestId('camera-live-dot')).toBeNull());
    });

    it('does not run with the setting on when nobody is at this screen', async () => {
      install({ places: withCamera({ echo: 'next-door', sage: 'next-door' }, true) });
      render(<App />);
      await waitFor(() => expect(stage.props?.hiddenIds).toEqual(expect.arrayContaining(['echo'])));
      await act(async () => undefined);
      expect(videoCalls()).toHaveLength(0);
    });

    it('stops when Kevin turns the setting off', async () => {
      const h = install({ places: withCamera({}, true) });
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('camera-live-dot')).toBeInTheDocument());
      await h.push(withCamera({}, false));
      await waitFor(() => expect(screen.queryByTestId('camera-live-dot')).toBeNull());
    });
  });

  it('follows the changes pushed by main', async () => {
    const h = install({ places: snapshot({}) });
    render(<App />);
    await waitFor(() => expect(stageIds()).toEqual(['echo', 'sage']));
    await h.push(snapshot({ sage: 'next-door' }));
    await waitFor(() => expect(stageIds()).toEqual(['echo']));
    await h.push(snapshot({ sage: 'next-door' }, [{ avatarId: 'sage', from: 'next-door', to: 'home' }]));
    // Walking in: her body loads out of sight.
    await waitFor(() => expect(stageIds()).toEqual(['echo', 'sage']));
    expect(stage.props?.hiddenIds).toEqual(['sage']);
    expect(screen.getByRole('button', { name: 'Call Sage' })).toBeDisabled();
  });

  it('tells main an avatar has arrived once its body is loaded', async () => {
    const h = install({ places: snapshot({ sage: 'next-door' }, [{ avatarId: 'sage', from: 'next-door', to: 'home' }]) });
    render(<App />);
    await waitFor(() => expect(stage.props?.hiddenIds).toEqual(['sage']));
    expect(h.places.arrived).not.toHaveBeenCalled();
    await act(async () => stage.props?.onBodyReady?.('sage'));
    await waitFor(() => expect(h.places.arrived).toHaveBeenCalledWith('sage'));
    expect(h.places.arrived).toHaveBeenCalledTimes(1);
  });

  it('asks main to move an avatar that writes {room:} (no room, so once its line is spoken)', async () => {
    const h = install({ places: snapshot({}) });
    render(<App />);
    await waitFor(() => expect(localClients.length).toBeGreaterThan(0));
    const callbacks = localClients.at(-1)?.callbacks as FakeCallbacks;
    await act(async () => {
      callbacks.onTextContent?.('Back soon. {room:next door}', 'sage');
    });
    await waitFor(() => expect(h.places.move).toHaveBeenCalledWith('sage', 'next door', 'chose to'));
    // The same tag seen again moves nobody twice.
    await act(async () => {
      callbacks.onTextContent?.('Back soon. {room:next door}', 'sage');
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(h.places.move).toHaveBeenCalledTimes(1);
  });

  it('warns and does nothing else when the place is unknown', async () => {
    const h = install({ places: snapshot({}) });
    h.places.move.mockResolvedValue({ ok: false, reason: 'unknown place' } as never);
    render(<App />);
    await waitFor(() => expect(localClients.length).toBeGreaterThan(0));
    const callbacks = localClients.at(-1)?.callbacks as FakeCallbacks;
    await act(async () => {
      callbacks.onTextContent?.('Bye {room:the moon}');
    });
    await waitFor(() => expect(h.places.move).toHaveBeenCalledWith('echo', 'the moon', 'chose to'));
    await waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cannot go to "the moon": unknown place')));
  });
});
