import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalVoiceClient } from '../../src/realtime/local-voice-client.js';
import type { LocalVoiceBridge } from '../../src/preload-api.js';
import type { LocalVoiceEvent } from '../../../main/src/local-voice/types.js';
import type { VoiceActivity } from '../../src/realtime/voice-activity.js';

const SAMPLE_RATE = 16000;
const FRAME = 2048;
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;

interface FakeProcessor {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
  connect: () => void;
  disconnect: () => void;
}

function createFakeContext() {
  const processor: FakeProcessor = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } });
  const context = {
    sampleRate: SAMPLE_RATE,
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createMediaStreamSource: vi.fn(node),
    createScriptProcessor: vi.fn(() => processor),
    createGain: vi.fn(node),
    createMediaStreamDestination: vi.fn(() => ({ ...node(), stream: {} as MediaStream })),
    decodeAudioData: vi.fn(async () => ({ duration: 0.01 })),
    createBufferSource: vi.fn(() => ({ ...node(), buffer: null, start: vi.fn(), stop: vi.fn(), onended: null })),
  };
  return { context: context as unknown as AudioContext, processor };
}

function createBridge(overrides: Partial<LocalVoiceBridge> = {}) {
  let listener: ((event: LocalVoiceEvent) => void) | null = null;
  const bridge: LocalVoiceBridge = {
    getStatus: vi.fn(async () => ({
      llm: { available: true, baseUrl: 'http://llm' },
      speech: { available: true, ready: true, error: null },
    })) as unknown as LocalVoiceBridge['getStatus'],
    transcribe: vi.fn(async () => ({ text: 'Hey Jarvis, what time is it?' })) as unknown as LocalVoiceBridge['transcribe'],
    respond: vi.fn(async (request: { requestId: string }) => {
      listener?.({ type: 'sentence', requestId: request.requestId, text: 'It is noon.', wav: new Uint8Array([1]) } as LocalVoiceEvent);
      return { text: 'It is noon.', cancelled: false };
    }) as unknown as LocalVoiceBridge['respond'],
    cancel: vi.fn(async () => undefined),
    resetHistory: vi.fn(async () => undefined),
    onEvent: vi.fn((next: (event: LocalVoiceEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    ...overrides,
  };
  return bridge;
}

describe('LocalVoiceClient talk (push-to-talk and tap)', () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 10_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(bridge = createBridge(), { connect = true } = {}) {
    const { context, processor } = createFakeContext();
    const activity: VoiceActivity[] = [];
    const client = new LocalVoiceClient({
      getBridge: () => bridge,
      wakePhrase: 'Hey Jarvis',
      createAudioContext: () => context,
      now: () => now,
      callbacks: { onActivity: (next) => activity.push(next) },
    });
    if (connect) {
      await client.connect({ inputStream: {} as MediaStream });
    }
    const speak = (frames: number, loud: boolean) => {
      for (let i = 0; i < frames; i += 1) {
        now += FRAME_MS;
        const samples = new Float32Array(FRAME).fill(loud ? 0.2 : 0);
        processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
      }
    };
    const phases = () => activity.map((entry) => entry.phase);
    return { client, bridge, speak, activity, phases };
  }

  it('answers speech without the wake word after talk()', async () => {
    const { client, bridge, speak, phases } = await setup();
    client.talk();
    expect(client.getActivity()).toMatchObject({ phase: 'listening', detail: 'Listening: no wake word needed' });

    speak(8, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(2000);

    expect(bridge.transcribe).toHaveBeenCalledTimes(1);
    expect(bridge.respond).toHaveBeenCalledWith(expect.objectContaining({ text: 'what time is it?' }));
    expect(phases()).toEqual(['waiting', 'listening', 'transcribing', 'thinking', 'responding', 'listening']);
  });

  it('goes back to waiting for the wake word if nothing is said', async () => {
    const { client, bridge } = await setup();
    client.talk();
    await vi.advanceTimersByTimeAsync(9000);

    expect(client.getActivity().phase).toBe('waiting');
    expect(bridge.transcribe).not.toHaveBeenCalled();
  });

  it('sends the speech so far on a second press, without waiting for a pause', async () => {
    const { client, bridge, speak } = await setup();
    client.talk();
    speak(8, true);
    expect(bridge.transcribe).not.toHaveBeenCalled();

    client.talk();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.transcribe).toHaveBeenCalledTimes(1);
    const wav = vi.mocked(bridge.transcribe).mock.calls[0]?.[0] as ArrayBuffer;
    expect(wav.byteLength).toBe(44 + 8 * FRAME * 2);
  });

  it('stops a reply in progress and listens', async () => {
    let finishReply: (() => void) | null = null;
    const bridge = createBridge({
      respond: vi.fn(
        () =>
          new Promise((resolve) => {
            finishReply = () => resolve({ text: '', cancelled: true });
          }),
      ) as unknown as LocalVoiceBridge['respond'],
      cancel: vi.fn(async () => {
        finishReply?.();
      }),
    });
    const { client, speak } = await setup(bridge);
    client.talk();
    speak(8, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getActivity().phase).toBe('thinking');

    client.talk();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(client.getActivity()).toMatchObject({ phase: 'listening', detail: 'Follow-up: no wake word needed' });
  });

  it('listens as soon as it connects when talk() came first', async () => {
    const { client, phases } = await setup(createBridge(), { connect: false });
    client.talk();
    await client.connect({ inputStream: {} as MediaStream });
    expect(phases()).toEqual(['listening']);
  });
});
