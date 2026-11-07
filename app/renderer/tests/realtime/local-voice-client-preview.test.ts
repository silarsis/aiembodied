import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalVoiceClient, playPreviewReply } from '../../src/realtime/local-voice-client.js';
import type { LocalVoiceBridge } from '../../src/preload-api.js';
import type { LocalVoiceEvent } from '../../../main/src/local-voice/types.js';
import type { VoiceActivity } from '../../src/realtime/voice-activity.js';

const SAMPLE_RATE = 16000;

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

describe('Test Response voice preview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays the preview through the running conversation, outside its history', async () => {
    const { context } = createFakeContext();
    const bridge = createBridge();
    const spoken: string[] = [];
    const client = new LocalVoiceClient({
      getBridge: () => bridge,
      createAudioContext: () => context,
      now: () => 10_000,
      callbacks: { onTextContent: (text) => spoken.push(text) },
    });
    await client.connect({ inputStream: {} as MediaStream });

    const pending = client.preview('say something', 'Be Echo.');
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({ text: 'It is noon.', cancelled: false });
    expect(bridge.respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'say something', instructions: 'Be Echo.', preview: true }),
    );
    expect(context.createBufferSource).toHaveBeenCalledTimes(1);
    expect(spoken).toEqual(['It is noon.']);
    expect(client.getActivity().phase).toBe('waiting');
  });

  it('returns null when the conversation is not running', async () => {
    const bridge = createBridge();
    const client = new LocalVoiceClient({ getBridge: () => bridge });
    await expect(client.preview('say something')).resolves.toBeNull();
    expect(bridge.respond).not.toHaveBeenCalled();
  });

  it('plays the preview straight to the speakers without a conversation', async () => {
    const { context } = createFakeContext();
    const bridge = createBridge();

    const pending = playPreviewReply(bridge, { text: 'say something' }, { createAudioContext: () => context });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({ text: 'It is noon.', cancelled: false });
    expect(bridge.respond).toHaveBeenCalledWith(expect.objectContaining({ preview: true }));
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(context.createBufferSource).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalled();
  });
});
