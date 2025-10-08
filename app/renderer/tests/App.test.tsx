import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationAppendMessagePayload,
  ConversationMessage,
  ConversationSession,
} from '../../main/src/conversation/types.js';
import type { WakeWordDetectionEvent } from '../../main/src/wake-word/types.js';
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

type PreloadWindow = Window & { aiembodied?: import('../../main/src/preload.js').PreloadApi };

describe('App component', () => {
  const originalAudioContext = window.AudioContext;
  const originalMediaDevices = navigator.mediaDevices;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleDebug = console.debug;
  const originalPeerConnection = window.RTCPeerConnection;

  const enumerateDevicesMock = vi.fn();
  const getUserMediaMock = vi.fn();
  const setAudioDevicePreferencesMock = vi.fn();
  const setSecretMock = vi.fn();
  const testSecretMock = vi.fn();
  let wakeListener: ((event: WakeWordDetectionEvent) => void) | undefined;

  beforeEach(() => {
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

    const rendererConfig = {
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
    };

    setAudioDevicePreferencesMock.mockResolvedValue(rendererConfig);
    setSecretMock.mockResolvedValue(rendererConfig);
    testSecretMock.mockResolvedValue({ ok: true, message: 'API key verified successfully.' });

    wakeListener = undefined;
    console.error = vi.fn();
    console.warn = vi.fn();
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
    console.debug = originalConsoleDebug;
    if (originalPeerConnection) {
      (window as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = originalPeerConnection;
    } else {
      Reflect.deleteProperty(window as { RTCPeerConnection?: typeof RTCPeerConnection }, 'RTCPeerConnection');
    }
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
      wakeWord: {
        onWake: (listener: (event: { keywordLabel: string; confidence: number }) => void) => {
          wakeListener = listener;
          return () => {
            wakeListener = undefined;
          };
        },
      },
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

    expect(screen.getByText(/Speech gate:/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Embodied Assistant/i })).toBeInTheDocument();
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
      wakeWord: {
        onWake: (listener: (event: WakeWordDetectionEvent) => void) => {
          wakeListener = listener;
          return () => {
            wakeListener = undefined;
          };
        },
      },
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
      wakeWord: {
        onWake: () => () => {},
      },
    } as unknown as PreloadWindow['aiembodied'];

    setSecretMock.mockResolvedValueOnce({
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
    });

    render(<App />);

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
    expect(within(realtimePanel).getByText(/API key updated successfully/i)).toBeInTheDocument();
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
      wakeWord: {
        onWake: () => () => {},
      },
    } as unknown as PreloadWindow['aiembodied'];

    testSecretMock.mockResolvedValueOnce({ ok: false, message: 'Invalid Porcupine access key' });

    render(<App />);

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

  it('surfaces configuration errors when preload bridge is unavailable', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Renderer preload API is unavailable/i)).toBeInTheDocument();
    });
  });
});
