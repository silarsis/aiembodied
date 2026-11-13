import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../main/src/conversation/types.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../../main/src/config/provider-settings.js';
import { builtInServers, defaultRoutes } from '../../main/src/config/model-routing.js';
import type { PlacesSnapshot } from '../../main/src/places/place-manager.js';
import { SatelliteContext } from '../src/satellite/satellite-context.js';
import type { SatelliteBridge, SatelliteStatus } from '../../main/src/satellite/bridge-types.js';
import type { AvatarModelSummary } from '../src/avatar/types.js';

interface FakeCallbacks {
  onStateChange?: (state: { status: string }) => void;
  onTextContent?: (content: string, avatarId?: string) => void;
}
const localClients = vi.hoisted(() => [] as Array<{ callbacks: FakeCallbacks; sendText: (text: string) => Promise<boolean> }>);
/** The props the stage was last given. */
const stage = vi.hoisted(() => ({ props: null as null | { avatars?: Array<{ id: string }>; hiddenIds?: string[]; onBodyReady?: (id: string) => void } }));

vi.mock('../src/realtime/local-voice-client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/realtime/local-voice-client.js')>('../src/realtime/local-voice-client.js');
  class FakeLocalVoiceClient {
    callbacks: FakeCallbacks;
    sendText = vi.fn(async (_text: string) => true);
    constructor(options: { callbacks?: FakeCallbacks }) {
      this.callbacks = options.callbacks ?? {};
      localClients.push(this);
      // The app enables typing once the client says it is connected.
      this.callbacks.onStateChange?.({ status: 'connected' });
      return new Proxy(this, {
        get: (target, key) => {
          if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key];
          if (key === 'getActivity') return () => ({ phase: 'off', since: 0 });
          if (key === 'getState') return () => ({ status: 'connected' });
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


const SATELLITE_STATUS: SatelliteStatus = {
  role: 'satellite',
  paired: true,
  hubUrl: 'ws://bija:8791',
  deviceName: 'study-pc',
  placeId: 'study',
  placeName: 'the study',
  link: 'online',
  linkCode: null,
  lastError: null,
  hostname: 'study-pc',
};

function renderSatellite(status: SatelliteStatus) {
  const bridge: SatelliteBridge = {
    status: vi.fn().mockResolvedValue(status),
    onStatus: vi.fn(() => () => undefined),
    pair: vi.fn().mockResolvedValue(status),
    forget: vi.fn().mockResolvedValue(status),
  };
  const view = render(
    <SatelliteContext.Provider value={{ status, bridge }}>
      <App />
    </SatelliteContext.Provider>,
  );
  return { bridge, view };
}

describe('App as a satellite', () => {
  const originalAudioContext = window.AudioContext;
  const originalMediaDevices = navigator.mediaDevices;
  const originalConsole = { error: console.error, warn: console.warn, info: console.info, debug: console.debug };

  beforeEach(() => {
    localClients.length = 0;
    stage.props = null;
    (window as unknown as { AudioContext: unknown }).AudioContext = MockAudioContext;
    (navigator as Navigator & { mediaDevices: MediaDevices }).mediaDevices = {
      enumerateDevices: vi.fn().mockResolvedValue([]),
      getUserMedia: vi.fn().mockRejectedValue(new Error('a satellite must not open the microphone')),
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

  it('shows only the minimal controls and no banner while online', async () => {
    install({ places: snapshot({}) });
    renderSatellite(SATELLITE_STATUS);
    await waitFor(() => expect(stage.props?.avatars?.length).toBeGreaterThan(0));
    expect(screen.getByTestId('typed-message')).toBeInTheDocument();
    expect(screen.queryByTestId('satellite-banner')).toBeNull();
    expect(screen.queryByRole('button', { name: /Characters/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Places/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Providers/ })).toBeNull();
  });

  it('sends a typed line to the voice client and never opens the microphone', async () => {
    install({ places: snapshot({}) });
    renderSatellite(SATELLITE_STATUS);
    await waitFor(() => expect(localClients.length).toBeGreaterThan(0));
    const input = await screen.findByLabelText('Message');
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(localClients.some((client) => vi.mocked(client.sendText).mock.calls.some((call) => call[0] === 'hello there'))).toBe(true));
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('shows the offline banner and blocks typing when the link is down', async () => {
    install({ places: snapshot({}) });
    renderSatellite({ ...SATELLITE_STATUS, link: 'offline' });
    expect(await screen.findByTestId('satellite-banner')).toHaveTextContent('Lost touch with bija');
    expect(screen.getByLabelText('Message')).toBeDisabled();
  });

  it('offers to forget the pairing when bija refused this PC', async () => {
    install({ places: snapshot({}) });
    const { bridge } = renderSatellite({ ...SATELLITE_STATUS, link: 'refused', lastError: 'This PC was removed.' });
    fireEvent.click(await screen.findByRole('button', { name: 'Forget this pairing' }));
    expect(bridge.forget).toHaveBeenCalled();
  });
});
