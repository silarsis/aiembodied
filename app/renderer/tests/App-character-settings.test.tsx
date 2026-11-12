import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS } from '../../main/src/config/provider-settings.js';
import { builtInServers, defaultRoutes } from '../../main/src/config/model-routing.js';
import type { AvatarModelSummary } from '../src/avatar/types.js';

vi.mock('../src/realtime/local-voice-client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/realtime/local-voice-client.js')>('../src/realtime/local-voice-client.js');
  class FakeLocalVoiceClient {
    constructor() {
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

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalDialogClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
});
afterAll(() => {
  for (const [name, descriptor] of [['showModal', originalShowModal], ['close', originalDialogClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

const voiceOptions = (selected: string | null, engine: string | null = 'kokoro') => ({
  engine,
  label: engine === 'kokoro' ? 'Kokoro' : 'Nothing speaks',
  voices: engine ? ['af_heart', 'am_adam'] : [],
  defaultVoice: engine ? 'af_heart' : null,
  selected,
});

describe('Characters pop-up: each card holds its character\'s settings', () => {
  const originalAudioContext = window.AudioContext;
  const originalMediaDevices = navigator.mediaDevices;
  const originalConsole = { error: console.error, warn: console.warn, info: console.info, debug: console.debug };

  beforeEach(() => {
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

  function boot(getVoiceOptions: (avatarId?: string) => Promise<ReturnType<typeof voiceOptions>>) {
    const profiles = [
      { id: 'echo', name: 'Echo', vrmModelId: 'm1' },
      { id: 'sage', name: 'Sage', vrmModelId: null, prompt: 'Be calm.' },
      { id: 'luna', name: 'Luna', vrmModelId: 'm2', prompt: 'Fallback for Luna.' },
    ];
    const avatars = {
      list: vi.fn(async () => profiles),
      add: vi.fn(),
      update: vi.fn(async (id: string, changes: object) => ({ ...profiles.find((p) => p.id === id), ...changes })),
      remove: vi.fn(),
      idlePersonas: vi.fn(async () => ({ sage: { personality: 'Be calm.', habits: '' }, luna: { personality: 'Luna', habits: '' } })),
    };
    const prompts: Record<string, string | null> = { undefined: 'Echo prompt', luna: null };
    const habits: Record<string, string> = { undefined: 'Echo reads.', sage: 'Sage hums.', luna: 'Luna paints.' };
    const avatar = {
      listModels: vi.fn().mockResolvedValue([model('m1'), model('m2')]),
      getActiveModel: vi.fn().mockResolvedValue(model('m1')),
      loadModelBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      getPromptPreference: vi.fn(async (avatarId?: string) => prompts[String(avatarId)] ?? null),
      setPromptPreference: vi.fn(async () => undefined),
      getIdleHabits: vi.fn(async (avatarId?: string) => habits[String(avatarId)] ?? ''),
      setIdleHabits: vi.fn(async () => undefined),
      getVoicePreference: vi.fn(async () => null),
      setVoicePreference: vi.fn(async () => undefined),
    };
    const config = {
      audioInputDeviceId: '',
      audioOutputDeviceId: '',
      featureFlags: {},
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
      avatars,
      avatar: new Proxy(avatar, {
        get: (target, key) => {
          if (key in target) return (target as Record<string | symbol, unknown>)[key];
          return typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => undefined : vi.fn().mockResolvedValue([]);
        },
      }),
      localVoice: { getVoiceOptions, getStatus: vi.fn().mockRejectedValue(new Error('offline')) },
      models: {
        get: vi.fn(async () => ({
          servers: builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }).map((server) => ({ ...server, hasKey: false })),
          routes: defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
        })),
        probe: vi.fn(async () => ({ status: 'up', models: {}, checkedAt: 0 })),
      },
      conversation: {
        getHistory: vi.fn().mockResolvedValue({ currentSessionId: 's1', sessions: [{ id: 's1', startedAt: 1, title: null, messages: [] }] }),
        appendMessage: vi.fn(),
        onSessionStarted: () => () => undefined,
        onMessageAppended: () => () => undefined,
      },
      __bridgeReady: true,
      __bridgeVersion: '1.0.0',
    };
    return { avatars, avatar };
  }

  async function openCard(name: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Controls' }));
    const drawer = await screen.findByRole('complementary', { name: 'Controls' });
    fireEvent.click(await within(drawer).findByRole('button', { name: /Characters/i }));
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${name}` }));
  }

  it('Echo\'s card edits the active character\'s prompt, idle habits and voice, as the old sections did', async () => {
    const getVoiceOptions = vi.fn(async (avatarId?: string) => voiceOptions(avatarId ? 'am_adam' : 'af_heart'));
    const { avatar } = boot(getVoiceOptions);
    render(<App />);
    await openCard('Echo');

    const prompt = (await screen.findByLabelText('Prompt of Echo')) as HTMLTextAreaElement;
    await waitFor(() => expect(prompt.value).toBe('Echo prompt'));
    fireEvent.change(prompt, { target: { value: 'Echo is bold.' } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(avatar.setPromptPreference).toHaveBeenCalledWith('Echo is bold.'));

    const habits = screen.getByLabelText('Idle habits of Echo') as HTMLTextAreaElement;
    await waitFor(() => expect(habits.value).toBe('Echo reads.'));
    fireEvent.change(habits, { target: { value: 'Echo walks.' } });
    fireEvent.blur(habits);
    await waitFor(() => expect(avatar.setIdleHabits).toHaveBeenCalledWith('Echo walks.'));

    const voice = screen.getByLabelText('Voice of Echo') as HTMLSelectElement;
    await waitFor(() => expect(voice.value).toBe('af_heart'));
    fireEvent.change(voice, { target: { value: 'am_adam' } });
    await waitFor(() => expect(avatar.setVoicePreference).toHaveBeenCalledWith('am_adam', 'kokoro'));
    expect(getVoiceOptions).toHaveBeenCalledWith();
    // The old Personality and Voice sections are gone from the lower part of the pop-up.
    expect(screen.queryByLabelText(/^Base prompt/)).toBeNull();
    expect(document.getElementById('character-voice')).toBeNull();
  });

  it('a character sharing Echo\'s body keeps its own prompt (in its profile), idle habits and voice', async () => {
    const getVoiceOptions = vi.fn(async (avatarId?: string) => voiceOptions(avatarId ? 'am_adam' : 'af_heart'));
    const { avatar, avatars } = boot(getVoiceOptions);
    render(<App />);
    await openCard('Sage');

    const prompt = (await screen.findByLabelText('Prompt of Sage')) as HTMLTextAreaElement;
    expect(prompt.value).toBe('Be calm.');
    fireEvent.change(prompt, { target: { value: 'Be gentle.' } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(avatars.update).toHaveBeenCalledWith('sage', { prompt: 'Be gentle.' }));
    expect(avatar.setPromptPreference).not.toHaveBeenCalled();

    const habits = screen.getByLabelText('Idle habits of Sage') as HTMLTextAreaElement;
    await waitFor(() => expect(habits.value).toBe('Sage hums.'));
    expect(avatar.getIdleHabits).toHaveBeenCalledWith('sage');
    const callsBefore = avatars.idlePersonas.mock.calls.length;
    fireEvent.change(habits, { target: { value: 'Sage naps.' } });
    fireEvent.blur(habits);
    await waitFor(() => expect(avatar.setIdleHabits).toHaveBeenCalledWith('Sage naps.', 'sage'));
    // The idle director is told the new habits right away.
    await waitFor(() => expect(avatars.idlePersonas.mock.calls.length).toBeGreaterThan(callsBefore));

    const voice = screen.getByLabelText('Voice of Sage') as HTMLSelectElement;
    await waitFor(() => expect(voice.value).toBe('am_adam'));
    expect(getVoiceOptions).toHaveBeenCalledWith('sage');
    fireEvent.change(voice, { target: { value: 'af_heart' } });
    await waitFor(() => expect(avatar.setVoicePreference).toHaveBeenCalledWith('af_heart', 'kokoro', 'sage'));
  });

  it('a character with a body of its own saves its prompt under its avatar id and starts from the profile prompt', async () => {
    const { avatar, avatars } = boot(vi.fn(async () => voiceOptions(null)));
    render(<App />);
    await openCard('Luna');

    const prompt = (await screen.findByLabelText('Prompt of Luna')) as HTMLTextAreaElement;
    await waitFor(() => expect(prompt.value).toBe('Fallback for Luna.'));
    expect(avatar.getPromptPreference).toHaveBeenCalledWith('luna');
    fireEvent.change(prompt, { target: { value: 'Luna is shy.' } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(avatar.setPromptPreference).toHaveBeenCalledWith('Luna is shy.', 'luna'));
    expect(avatars.update).not.toHaveBeenCalled();
  });

  it('says so when nothing is set to speak', async () => {
    boot(vi.fn(async () => voiceOptions(null, null)));
    render(<App />);
    await openCard('Sage');
    const voice = (await screen.findByLabelText('Voice of Sage')) as HTMLSelectElement;
    await waitFor(() => expect(screen.getAllByText(/Nothing is set to speak/).length).toBeGreaterThan(0));
    expect(voice).toBeDisabled();
  });
});
