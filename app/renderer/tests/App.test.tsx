import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationAppendMessagePayload,
  ConversationMessage,
  ConversationSession,
} from '../../main/src/conversation/types.js';
import type { RendererConfig } from '../../main/src/config/config-manager.js';
import type { WakeWordDetectionEvent } from '../../main/src/wake-word/types.js';
import type { AvatarBridge, AvatarGenerationResult } from '../src/avatar/types.js';

type MockRealtimeInstance = {
  callbacks: {
    onSessionUpdated?: (session: { voice?: string; instructions?: string; turnDetection?: string }) => void;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  bindRemoteAudioElement: ReturnType<typeof vi.fn>;
  setJitterBufferMs: ReturnType<typeof vi.fn>;
  setReconnectApiKeyProvider: ReturnType<typeof vi.fn>;
  updateSessionConfig: ReturnType<typeof vi.fn>;
  getSessionConfigSnapshot: ReturnType<typeof vi.fn>;
};

const realtimeClientInstances: MockRealtimeInstance[] = [];

vi.mock('../src/realtime/realtime-client.js', () => {
  class MockRealtimeClient {
    callbacks: MockRealtimeInstance['callbacks'];
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn().mockResolvedValue(undefined);
    bindRemoteAudioElement = vi.fn();
    setJitterBufferMs = vi.fn();
    setReconnectApiKeyProvider = vi.fn();
    updateSessionConfig = vi.fn();
    getSessionConfigSnapshot = vi.fn().mockReturnValue({
      type: 'realtime',
      model: 'gpt-4o-realtime-preview-2024-12-17',
      output_modalities: ['audio'],
      audio: { output: { voice: 'verse' } },
    });

    constructor({ callbacks }: { callbacks?: MockRealtimeInstance['callbacks'] }) {
      this.callbacks = callbacks ?? {};
      realtimeClientInstances.push(this as unknown as MockRealtimeInstance);
    }
  }

  return {
    RealtimeClient: MockRealtimeClient,
  };
});

import App from '../src/App.js';

class MockMediaStream {
  getTracks() {
    return [];
  }
}

class MockAnalyserNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  connect = vi.fn();
  disconnect = vi.fn();
  getFloatTimeDomainData = vi.fn((array: Float32Array) => {
    array.fill(0);
  });
}

class MockGainNode {
  connect = vi.fn();
  disconnect = vi.fn();
  gain = {
    value: 0,
    setTargetAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
  };
}

class MockMediaStreamSourceNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockMediaStreamDestinationNode {
  stream: MediaStream = new MockMediaStream() as unknown as MediaStream;
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioContext {
  currentTime = 0;
  createMediaStreamSource = vi.fn(() => new MockMediaStreamSourceNode() as unknown as MediaStreamAudioSourceNode);
  createGain = vi.fn(() => new MockGainNode() as unknown as GainNode);
  createMediaStreamDestination = vi.fn(
    () => new MockMediaStreamDestinationNode() as unknown as MediaStreamAudioDestinationNode,
  );
  createAnalyser = vi.fn(() => new MockAnalyserNode() as unknown as AnalyserNode);
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}

type PreloadWindow = Window & { aiembodied?: import('../src/preload-api.js').PreloadApi };

function createAvatarBridgeMock(overrides: Partial<AvatarBridge> = {}): AvatarBridge {
  return {
    listFaces: vi.fn().mockResolvedValue([]),
    getActiveFace: vi.fn().mockResolvedValue(null),
    setActiveFace: vi.fn().mockResolvedValue(null),
    generateFace: vi.fn().mockResolvedValue({ generationId: 'gen-ui', candidates: [] } as AvatarGenerationResult),
    applyGeneratedFace: vi.fn().mockResolvedValue({ faceId: 'avatar-face-id' }),
    deleteFace: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    getActiveModel: vi.fn().mockResolvedValue(null),
    setActiveModel: vi.fn().mockResolvedValue(null),
    uploadModel: vi.fn().mockResolvedValue({
      model: {
        id: 'vrm-0',
        name: 'Default',
        createdAt: Date.now(),
        version: '1.0',
        fileSha: 'sha',
        thumbnailDataUrl: null,
      },
    }),
    deleteModel: vi.fn().mockResolvedValue(undefined),
    loadModelBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    listAnimations: vi.fn().mockResolvedValue([]),
    uploadAnimation: vi.fn().mockResolvedValue({
      animation: {
        id: 'vrma-0',
        name: 'Idle',
        createdAt: Date.now(),
        fileSha: 'sha',
        duration: null,
        fps: null,
      },
    }),
    generateAnimation: vi.fn().mockResolvedValue({
      animation: {
        id: 'vrma-generated',
        name: 'Generated',
        createdAt: Date.now(),
        fileSha: 'sha',
        duration: null,
        fps: null,
      },
    }),
    deleteAnimation: vi.fn().mockResolvedValue(undefined),
    loadAnimationBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    getDisplayModePreference: vi.fn().mockResolvedValue('sprites'),
    setDisplayModePreference: vi.fn().mockResolvedValue(undefined),
    triggerBehaviorCue: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('App component', () => {
  const originalAudioContext = window.AudioContext;
  const originalMediaDevices = navigator.mediaDevices;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleInfo = console.info;
  const originalConsoleDebug = console.debug;
  const originalPeerConnection = window.RTCPeerConnection;

  const enumerateDevicesMock = vi.fn();
  const getUserMediaMock = vi.fn();
  const setAudioDevicePreferencesMock = vi.fn();
  const setSecretMock = vi.fn();
  const testSecretMock = vi.fn();
  const mintEphemeralTokenMock = vi.fn();
  let wakeListener: ((event: WakeWordDetectionEvent) => void) | undefined;
  let rendererConfig: RendererConfig;

  beforeEach(() => {
    realtimeClientInstances.length = 0;
    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext = MockAudioContext as unknown as typeof AudioContext;
    (navigator as Navigator & { mediaDevices: MediaDevices }).mediaDevices = {
      enumerateDevices: enumerateDevicesMock,
      getUserMedia: getUserMediaMock,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      ondevicechange: null,
    } as unknown as MediaDevices;

    enumerateDevicesMock.mockResolvedValue([
      { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Mic' },
      { deviceId: 'speaker-1', kind: 'audiooutput', label: 'Speakers' },
    ] as MediaDeviceInfo[]);
    getUserMediaMock.mockResolvedValue(new MockMediaStream() as unknown as MediaStream);

    rendererConfig = {
      audioInputDeviceId: 'mic-1',
      audioOutputDeviceId: '',
      featureFlags: { transcriptOverlay: true },
      hasRealtimeApiKey: true,
      realtimeVoice: 'verse',
      metrics: {
        enabled: false,
        host: '127.0.0.1',
        port: 9090,
        path: '/metrics',
      },
      wakeWord: {
        keywordPath: '',
        keywordLabel: '',
        sensitivity: 0.5,
        minConfidence: 0.5,
        cooldownMs: 1500,
        deviceIndex: undefined,
        modelPath: undefined,
        hasAccessKey: true,
      },
    };

    setAudioDevicePreferencesMock.mockResolvedValue(rendererConfig);
    setSecretMock.mockResolvedValue(rendererConfig);
    testSecretMock.mockResolvedValue({ ok: true, message: 'API key verified successfully.' });
    mintEphemeralTokenMock.mockReset();
    mintEphemeralTokenMock.mockResolvedValue({ value: 'ephemeral-token' });

    wakeListener = undefined;
    console.error = vi.fn();
    console.warn = vi.fn();
    console.info = vi.fn();
    console.debug = vi.fn();
    Reflect.deleteProperty(window as { RTCPeerConnection?: typeof RTCPeerConnection }, 'RTCPeerConnection');
  });

  afterEach(() => {
    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext = originalAudioContext;
    (navigator as Navigator & { mediaDevices: MediaDevices }).mediaDevices = originalMediaDevices;
    Reflect.deleteProperty(window as PreloadWindow, 'aiembodied');
    enumerateDevicesMock.mockReset();
    getUserMediaMock.mockReset();
    setAudioDevicePreferencesMock.mockReset();
    setSecretMock.mockReset();
    testSecretMock.mockReset();
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.info = originalConsoleInfo;
    console.debug = originalConsoleDebug;
    if (originalPeerConnection) {
      (window as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = originalPeerConnection;
    } else {
      Reflect.deleteProperty(window as { RTCPeerConnection?: typeof RTCPeerConnection }, 'RTCPeerConnection');
    }
  });

  const getMainTablist = () => screen.findByRole('tablist', { name: /Kiosk sections/i });

  const openTab = async (name: RegExp | string) => {
    const tablist = await getMainTablist();
    const tab = await within(tablist).findByRole('tab', { name });
    fireEvent.click(tab);
    return tab;
  };

  it('renders tab navigation and toggles panels', async () => {
    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue(rendererConfig),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: { onWake: () => () => {} },
      avatar: createAvatarBridgeMock(),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    render(<App />);

    const mainTablist = await getMainTablist();
    const tabs = within(mainTablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['ChatGPT', 'Character', 'Local']);

    const chatPanel = await screen.findByRole('tabpanel', { name: /ChatGPT/i });
    expect(within(chatPanel).getByRole('heading', { name: /Embodied Assistant/i })).toBeInTheDocument();

    await openTab(/Character/i);
    const characterPanel = await screen.findByRole('tabpanel', { name: /Character/i });
    expect(within(characterPanel).getByLabelText('Voice')).toBeInTheDocument();

    await openTab(/Local/i);
    const localPanel = await screen.findByRole('tabpanel', { name: /Local/i });
    expect(within(localPanel).getByLabelText('Microphone')).toBeInTheDocument();

    await openTab(/ChatGPT/i);
    expect(await screen.findByText(/Speech gate:/i)).toBeInTheDocument();
  });

  it('keeps configurator mounted and loads the active face even when the tab is inactive', async () => {
    const now = Date.now();
    const listFacesMock = vi
      .fn()
      .mockResolvedValue([{ id: 'face-1', name: 'Test Face', createdAt: now, previewDataUrl: null }]);
    const getActiveFaceMock = vi
      .fn()
      .mockResolvedValue({ id: 'face-1', name: 'Test Face', createdAt: now, components: [] });

    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue(rendererConfig),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: { onWake: () => () => {} },
      avatar: createAvatarBridgeMock({ listFaces: listFacesMock, getActiveFace: getActiveFaceMock }),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    render(<App />);

    await waitFor(() => expect(listFacesMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getActiveFaceMock).toHaveBeenCalledTimes(1));

    const characterPanel = await waitFor(() => {
      const panel = document.getElementById('panel-character');
      if (!panel) {
        throw new Error('Character panel not mounted');
      }
      return panel;
    });

    expect(characterPanel.getAttribute('data-state')).toBe('inactive');

    await openTab(/Character/i);

    await waitFor(() => expect(characterPanel.getAttribute('data-state')).toBe('active'));
    expect(getActiveFaceMock).toHaveBeenCalledTimes(1);

    const localPanel = document.getElementById('panel-local');
    expect(localPanel).not.toBeNull();
    expect(localPanel?.getAttribute('data-state')).toBe('inactive');
  });

  it('renders the static realtime voice list without querying the API', async () => {
    const fetchMock = vi.fn();
    const originalFetch = global.fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      rendererConfig = {
        ...rendererConfig,
        realtimeVoice: 'verse',
        hasRealtimeApiKey: true,
      };
      setAudioDevicePreferencesMock.mockResolvedValue(rendererConfig);

      (window as PreloadWindow).aiembodied = {
        ping: () => 'pong',
        config: {
          get: vi.fn().mockResolvedValue(rendererConfig),
          getSecret: vi.fn().mockResolvedValue('secret'),
          setAudioDevicePreferences: setAudioDevicePreferencesMock,
          setSecret: setSecretMock,
          testSecret: testSecretMock,
        },
        wakeWord: { onWake: () => () => {} },
        avatar: createAvatarBridgeMock(),
        __bridgeReady: true,
        __bridgeVersion: '1.0.0',
      } as unknown as PreloadWindow['aiembodied'];

      render(<App />);

      await openTab(/Character/i);

      const select = (await screen.findByLabelText('Voice')) as HTMLSelectElement;
      const optionValues = Array.from(select.options).map((option) => option.value);

      expect(optionValues).toEqual(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
  });

  it('extends voice options with config and server supplied voices', async () => {
    const fetchMock = vi.fn();
    const originalFetch = global.fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      rendererConfig = {
        ...rendererConfig,
        realtimeVoice: 'config-custom',
        hasRealtimeApiKey: true,
      };
      setAudioDevicePreferencesMock.mockResolvedValue(rendererConfig);

      (window as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = vi
        .fn()
        .mockReturnValue({ addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() }) as unknown as typeof RTCPeerConnection;

      (window as PreloadWindow).aiembodied = {
        ping: () => 'pong',
        config: {
          get: vi.fn().mockResolvedValue(rendererConfig),
          getSecret: vi.fn().mockResolvedValue('secret'),
          setAudioDevicePreferences: setAudioDevicePreferencesMock,
          setSecret: setSecretMock,
          testSecret: testSecretMock,
        },
        wakeWord: { onWake: () => () => {} },
        avatar: createAvatarBridgeMock(),
        __bridgeReady: true,
        __bridgeVersion: '1.0.0',
      } as unknown as PreloadWindow['aiembodied'];

      render(<App />);

      await openTab(/Character/i);

      const select = (await screen.findByLabelText('Voice')) as HTMLSelectElement;

      await waitFor(() => {
        expect(select.value).toBe('config-custom');
      });

      expect(fetchMock).not.toHaveBeenCalled();

      expect(realtimeClientInstances.length).toBeGreaterThan(0);
      const client = realtimeClientInstances[realtimeClientInstances.length - 1];
      client.callbacks.onSessionUpdated?.({ voice: 'server-special' });

      await waitFor(() => {
        const optionValues = Array.from(select.options).map((option) => option.value);
        expect(optionValues).toEqual([
          'alloy',
          'ash',
          'ballad',
          'coral',
          'echo',
          'sage',
          'shimmer',
          'verse',
          'config-custom',
          'server-special',
        ]);
      });
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
  });

  it('stages realtime session config with prompt before connecting', async () => {
    (window as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = vi
      .fn()
      .mockReturnValue({ addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() }) as unknown as typeof RTCPeerConnection;

    const configWithPrompt: RendererConfig = {
      ...rendererConfig,
      sessionInstructions: 'Follow the config script precisely.',
      vadTurnDetection: 'server_vad',
      vadThreshold: 0.61,
      vadSilenceDurationMs: 720,
      vadMinSpeechDurationMs: 280,
    };

    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue(configWithPrompt),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: { onWake: () => () => {} },
      avatar: createAvatarBridgeMock(),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    render(<App />);

    const listeningToggle = await screen.findByTestId('listening-toggle');
    fireEvent.click(listeningToggle);

    await waitFor(() => {
      expect(realtimeClientInstances.length).toBeGreaterThan(0);
    });

    const client = realtimeClientInstances[realtimeClientInstances.length - 1];

    await waitFor(() => {
      expect(client.updateSessionConfig).toHaveBeenCalled();
    });

    const expectedPrompt = 'Follow the config script precisely.';

    await waitFor(() => {
      expect(
        client.updateSessionConfig.mock.calls.some(([payload]) => {
          if (!payload || typeof payload !== 'object' || !('instructions' in payload)) {
            return false;
          }
          const instructions = (payload as { instructions?: string }).instructions;
          return typeof instructions === 'string' && instructions.includes(expectedPrompt);
        }),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(client.connect).toHaveBeenCalled();
    });

    const matchingCallIndex = client.updateSessionConfig.mock.calls.findIndex(([payload]) => {
      if (!payload || typeof payload !== 'object') {
        return false;
      }
      const instructions = (payload as { instructions?: string }).instructions;
      const hasPrompt = typeof instructions === 'string' && instructions.includes(expectedPrompt);
      const vadThreshold = (
        payload as { vad?: { threshold?: number; silenceDurationMs?: number; minSpeechDurationMs?: number } }
      ).vad?.threshold;
      return hasPrompt && vadThreshold === 0.61;
    });
    expect(matchingCallIndex).toBeGreaterThanOrEqual(0);

    const stagedPayload = client.updateSessionConfig.mock.calls[matchingCallIndex]?.[0];
    expect(stagedPayload).toMatchObject({
      voice: 'verse',
      turnDetection: 'server_vad',
      vad: {
        threshold: 0.61,
        silenceDurationMs: 720,
        minSpeechDurationMs: 280,
      },
    });
    expect((stagedPayload as { instructions?: string }).instructions).toContain(expectedPrompt);

    const stagedOrder = client.updateSessionConfig.mock.invocationCallOrder[matchingCallIndex];
    const connectOrder = client.connect.mock.invocationCallOrder[0];
    expect(stagedOrder).toBeLessThan(connectOrder);
  });

  it('renders kiosk UI, toggles transcript overlay, and persists device preferences', async () => {
    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue({
          audioInputDeviceId: '',
          audioOutputDeviceId: '',
          featureFlags: { transcriptOverlay: true },
          hasRealtimeApiKey: true,
          wakeWord: {
            keywordPath: '',
            keywordLabel: '',
            sensitivity: 0.5,
            minConfidence: 0.5,
            cooldownMs: 1500,
            deviceIndex: undefined,
            modelPath: undefined,
            hasAccessKey: true,
          },
        }),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: {
        onWake: (listener: (event: { keywordLabel: string; confidence: number }) => void) => {
          wakeListener = listener;
          return () => {
            wakeListener = undefined;
          };
        },
      },
      avatar: createAvatarBridgeMock(),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    render(<App />);

    await waitFor(() => {
      expect(enumerateDevicesMock).toHaveBeenCalled();
    });

    expect(screen.getByTestId('wake-value')).toHaveTextContent(/Idle/i);
    wakeListener?.({ keywordLabel: 'Picovoice', confidence: 0.88, timestamp: Date.now() });
    await waitFor(() => {
      expect(screen.getByTestId('wake-value')).toHaveTextContent(/Awake/i);
    });

    expect(screen.getByTestId('transcript-overlay')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('transcript-toggle'));
    expect(screen.queryByTestId('transcript-overlay')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId('transcript-overlay')).toBeInTheDocument();

    await openTab(/Local/i);

    const inputSelect = await screen.findByLabelText('Microphone');
    fireEvent.change(inputSelect, { target: { value: 'mic-1' } });

    await waitFor(() => {
      expect(setAudioDevicePreferencesMock).toHaveBeenCalledWith({
        audioInputDeviceId: 'mic-1',
        audioOutputDeviceId: undefined,
      });
    });

    const speakerSelect = screen.getByLabelText('Speakers');
    fireEvent.change(speakerSelect, { target: { value: 'speaker-1' } });

    await waitFor(() => {
      expect(setAudioDevicePreferencesMock).toHaveBeenLastCalledWith({
        audioInputDeviceId: 'mic-1',
        audioOutputDeviceId: 'speaker-1',
      });
    });

    expect(screen.getByRole('heading', { level: 2, name: /API keys/i })).toBeInTheDocument();
    const realtimeCard = screen.getByRole('heading', { name: /OpenAI Realtime API key/i }).closest('article');
    expect(realtimeCard).not.toBeNull();
    if (realtimeCard) {
      expect(within(realtimeCard).getByText(/Status: Configured/i)).toBeInTheDocument();
    }

    await openTab(/ChatGPT/i);

    expect(await screen.findByText(/Speech gate:/i)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /Embodied Assistant/i })).toBeInTheDocument();
  });

  it('allows pausing and resuming listening while disconnecting realtime sessions', async () => {
    (window as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = vi
      .fn()
      .mockReturnValue({ addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() }) as unknown as typeof RTCPeerConnection;

    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue({
          audioInputDeviceId: 'mic-1',
          audioOutputDeviceId: '',
          featureFlags: { transcriptOverlay: true },
          hasRealtimeApiKey: true,
          wakeWord: {
            keywordPath: '',
            keywordLabel: '',
            sensitivity: 0.5,
            minConfidence: 0.5,
            cooldownMs: 1500,
            deviceIndex: undefined,
            modelPath: undefined,
            hasAccessKey: true,
          },
        }),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: {
        onWake: (listener: (event: WakeWordDetectionEvent) => void) => {
          wakeListener = listener;
          return () => {
            wakeListener = undefined;
          };
        },
      },
      avatar: createAvatarBridgeMock(),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    render(<App />);

    const listeningToggle = await screen.findByTestId('listening-toggle');
    expect(listeningToggle).toHaveTextContent(/Enable listening/i);
    expect(listeningToggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(listeningToggle);

    await waitFor(() => {
      expect(listeningToggle).toHaveTextContent(/Disable listening/i);
      expect(listeningToggle).toHaveAttribute('aria-pressed', 'true');
    });

    await waitFor(() => {
      expect(realtimeClientInstances.length).toBeGreaterThan(0);
    });

    for (const instance of realtimeClientInstances) {
      instance.disconnect.mockClear();
    }

    fireEvent.click(listeningToggle);

    await waitFor(() => {
      expect(listeningToggle).toHaveAttribute('aria-pressed', 'false');
      expect(listeningToggle).toHaveTextContent(/Enable listening/i);
    });

    await waitFor(() => {
      const audioIndicator = screen.getByTestId('audio-indicator');
      expect(within(audioIndicator).getByText(/Listening disabled/i)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(
        realtimeClientInstances.some((instance) => instance.disconnect.mock.calls.length > 0),
      ).toBe(true);
    });

    const realtimeIndicator = screen.getByTestId('realtime-indicator');
    expect(within(realtimeIndicator).getByText(/Disabled \(listening paused\)/i)).toBeInTheDocument();

    fireEvent.click(listeningToggle);

    await waitFor(() => {
      expect(listeningToggle).toHaveAttribute('aria-pressed', 'true');
      expect(listeningToggle).toHaveTextContent(/Disable listening/i);
    });
  });

  it('logs diagnostics while polling for the preload bridge when unavailable', async () => {
    render(<App />);

    await waitFor(() =>
      expect((console.warn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining('Preload API unavailable (API not exposed); renderer still polling for bridge exposure.'),
        expect.objectContaining({
          attempt: 1,
          descriptorType: 'missing',
          hasWindowProperty: false,
          hasConfigBridge: false,
        }),
      ),
    );

    await waitFor(() =>
      expect((console.error as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining('Configuration bridge unavailable while loading renderer config.'),
        expect.objectContaining({ effect: 'load-config', descriptorType: 'missing' }),
      ),
    );

    const warnCall = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('Preload API unavailable (API not exposed); renderer still polling for bridge exposure.'),
    );
    expect(warnCall?.[1]).toMatchObject({
      attempt: 1,
      availableWindowBridgeKeys: [],
      hasPingFunction: false,
    });

    const errorCall = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('Configuration bridge unavailable while loading renderer config.'),
    );
    expect(errorCall?.[1]).toMatchObject({
      effect: 'load-config',
      availableWindowBridgeKeys: [],
      hasConfigBridge: false,
      hasPingFunction: false,
    });
  });

  it('logs a warning when the preload API omits the avatar bridge', async () => {
    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue(rendererConfig),
        getSecret: vi.fn().mockResolvedValue('rt-secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: {
        onWake: (listener: (event: WakeWordDetectionEvent) => void) => {
          wakeListener = listener;
          return () => {
            wakeListener = undefined;
          };
        },
      },
      conversation: undefined,
      metrics: undefined,
      avatar: undefined,
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    render(<App />);

    await waitFor(() =>
      expect((console.warn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining('Avatar configuration bridge missing from preload API.'),
        expect.objectContaining({ hasAvatarBridge: false, hasConfigBridge: true }),
      ),
    );
  });

  it('loads persisted conversation history and records new session messages', async () => {
    const appendMessageMock = vi.fn(
      async (payload: ConversationAppendMessagePayload): Promise<ConversationMessage> => ({
        id: `message-${appendMessageMock.mock.calls.length + 1}`,
        sessionId: payload.sessionId ?? 'missing-session',
        role: payload.role,
        content: payload.content,
        ts: payload.ts ?? Date.now(),
        audioPath: payload.audioPath ?? null,
      }),
    );

    let sessionListener: ((session: ConversationSession) => void) | undefined;
    let messageListener: ((message: ConversationMessage) => void) | undefined;

    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue({
          audioInputDeviceId: '',
          audioOutputDeviceId: '',
          featureFlags: { transcriptOverlay: true },
          hasRealtimeApiKey: true,
          wakeWord: {
            keywordPath: '',
            keywordLabel: '',
            sensitivity: 0.5,
            minConfidence: 0.5,
            cooldownMs: 1500,
            deviceIndex: undefined,
            modelPath: undefined,
            hasAccessKey: true,
          },
        }),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: {
        onWake: (listener: (event: WakeWordDetectionEvent) => void) => {
          wakeListener = listener;
          return () => {
            wakeListener = undefined;
          };
        },
      },
      avatar: createAvatarBridgeMock(),
      conversation: {
        getHistory: vi.fn().mockResolvedValue({
          currentSessionId: 'session-1',
          sessions: [
            {
              id: 'session-1',
              startedAt: 1_700_000_000_000,
              title: null,
              messages: [
                {
                  id: 'message-1',
                  sessionId: 'session-1',
                  role: 'assistant',
                  ts: 1_700_000_005_000,
                  content: 'Welcome back! 👋',
                  audioPath: null,
                },
              ],
            },
          ],
        }),
        appendMessage: appendMessageMock,
        onSessionStarted: (listener: (session: ConversationSession) => void) => {
          sessionListener = listener;
          return () => {
            if (sessionListener === listener) {
              sessionListener = undefined;
            }
          };
        },
        onMessageAppended: (listener: (message: ConversationMessage) => void) => {
          messageListener = listener;
          return () => {
            if (messageListener === listener) {
              messageListener = undefined;
            }
          };
        },
      },
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    render(<App />);

    expect(await screen.findByText('Welcome back! 👋')).toBeInTheDocument();

    sessionListener?.({ id: 'session-2', startedAt: 1_700_000_010_000, title: null });

    await waitFor(() => {
      expect(screen.queryByText('Welcome back! 👋')).not.toBeInTheDocument();
    });

    expect(wakeListener).toBeDefined();
    wakeListener?.({
      keywordLabel: 'Picovoice',
      confidence: 0.94,
      timestamp: 1_700_000_010_500,
      sessionId: 'session-2',
    });

    await waitFor(() => {
      expect(appendMessageMock).toHaveBeenCalledTimes(1);
    });

    const recordedPayload = appendMessageMock.mock.calls[0]?.[0];
    expect(recordedPayload?.sessionId).toBe('session-2');
    expect(recordedPayload?.role).toBe('system');
    expect(recordedPayload?.content).toMatch(/Wake word detected/i);

    expect(await screen.findByText(/Wake word detected/i)).toBeInTheDocument();

    messageListener?.({
      id: 'message-remote',
      sessionId: 'session-2',
      role: 'assistant',
      ts: 1_700_000_011_000,
      content: 'Hello again! 😄',
      audioPath: null,
    });

    expect(await screen.findByText('Hello again! 😄')).toBeInTheDocument();

    messageListener?.({
      id: 'message-old',
      sessionId: 'session-1',
      role: 'assistant',
      ts: 1_700_000_012_000,
      content: 'Should stay hidden',
      audioPath: null,
    });

    await waitFor(() => {
      expect(screen.queryByText('Should stay hidden')).not.toBeInTheDocument();
    });
  });

  it('updates realtime api key via configuration form', async () => {
    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue({
          audioInputDeviceId: '',
          audioOutputDeviceId: '',
          featureFlags: {},
          hasRealtimeApiKey: true,
          wakeWord: {
            keywordPath: '',
            keywordLabel: '',
            sensitivity: 0.5,
            minConfidence: 0.5,
            cooldownMs: 1500,
            deviceIndex: undefined,
            modelPath: undefined,
            hasAccessKey: true,
          },
        }),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: {
        onWake: () => () => {},
      },
      avatar: createAvatarBridgeMock(),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    setSecretMock.mockResolvedValueOnce({
      audioInputDeviceId: '',
      audioOutputDeviceId: '',
      featureFlags: {},
      hasRealtimeApiKey: true,
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: {
        keywordPath: '',
        keywordLabel: '',
        sensitivity: 0.5,
        minConfidence: 0.5,
        cooldownMs: 1500,
        deviceIndex: undefined,
        modelPath: undefined,
        hasAccessKey: true,
      },
    });

    render(<App />);

    await openTab(/Local/i);

    const realtimeHeading = await screen.findByRole('heading', { name: /OpenAI Realtime API key/i });
    const realtimePanel = realtimeHeading.closest('article');
    expect(realtimePanel).not.toBeNull();
    if (!realtimePanel) {
      throw new Error('Realtime secret panel missing');
    }

    const input = within(realtimePanel).getByLabelText(/New OpenAI Realtime API key/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: ' new-secret ' } });

    const updateButton = within(realtimePanel).getByRole('button', { name: /update key/i });
    fireEvent.click(updateButton);

    await waitFor(() => {
      expect(setSecretMock).toHaveBeenCalledWith('realtimeApiKey', 'new-secret');
    });

    expect(input.value).toBe('');
    expect(await within(realtimePanel).findByText(/API key updated successfully/i)).toBeInTheDocument();
  });

  it('uses the latest preload bridge when submitting a secret before the hook state updates', async () => {
    Reflect.deleteProperty(window as PreloadWindow, 'aiembodied');

    setSecretMock.mockResolvedValueOnce({
      ...rendererConfig,
      hasRealtimeApiKey: true,
    });

    render(<App />);

    const getSecretSpy = vi.fn().mockResolvedValue('late-secret');
    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue(rendererConfig),
        getSecret: getSecretSpy,
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: { onWake: () => () => {} },
      avatar: createAvatarBridgeMock(),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    await openTab(/Local/i);

    const realtimeHeading = await screen.findByRole('heading', { name: /OpenAI Realtime API key/i });
    const realtimePanel = realtimeHeading.closest('article');
    expect(realtimePanel).not.toBeNull();
    if (!realtimePanel) {
      throw new Error('Realtime secret panel missing');
    }

    const input = within(realtimePanel).getByLabelText(/New OpenAI Realtime API key/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: ' late-secret ' } });

    const updateButton = within(realtimePanel).getByRole('button', { name: /update key/i });
    fireEvent.click(updateButton);

    await waitFor(() => {
      expect(setSecretMock).toHaveBeenCalledWith('realtimeApiKey', 'late-secret');
    });

    expect(await within(realtimePanel).findByText(/API key updated successfully/i)).toBeInTheDocument();
  });

  it('reports wake word access key test failures', async () => {
    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue({
          audioInputDeviceId: '',
          audioOutputDeviceId: '',
          featureFlags: {},
          hasRealtimeApiKey: true,
          wakeWord: {
            keywordPath: '',
            keywordLabel: '',
            sensitivity: 0.5,
            minConfidence: 0.5,
            cooldownMs: 1500,
            deviceIndex: undefined,
            modelPath: undefined,
            hasAccessKey: true,
          },
        }),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: {
        onWake: () => () => {},
      },
      avatar: createAvatarBridgeMock(),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    testSecretMock.mockResolvedValueOnce({ ok: false, message: 'Invalid Porcupine access key' });

    render(<App />);

    await openTab(/Local/i);

    const wakeHeading = await screen.findByRole('heading', { name: /Porcupine access key/i });
    const wakePanel = wakeHeading.closest('article');
    expect(wakePanel).not.toBeNull();
    if (!wakePanel) {
      throw new Error('Wake word secret panel missing');
    }

    const testButton = within(wakePanel).getByRole('button', { name: /test key/i });
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(testSecretMock).toHaveBeenCalledWith('wakeWordAccessKey');
    });

    expect(within(wakePanel).getByText(/Invalid Porcupine access key/i)).toBeInTheDocument();
  });

  it('syncs the base prompt textarea with realtime session updates', async () => {
    const DEFAULT_PROMPT =
      'You are an English-speaking assistant. Always respond in concise English. Do not switch languages unless explicitly instructed.';

    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue({
          audioInputDeviceId: '',
          audioOutputDeviceId: '',
          featureFlags: {},
          hasRealtimeApiKey: true,
          realtimeVoice: 'verse',
          sessionInstructions: 'Persisted instructions from config',
          wakeWord: {
            keywordPath: '',
            keywordLabel: '',
            sensitivity: 0.5,
            minConfidence: 0.5,
            cooldownMs: 1500,
            deviceIndex: undefined,
            modelPath: undefined,
            hasAccessKey: true,
          },
        }),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: { onWake: () => () => {} },
      avatar: createAvatarBridgeMock(),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    (window as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = vi
      .fn()
      .mockReturnValue({ addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() }) as unknown as typeof RTCPeerConnection;

    render(<App />);

    await openTab(/Character/i);

    const textarea = (await screen.findByLabelText(/Base prompt/i)) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(textarea.value).toBe('Persisted instructions from config');
    });

    expect(realtimeClientInstances.length).toBeGreaterThan(0);
    const instance = realtimeClientInstances[realtimeClientInstances.length - 1];
    instance.callbacks.onSessionUpdated?.({ instructions: 'Server-sourced base prompt', voice: 'alloy' });

    await waitFor(() => {
      expect(textarea.value).toBe('Server-sourced base prompt');
    });

    instance.callbacks.onSessionUpdated?.({ instructions: '   ' });

    await waitFor(() => {
      expect(textarea.value).toBe(DEFAULT_PROMPT);
    });
  });

  it('surfaces configuration errors when preload bridge is unavailable', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Renderer preload API is unavailable/i)).toBeInTheDocument();
    });
  });

  it('logs realtime disconnect and reconnect when voice preference changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as Response);
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    (window as PreloadWindow).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue({
          audioInputDeviceId: '',
          audioOutputDeviceId: '',
          featureFlags: {},
          hasRealtimeApiKey: true,
          realtimeVoice: 'verse',
          wakeWord: {
            keywordPath: '',
            keywordLabel: '',
            sensitivity: 0.5,
            minConfidence: 0.5,
            cooldownMs: 1500,
            deviceIndex: undefined,
            modelPath: undefined,
            hasAccessKey: true,
          },
        }),
        getSecret: vi.fn().mockResolvedValue('secret'),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
        setSecret: setSecretMock,
        testSecret: testSecretMock,
      },
      realtime: { mintEphemeralToken: mintEphemeralTokenMock },
      wakeWord: { onWake: () => () => {} },
      avatar: createAvatarBridgeMock(),
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    } as unknown as PreloadWindow['aiembodied'];

    (window as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = vi
      .fn()
      .mockReturnValue({ addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() }) as unknown as typeof RTCPeerConnection;

    try {
      render(<App />);

      const listeningToggle = await screen.findByTestId('listening-toggle');
      fireEvent.click(listeningToggle);

      await waitFor(() => {
        expect(realtimeClientInstances.length).toBeGreaterThan(0);
      });

      const instance = realtimeClientInstances[realtimeClientInstances.length - 1];

      await waitFor(() => {
        expect(instance.connect.mock.calls.length).toBeGreaterThan(0);
      });

      const initialConnectCalls = instance.connect.mock.calls.length;
      const initialDisconnectCalls = instance.disconnect.mock.calls.length;

      await openTab(/Character/i);

      const voiceSelect = (await screen.findByLabelText('Voice')) as HTMLSelectElement;
      fireEvent.change(voiceSelect, { target: { value: 'ash' } });

      await waitFor(() => {
        expect(instance.disconnect.mock.calls.length).toBeGreaterThan(initialDisconnectCalls);
      });

      await waitFor(() => {
        expect(instance.connect.mock.calls.length).toBeGreaterThan(initialConnectCalls);
      });

      await waitFor(() => {
        const infoCalls = (console.info as unknown as ReturnType<typeof vi.fn>).mock.calls;
        expect(
          infoCalls.some(
            (call) => typeof call[0] === 'string' && call[0].includes('Voice change requested; disconnecting current session'),
          ),
        ).toBe(true);
        expect(
          infoCalls.some(
            (call) => typeof call[0] === 'string' && call[0].includes('Voice change reconnect initiated with'),
          ),
        ).toBe(true);
      });
    } finally {
      if (originalFetch) {
        (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
      } else {
        Reflect.deleteProperty(globalThis as { fetch?: typeof fetch }, 'fetch');
      }
    }
  });
});
