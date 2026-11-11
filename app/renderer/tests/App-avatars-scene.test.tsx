import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS } from '../../main/src/config/provider-settings.js';
import { builtInServers, defaultRoutes } from '../../main/src/config/model-routing.js';
import type { AvatarModelSummary } from '../src/avatar/types.js';
import type { SceneActionExecutor } from '../src/rooms/scene-executor.js';
import { builtInRoom } from './rooms/fixtures.js';

interface FakeCallbacks {
  onTextContent?: (content: string, avatarId?: string) => void;
}

const localClients = vi.hoisted(() => [] as Array<{ callbacks: FakeCallbacks }>);
const rendererProps = vi.hoisted(() => ({
  current: null as null | {
    sceneActions?: SceneActionExecutor | null;
    sceneExecutors?: ((avatarId: string) => SceneActionExecutor | null) | null;
  },
}));

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

// The WebGL renderer cannot run here; the stub only exposes the executors App hands it.
vi.mock('../src/avatar/vrm-avatar-renderer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/avatar/vrm-avatar-renderer.js')>('../src/avatar/vrm-avatar-renderer.js');
  return {
    ...actual,
    VrmAvatarRenderer: (props: NonNullable<typeof rendererProps.current>) => {
      rendererProps.current = props;
      return null;
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

describe('App scene actions from another avatar', () => {
  const originalAudioContext = window.AudioContext;
  const originalMediaDevices = navigator.mediaDevices;
  const originalConsole = { error: console.error, warn: console.warn, info: console.info, debug: console.debug };

  beforeEach(() => {
    localClients.length = 0;
    rendererProps.current = null;
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

  it('sends {go:} and {sit:} from Sage to Sage\'s executor only, and puts the room in the prompts', async () => {
    const room = builtInRoom('reading-room');
    const setTagInstructions = vi.fn().mockResolvedValue(undefined);
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
    (window as unknown as { aiembodied: unknown }).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue(config),
        getSecret: vi.fn().mockResolvedValue(null),
        setAudioDevicePreferences: vi.fn().mockResolvedValue(config),
      },
      wakeWord: { onWake: () => () => undefined },
      avatars: {
        list: vi.fn().mockResolvedValue([
          { id: 'echo', name: 'Echo', vrmModelId: 'm1' },
          { id: 'sage', name: 'Sage', vrmModelId: 'm1' },
        ]),
        setTagInstructions,
      },
      avatar: new Proxy(
        {
          listModels: vi.fn().mockResolvedValue([model('m1')]),
          getActiveModel: vi.fn().mockResolvedValue(model('m1')),
          loadModelBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
          getMotionStatus: vi.fn().mockResolvedValue({ ready: true }),
          streamMotion: vi.fn(() => new Promise(() => undefined)),
          cancelMotion: vi.fn().mockResolvedValue(undefined),
        },
        {
          get: (target, key) => {
            if (key in target) return (target as Record<string | symbol, unknown>)[key];
            return typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => undefined : vi.fn().mockResolvedValue([]);
          },
        },
      ),
      backgrounds: {
        list: vi.fn().mockResolvedValue([]),
        getActive: vi.fn().mockResolvedValue('room:reading-room'),
        listRooms: vi.fn().mockResolvedValue([]),
        loadRoom: vi.fn().mockResolvedValue(room),
      },
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
        onSessionStarted: () => () => undefined,
        onMessageAppended: () => () => undefined,
      },
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    };

    render(<App />);
    await waitFor(() => expect(localClients.length).toBeGreaterThan(0));
    // The scene text reaches main for the other avatars, naming who else is in the room.
    await waitFor(() => {
      const last = setTagInstructions.mock.calls.at(-1)?.[0] as { scene?: string; sceneFor?: Record<string, string> } | undefined;
      expect(last?.scene).toContain('{go:<object>}');
      expect(last?.sceneFor?.sage).toContain('Echo is in the room with you.');
      expect(last?.scene).not.toContain('is in the room with you');
    });

    await waitFor(() => expect(rendererProps.current?.sceneExecutors).toBeTruthy());
    const echoExecutor = rendererProps.current?.sceneActions as SceneActionExecutor;
    const sageExecutor = (rendererProps.current?.sceneExecutors as (id: string) => SceneActionExecutor)('sage');
    expect(sageExecutor).not.toBe(echoExecutor);
    const echoSubmit = vi.spyOn(echoExecutor, 'submit').mockImplementation(() => undefined);
    const sageSubmit = vi.spyOn(sageExecutor, 'submit').mockImplementation(() => undefined);

    const callbacks = localClients.at(-1)?.callbacks as FakeCallbacks;
    await act(async () => {
      callbacks.onTextContent?.('Sure. {go:sofa}{sit:sofa}', 'sage');
    });
    await waitFor(() => expect(sageSubmit).toHaveBeenCalledTimes(1));
    expect(sageSubmit).toHaveBeenCalledWith([
      { kind: 'go', objectId: 'sofa' },
      { kind: 'sit', objectId: 'sofa' },
    ]);
    expect(echoSubmit).not.toHaveBeenCalled();

    // Echo's own tags still run on Echo's executor.
    await act(async () => {
      callbacks.onTextContent?.('Over here. {go:bookshelf}');
    });
    await waitFor(() => expect(echoSubmit).toHaveBeenCalledTimes(1));
    expect(sageSubmit).toHaveBeenCalledTimes(1);
  });
});
