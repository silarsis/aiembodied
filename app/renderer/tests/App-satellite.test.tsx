import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../main/src/conversation/types.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../../main/src/config/provider-settings.js';
import { builtInServers, defaultRoutes } from '../../main/src/config/model-routing.js';
import type { PlacesSnapshot } from '../../main/src/places/place-manager.js';
import { SatelliteContext } from '../src/satellite/satellite-context.js';
import type { DeviceGateState, SatelliteBridge, SatelliteStatus } from '../../main/src/satellite/bridge-types.js';
import { evaluateGate } from '../../main/src/satellite/device-gate.js';
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

const GATE_FACTS = { occupied: true, unlocked: true, linkUp: true, open: true, noFullscreenApp: true, notHeldOff: true };

function install(options: { places?: PlacesSnapshot | null; profiles?: Array<{ id: string; name: string; vrmModelId: string }>; gate?: DeviceGateState } = {}) {
  let pushGate: ((state: DeviceGateState) => void) | undefined;
  let pressTalk: (() => void) | undefined;
  const summon = vi.fn(async () => ({ ok: true as const, avatarId: 'echo', name: 'Echo', alreadyHere: false }));
  const deviceGate = options.gate
    ? {
        get: vi.fn(async () => options.gate as DeviceGateState),
        onChanged: vi.fn((listener: (state: DeviceGateState) => void) => {
          pushGate = listener;
          return () => undefined;
        }),
        captureStopped: vi.fn(async () => undefined),
        setOpen: vi.fn(async () => options.gate as DeviceGateState),
      }
    : undefined;
  let changed: ((snapshot: PlacesSnapshot) => void) | undefined;
  const places = {
    snapshot: vi.fn(async () => options.places as PlacesSnapshot),
    onChanged: vi.fn((listener: (snapshot: PlacesSnapshot) => void) => {
      changed = listener;
      return () => undefined;
    }),
    move: vi.fn(async () => ({ ok: true })),
    arrived: vi.fn(async () => undefined),
    summon,
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
    ...(deviceGate ? { deviceGate } : {}),
    talk: {
      getShortcutStatus: vi.fn().mockResolvedValue({ shortcut: 'Ctrl+Space', registered: true }),
      onShortcutStatus: () => () => undefined,
      onTrigger: (listener: () => void) => {
        pressTalk = listener;
        return () => undefined;
      },
    },
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
  return {
    places,
    push: (next: PlacesSnapshot) => act(async () => changed?.(next)),
    avatarsList,
    deviceGate,
    summon,
    pushGate: (state: DeviceGateState) => act(async () => pushGate?.(state)),
    pressTalk: () => act(async () => pressTalk?.()),
  };
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

  it('shows grey dots while the gate is closed, a green mic dot when it opens, and follows it back', async () => {
    const closed = evaluateGate({ ...GATE_FACTS, occupied: false });
    const { pushGate } = install({ places: snapshot({}), gate: closed });
    renderSatellite(SATELLITE_STATUS);
    await waitFor(() => expect(screen.getByTestId('mic-dot')).toHaveAttribute('data-level', 'off'));
    expect(screen.getByTestId('camera-dot')).toHaveAttribute('data-level', 'off');
    expect(screen.getByTestId('mic-dot')).toHaveAccessibleName(/Microphone off: Nobody is in this room/);
    await pushGate(evaluateGate(GATE_FACTS));
    expect(screen.getByTestId('mic-dot')).toHaveAttribute('data-level', 'live');
    expect(screen.getByTestId('camera-dot')).toHaveAttribute('data-level', 'off');
    await pushGate(evaluateGate({ ...GATE_FACTS, unlocked: false }));
    expect(screen.getByTestId('mic-dot')).toHaveAttribute('data-level', 'off');
  });

  it('never opens the microphone while the gate is closed', async () => {
    install({ places: snapshot({}), gate: evaluateGate({ ...GATE_FACTS, linkUp: false }) });
    renderSatellite(SATELLITE_STATUS);
    await screen.findByTestId('mic-dot');
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId('listening-toggle')).toHaveTextContent(/Mic off/);
  });

  it('opens the microphone when the gate allows it', async () => {
    install({ places: snapshot({}), gate: evaluateGate(GATE_FACTS) });
    renderSatellite(SATELLITE_STATUS);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
  });

  describe('camera presence', () => {
    const videoCalls = () => vi.mocked(navigator.mediaDevices.getUserMedia).mock.calls.filter(([constraints]) => Boolean((constraints as MediaStreamConstraints | undefined)?.video));
    function allowCamera() {
      const track = { stop: vi.fn() };
      vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async (constraints) =>
        constraints?.video ? ({ getTracks: () => [track] } as unknown as MediaStream) : Promise.reject(new Error('no microphone in this test')),
      );
      return track;
    }

    it('never opens the camera while the room\'s setting is off, even with the mic live', async () => {
      allowCamera();
      install({ places: snapshot({}), gate: evaluateGate(GATE_FACTS) });
      renderSatellite(SATELLITE_STATUS);
      await waitFor(() => expect(screen.getByTestId('mic-dot')).toHaveAttribute('data-level', 'live'));
      await act(async () => undefined);
      expect(videoCalls()).toHaveLength(0);
      expect(screen.getByTestId('camera-dot')).toHaveAttribute('data-level', 'off');
    });

    it('never opens the camera while the gate is closed, even when the setting is on', async () => {
      allowCamera();
      install({ places: snapshot({}), gate: evaluateGate({ ...GATE_FACTS, unlocked: false, cameraEnabled: true }) });
      renderSatellite(SATELLITE_STATUS);
      await screen.findByTestId('camera-dot');
      await act(async () => undefined);
      expect(videoCalls()).toHaveLength(0);
    });

    it('opens the camera when the gate says it may be live, and releases it the moment the gate closes', async () => {
      const track = allowCamera();
      const { pushGate, deviceGate } = install({ places: snapshot({}), gate: evaluateGate({ ...GATE_FACTS, cameraEnabled: true }) });
      renderSatellite(SATELLITE_STATUS);
      await waitFor(() => expect(videoCalls()).toHaveLength(1));
      expect(videoCalls()[0][0]).toMatchObject({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 360 } } });
      await waitFor(() => expect(screen.getByTestId('camera-dot')).toHaveAttribute('data-level', 'live'));
      deviceGate?.captureStopped.mockClear();
      await pushGate(evaluateGate({ ...GATE_FACTS, unlocked: false, cameraEnabled: true }));
      expect(track.stop).toHaveBeenCalled();
      await waitFor(() => expect(deviceGate?.captureStopped).toHaveBeenCalled());
      expect(screen.getByTestId('camera-dot')).toHaveAttribute('data-level', 'off');
    });

    it('releases only the camera when the room setting goes off, and says so', async () => {
      const track = allowCamera();
      const { pushGate } = install({ places: snapshot({}), gate: evaluateGate({ ...GATE_FACTS, cameraEnabled: true }) });
      renderSatellite(SATELLITE_STATUS);
      await waitFor(() => expect(screen.getByTestId('camera-dot')).toHaveAttribute('data-level', 'live'));
      await pushGate(evaluateGate(GATE_FACTS));
      expect(track.stop).toHaveBeenCalled();
      expect(screen.getByTestId('mic-dot')).toHaveAttribute('data-level', 'live');
      expect(screen.getByTestId('camera-dot')).toHaveAttribute('data-level', 'off');
    });
  });

  it('push-to-talk with nobody in the room calls someone over and keeps the mic closed', async () => {
    const { pressTalk, summon } = install({ places: snapshot({}), gate: evaluateGate({ ...GATE_FACTS, occupied: false }) });
    renderSatellite(SATELLITE_STATUS);
    await waitFor(() => expect(screen.getByTestId('mic-dot')).toHaveAccessibleName(/Nobody is in this room/));
    await pressTalk();
    await waitFor(() => expect(summon).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('calling-note')).toHaveTextContent('Calling Echo…');
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('push-to-talk does not call anyone while the room is locked or closed', async () => {
    const { pressTalk, summon } = install({ places: snapshot({}), gate: evaluateGate({ ...GATE_FACTS, occupied: false, open: false }) });
    renderSatellite(SATELLITE_STATUS);
    await waitFor(() => expect(screen.getByTestId('mic-dot')).toHaveAccessibleName(/This room is closed/));
    await pressTalk();
    expect(summon).not.toHaveBeenCalled();
    expect(await screen.findByTestId('calling-note')).toHaveTextContent(/The mic is off: This room is closed/);
  });

  it('shows the last turn and the speaker picker in the Status panel', async () => {
    install({ places: snapshot({}), gate: evaluateGate(GATE_FACTS) });
    renderSatellite(SATELLITE_STATUS);
    const handle = screen.queryByRole('button', { name: 'Controls' });
    if (handle) fireEvent.click(handle);
    const drawer = await screen.findByRole('complementary', { name: 'Controls' });
    fireEvent.click(await within(drawer).findByRole('button', { name: /Status/ }));
    expect(await screen.findByTestId('satellite-mic')).toHaveTextContent('Live');
    expect(screen.getByLabelText('Speakers')).toBeInTheDocument();
    expect(screen.getByTestId('satellite-last-turn')).toHaveTextContent('No turn yet');
    expect(screen.getByTestId('satellite-kill-switch')).toHaveTextContent('Close this room');
  });
});
