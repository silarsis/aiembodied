import { describe, expect, it, vi } from 'vitest';
import { LocalVoiceClient } from '../../src/realtime/local-voice-client.js';
import { pcm16ToFloat, toPcm16, UtteranceDetector } from '../../src/realtime/utterance-detector.js';
import type { LocalVoiceBridge } from '../../src/preload-api.js';
import type { LocalVoiceEvent, LocalVoiceStatus } from '../../../main/src/voice/types.js';

const FRAME = 1600; // 100 ms at 16 kHz

function frame(level: number): Float32Array {
  return new Float32Array(FRAME).fill(level);
}

describe('UtteranceDetector', () => {
  it('emits an utterance after enough trailing silence, with pre-roll', () => {
    const onUtterance = vi.fn();
    const onSpeechStart = vi.fn();
    const detector = new UtteranceDetector({ onUtterance, onSpeechStart }, { endSilenceMs: 300, preRollMs: 200 });

    for (let i = 0; i < 5; i += 1) detector.push(frame(0));
    for (let i = 0; i < 4; i += 1) detector.push(frame(0.2));
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(detector.isSpeaking).toBe(true);
    for (let i = 0; i < 3; i += 1) detector.push(frame(0));

    expect(onUtterance).toHaveBeenCalledTimes(1);
    const [pcm, durationMs] = onUtterance.mock.calls[0] as [Uint8Array, number];
    // 2 pre-roll + 4 speech + 3 silence frames
    expect(durationMs).toBeCloseTo(900);
    expect(pcm.byteLength).toBe(9 * FRAME * 2);
    expect(detector.isSpeaking).toBe(false);
  });

  it('drops blips shorter than the minimum speech length', () => {
    const onUtterance = vi.fn();
    const detector = new UtteranceDetector({ onUtterance }, { endSilenceMs: 200, minSpeechMs: 250 });
    detector.push(frame(0.2));
    detector.push(frame(0));
    detector.push(frame(0));
    expect(onUtterance).not.toHaveBeenCalled();
  });

  it('cuts very long utterances', () => {
    const onUtterance = vi.fn();
    const detector = new UtteranceDetector({ onUtterance }, { maxUtteranceMs: 500 });
    for (let i = 0; i < 5; i += 1) detector.push(frame(0.2));
    expect(onUtterance).toHaveBeenCalledTimes(1);
  });

  it('round-trips PCM16', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const back = pcm16ToFloat(toPcm16([samples], samples.length));
    back.forEach((value, i) => expect(value).toBeCloseTo(samples[i], 3));
  });
});

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeProcessor extends FakeNode {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
  feed(samples: Float32Array) {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
  }
}

class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onended?.());
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly sampleRate: number;
  currentTime = 0;
  destination = new FakeNode();
  processor = new FakeProcessor();
  sources: FakeSource[] = [];
  close = vi.fn(async () => {});
  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate ?? 48000;
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamDestination() {
    return Object.assign(new FakeNode(), { stream: { id: 'tts-stream' } as unknown as MediaStream });
  }
  createMediaStreamSource() {
    return new FakeNode();
  }
  createScriptProcessor() {
    return this.processor;
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel: vi.fn() };
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

const READY: LocalVoiceStatus = {
  backend: 'local',
  llm: { available: true, model: 'qwen-next-flash', baseUrl: 'http://localhost:1234/v1' },
  speech: { available: true, ready: true, stt: 'small.en', tts: 'kokoro' },
};

function makeBridge(status: LocalVoiceStatus = READY) {
  let listener: ((event: LocalVoiceEvent) => void) | null = null;
  const bridge: LocalVoiceBridge = {
    getStatus: vi.fn(async () => status),
    runTurn: vi.fn(async (request) => {
      listener?.({ turnId: request.turnId, type: 'transcript', text: 'hello' });
      listener?.({ turnId: request.turnId, type: 'text', text: 'Hi! {move:waves}' });
      listener?.({ turnId: request.turnId, type: 'audio', index: 0, sampleRate: 24000, data: new Uint8Array(4800) });
      listener?.({ turnId: 'stale', type: 'text', text: 'ignored' });
      return { turnId: request.turnId, transcript: 'hello', text: 'Hi! {move:waves}', cancelled: false, timings: { totalMs: 5 } };
    }),
    cancelTurn: vi.fn(async () => true),
    resetConversation: vi.fn(async () => {}),
    onEvent: vi.fn((next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
  };
  return bridge;
}

function makeClient(bridge: LocalVoiceBridge, callbacks = {}) {
  FakeAudioContext.instances = [];
  return new LocalVoiceClient({
    getBridge: () => bridge,
    callbacks,
    detector: { endSilenceMs: 200 },
    createAudioContext: (options) => new FakeAudioContext(options) as unknown as AudioContext,
  });
}

describe('LocalVoiceClient', () => {
  it('turns an utterance into transcript, text and played audio', async () => {
    const bridge = makeBridge();
    const callbacks = {
      onStateChange: vi.fn(),
      onRemoteStream: vi.fn(),
      onTextContent: vi.fn(),
      onUserTranscript: vi.fn(),
      onAssistantReply: vi.fn(),
      onFirstAudioFrame: vi.fn(),
    };
    const client = makeClient(bridge, callbacks);
    client.updateSessionConfig({ instructions: 'Be brief.' });

    await client.connect({ inputStream: {} as MediaStream });
    expect(client.getState().status).toBe('connected');
    expect(callbacks.onRemoteStream).toHaveBeenCalledWith({ id: 'tts-stream' });
    const [playback, capture] = FakeAudioContext.instances;
    expect(capture.sampleRate).toBe(16000);

    for (let i = 0; i < 4; i += 1) capture.processor.feed(frame(0.2));
    for (let i = 0; i < 2; i += 1) capture.processor.feed(frame(0));
    await vi.waitFor(() => expect(callbacks.onAssistantReply).toHaveBeenCalledWith('Hi! {move:waves}'));

    expect(bridge.runTurn).toHaveBeenCalledWith(expect.objectContaining({ instructions: 'Be brief.' }));
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith('hello');
    expect(callbacks.onTextContent).toHaveBeenCalledTimes(1);
    expect(callbacks.onFirstAudioFrame).toHaveBeenCalledTimes(1);
    expect(playback.sources).toHaveLength(1);
    expect(playback.sources[0].start).toHaveBeenCalled();
  });

  it('ignores the microphone while the reply plays, and stops it on interrupt', async () => {
    const bridge = makeBridge();
    const client = makeClient(bridge);
    await client.connect({ inputStream: {} as MediaStream });
    const [playback, capture] = FakeAudioContext.instances;
    for (let i = 0; i < 4; i += 1) capture.processor.feed(frame(0.2));
    for (let i = 0; i < 2; i += 1) capture.processor.feed(frame(0));
    await vi.waitFor(() => expect(playback.sources).toHaveLength(1));

    for (let i = 0; i < 6; i += 1) capture.processor.feed(i < 4 ? frame(0.2) : frame(0));
    expect(bridge.runTurn).toHaveBeenCalledTimes(1);

    client.interrupt();
    expect(playback.sources[0].stop).toHaveBeenCalled();
  });

  it('fails to connect with a clear message when the LLM is down', async () => {
    const bridge = makeBridge({ ...READY, llm: { ...READY.llm, available: false } });
    const onStateChange = vi.fn();
    const client = makeClient(bridge, { onStateChange });
    await expect(client.connect({ inputStream: {} as MediaStream })).rejects.toThrow(/llama-server/);
    expect(client.getState()).toMatchObject({ status: 'error' });
  });

  it('fails to connect while the voice service is loading', async () => {
    const bridge = makeBridge({ ...READY, speech: { ...READY.speech, ready: false } });
    const client = makeClient(bridge);
    await expect(client.connect({ inputStream: {} as MediaStream })).rejects.toThrow(/still loading/);
  });

  it('closes its audio contexts on disconnect', async () => {
    const client = makeClient(makeBridge());
    await client.connect({ inputStream: {} as MediaStream });
    await client.disconnect();
    expect(FakeAudioContext.instances.every((context) => context.close.mock.calls.length === 1)).toBe(true);
    expect(client.getState().status).toBe('idle');
  });
});
