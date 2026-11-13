import { describe, expect, it, vi } from 'vitest';
import { LocalVoiceClient } from '../../src/realtime/local-voice-client.js';
import type { LocalVoiceBridge } from '../../src/preload-api.js';
import type { LocalVoiceEvent } from '../../../main/src/local-voice/types.js';

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

describe('LocalVoiceClient typed text', () => {
  async function setup(bridge = createBridge()) {
    const { context } = createFakeContext();
    const client = new LocalVoiceClient({
      getBridge: () => bridge,
      wakePhrase: 'Hey Jarvis',
      createAudioContext: () => context,
    });
    return { client, bridge };
  }

  it('runs a turn from typed text without transcribing', async () => {
    const { client, bridge } = await setup();
    await client.connect({ inputStream: {} as MediaStream });
    expect(await client.sendText('  what time is it?  ')).toBe(true);
    expect(bridge.transcribe).not.toHaveBeenCalled();
    expect(bridge.respond).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(bridge.respond).mock.calls[0])).toContain('what time is it?');
  });

  it('does nothing when not connected or when the text is empty', async () => {
    const { client, bridge } = await setup();
    expect(await client.sendText('hello')).toBe(false);
    await client.connect({ inputStream: {} as MediaStream });
    expect(await client.sendText('   ')).toBe(false);
    expect(bridge.respond).not.toHaveBeenCalled();
  });
});
