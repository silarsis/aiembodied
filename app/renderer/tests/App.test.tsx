import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  let wakeListener: ((event: { keywordLabel: string; confidence: number }) => void) | undefined;

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

    setAudioDevicePreferencesMock.mockResolvedValue({
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
    });

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
        getSecret: vi.fn(),
        setAudioDevicePreferences: setAudioDevicePreferencesMock,
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
    wakeListener?.({ keywordLabel: 'Picovoice', confidence: 0.88 });
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

    expect(screen.getByText(/Speech gate:/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Embodied Assistant/i })).toBeInTheDocument();
  });

  it('surfaces configuration errors when preload bridge is unavailable', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Renderer preload API is unavailable/i)).toBeInTheDocument();
    });
  });
});
