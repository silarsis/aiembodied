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

describe('LocalVoiceClient activity', () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 10_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(bridge = createBridge()) {
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
    const phases = () => activity.map((entry) => entry.phase);
    return { client, speak, activity, phases };
  }

  it('waits for the wake word once the services are ready', async () => {
    const { client, phases } = await setup();
    expect(phases()).toEqual(['waiting']);
    expect(client.getActivity().phase).toBe('waiting');
  });

  it('notes speech ignored without the wake word', async () => {
    const { speak, activity } = await setup();
    speak(8, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(1000);

    expect(activity.at(-1)?.phase).toBe('waiting');
    expect(activity.at(-1)?.detail).toMatch(/Ignored .* without the wake word/);
  });

  it('goes listening → transcribing → thinking → responding → listening, then back to waiting', async () => {
    const { client, speak, phases } = await setup();
    client.notifyWake(now);
    speak(8, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(2000);

    expect(phases()).toEqual(['waiting', 'listening', 'transcribing', 'thinking', 'responding', 'listening']);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(phases().at(-1)).toBe('waiting');
  });

  it('shows a failed turn as an error with the reason', async () => {
    const bridge = createBridge({
      transcribe: vi.fn(async () => {
        throw new Error('connection refused');
      }) as unknown as LocalVoiceBridge['transcribe'],
    });
    const { client, speak, activity } = await setup(bridge);
    client.notifyWake(now);
    speak(8, true);
    speak(8, false);
    await vi.advanceTimersByTimeAsync(1000);

    expect(activity.at(-1)).toMatchObject({ phase: 'error', detail: 'Turn failed: connection refused' });
  });

  it('passes tool calls made during a reply to onToolCall', async () => {
    const toolEvent = { requestId: '', type: 'tool', callId: 'c1', name: 'web_search', label: 'noon', status: 'started' };
    const bridge = createBridge();
    let listener: ((event: LocalVoiceEvent) => void) | undefined;
    bridge.onEvent = vi.fn((next: (event: LocalVoiceEvent) => void) => {
      listener = next;
      return () => undefined;
    });
    bridge.respond = vi.fn(async (request: { requestId: string }) => {
      listener?.({ ...toolEvent, requestId: request.requestId } as LocalVoiceEvent);
      listener?.({ ...toolEvent, requestId: 'another-turn' } as LocalVoiceEvent);
      return { text: '', cancelled: false };
    }) as unknown as LocalVoiceBridge['respond'];

    const { context, processor } = createFakeContext();
    const calls: unknown[] = [];
    const client = new LocalVoiceClient({
      getBridge: () => bridge,
      createAudioContext: () => context,
      now: () => now,
      callbacks: { onToolCall: (call) => calls.push(call) },
    });
    await client.connect({ inputStream: {} as MediaStream });
    client.notifyWake(now);
    for (const loud of [true, false]) {
      for (let i = 0; i < 8; i += 1) {
        now += FRAME_MS;
        const samples = new Float32Array(FRAME).fill(loud ? 0.2 : 0);
        processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
      }
    }
    await vi.advanceTimersByTimeAsync(2000);

    expect(calls).toEqual([expect.objectContaining({ type: 'tool', name: 'web_search', label: 'noon', status: 'started' })]);
  });

  it('is off after disconnecting', async () => {
    const { client, phases } = await setup();
    await client.disconnect();
    expect(phases().at(-1)).toBe('off');
  });
});
