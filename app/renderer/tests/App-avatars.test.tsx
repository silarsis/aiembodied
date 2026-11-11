import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationAppendMessagePayload, ConversationMessage, ConversationSession } from '../../main/src/conversation/types.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../../main/src/config/provider-settings.js';
import { builtInServers, defaultRoutes } from '../../main/src/config/model-routing.js';
import type { AvatarModelSummary } from '../src/avatar/types.js';

interface FakeCallbacks {
  onAssistantTranscript?: (text: string, avatarId?: string) => void;
  onAvatarStream?: (avatarId: string, stream: MediaStream) => void;
  onTextContent?: (content: string, avatarId?: string) => void;
}

const localClients = vi.hoisted(() => [] as Array<{ callbacks: FakeCallbacks }>);

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

describe('App with several avatars (local backend)', () => {
  const originalAudioContext = window.AudioContext;
  const originalMediaDevices = navigator.mediaDevices;
  const originalConsole = { error: console.error, warn: console.warn, info: console.info, debug: console.debug };

  beforeEach(() => {
    localClients.length = 0;
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

  it('saves each assistant line under the avatar that said it, and reads the avatar list', async () => {
    const appendMessage = vi.fn(
      async (payload: ConversationAppendMessagePayload): Promise<ConversationMessage> => ({
        id: `message-${appendMessage.mock.calls.length}`,
        sessionId: payload.sessionId ?? 'none',
        role: payload.role,
        content: payload.content,
        ts: payload.ts ?? Date.now(),
        audioPath: null,
      }),
    );
    let sessionListener: ((session: ConversationSession) => void) | undefined;
    const avatarsList = vi.fn().mockResolvedValue([
      { id: 'echo', name: 'Echo', vrmModelId: 'm1' },
      { id: 'sage', name: 'Sage', vrmModelId: 'm1' },
    ]);
    const listModels = vi.fn().mockResolvedValue([model('m1')]);
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
    const models = {
      get: vi.fn(async () => ({
        servers: builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }).map((server) => ({ ...server, hasKey: false })),
        routes: defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
      })),
      probe: vi.fn(async () => ({ status: 'up', models: {}, checkedAt: 0 })),
    };
    (window as unknown as { aiembodied: unknown }).aiembodied = {
      ping: () => 'pong',
      config: {
        get: vi.fn().mockResolvedValue(config),
        getSecret: vi.fn().mockResolvedValue(null),
        setAudioDevicePreferences: vi.fn().mockResolvedValue(config),
      },
      wakeWord: { onWake: () => () => undefined },
      avatars: { list: avatarsList },
      avatar: new Proxy(
        { listModels, getActiveModel: vi.fn().mockResolvedValue(model('m1')), loadModelBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)) },
        {
          get: (target, key) => {
            if (key in target) return (target as Record<string | symbol, unknown>)[key];
            // Subscriptions return an unsubscribe function; everything else resolves to an empty list.
            return typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => undefined : vi.fn().mockResolvedValue([]);
          },
        },
      ),
      models,
      conversation: {
        getHistory: vi.fn().mockResolvedValue({ currentSessionId: 'session-1', sessions: [{ id: 'session-1', startedAt: 1, title: null, messages: [] }] }),
        appendMessage,
        onSessionStarted: (listener: (session: ConversationSession) => void) => {
          sessionListener = listener;
          return () => undefined;
        },
        onMessageAppended: () => () => undefined,
      },
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    };

    render(<App />);
    await waitFor(() => expect(localClients.length).toBeGreaterThan(0));
    await waitFor(() => expect(avatarsList).toHaveBeenCalled());
    await waitFor(() => expect(listModels).toHaveBeenCalled());
    act(() => sessionListener?.({ id: 'session-2', startedAt: 2, title: null }));
    const callbacks = localClients.at(-1)?.callbacks as FakeCallbacks;

    await act(async () => {
      callbacks.onAssistantTranscript?.('Sage speaking.', 'sage');
      callbacks.onAssistantTranscript?.('Echo speaking.');
    });
    await waitFor(() => expect(appendMessage).toHaveBeenCalledTimes(2));
    const payloads = appendMessage.mock.calls.map(([payload]) => payload);
    expect(payloads[0]).toMatchObject({ role: 'assistant', content: 'Sage speaking.', speaker: 'sage' });
    expect(payloads[1]).toMatchObject({ role: 'assistant', content: 'Echo speaking.' });
    expect(payloads[1]).not.toHaveProperty('speaker');

    // A second avatar's audio output gets its own lip-sync driver without errors.
    await act(async () => {
      callbacks.onAvatarStream?.('sage', new MockMediaStream() as unknown as MediaStream);
    });
    expect(console.error).not.toHaveBeenCalledWith('Failed to attach viseme driver', 'sage', expect.anything());
  });
});
