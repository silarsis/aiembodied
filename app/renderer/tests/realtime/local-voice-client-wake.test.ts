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

describe('LocalVoiceClient wake word', () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 10_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(transcript = 'What time is it?') {
    const sizes: number[] = [];
    const bridge = createBridge({
      transcribe: vi.fn(async (wav: ArrayBuffer) => {
        sizes.push(wav.byteLength);
        return { text: transcript };
      }) as unknown as LocalVoiceBridge['transcribe'],
    });
    const { context, processor } = createFakeContext();
    const activity: VoiceActivity[] = [];
    const client = new LocalVoiceClient({
      getBridge: () => bridge,
      wakePhrase: 'Hey Jarvis',
      createAudioContext: () => context,
      now: () => now,
      callbacks: { onActivity: (next) => activity.push(next) },
    });
    await client.connect({ inputStream: {} as MediaStream });
    const speak = (frames: number, loud: boolean) => {
      for (let i = 0; i < frames; i += 1) {
        now += FRAME_MS;
        const samples = new Float32Array(FRAME).fill(loud ? 0.2 : 0);
        processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
      }
    };
    return { client, bridge, speak, sizes, activity };
  }

  // An utterance ends after 6 quiet frames (768 ms of the 700 ms silence), so it holds speech + 6.
  const wavBytes = (samples: number) => 44 + samples * 2;

  it('cuts an utterance at the wake word, dropping what was said before it', async () => {
    const { client, speak, sizes } = await setup();
    const startAt = now;
    speak(8, true);
    const wakeAt = now;
    client.notifyWake(wakeAt);
    speak(8, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(2000);

    const kept = 22 * FRAME - Math.round(((wakeAt - 250 - startAt) / 1000) * SAMPLE_RATE);
    expect(sizes).toEqual([wavBytes(kept)]);
  });

  it('drops an utterance that ended with the wake word and waits for the request', async () => {
    const { client, bridge, speak, activity } = await setup();
    speak(8, true);
    speak(8, false);
    // The detection arrives just after the utterance ended.
    client.notifyWake(now + 100);
    await vi.advanceTimersByTimeAsync(1000);

    expect(bridge.transcribe).not.toHaveBeenCalled();
    expect(activity.at(-1)).toMatchObject({ phase: 'listening', detail: 'Wake word heard: say your request' });
  });

  it('ignores speech that ended before the wake word, then answers what follows it', async () => {
    const { client, bridge, speak, sizes } = await setup();
    speak(8, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(bridge.transcribe).not.toHaveBeenCalled();

    client.notifyWake(now);
    speak(4, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sizes).toEqual([wavBytes(10 * FRAME)]);
  });

  it('keeps a whole follow-up utterance after a reply', async () => {
    const { client, speak, sizes } = await setup();
    client.notifyWake(now);
    speak(4, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(2000);

    speak(6, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sizes).toEqual([wavBytes(10 * FRAME), wavBytes(12 * FRAME)]);
  });

  it('strips everything up to the wake phrase from the transcript', async () => {
    const { client, bridge, speak } = await setup('Turn it off. Hey Jarvis, what time is it?');
    client.notifyWake(now);
    speak(4, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(2000);

    expect(bridge.respond).toHaveBeenCalledWith(expect.objectContaining({ text: 'what time is it?' }));
  });
});
