import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalVoiceClient } from '../../src/realtime/local-voice-client.js';
import type { LocalVoiceBridge } from '../../src/preload-api.js';
import type { LocalVoiceEvent } from '../../../main/src/local-voice/types.js';

function createFakeContext() {
  const processor = { onaudioprocess: null as null | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void), connect: vi.fn(), disconnect: vi.fn() };
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } });
  const context = {
    sampleRate: 16000,
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

function createBridge(note: string | undefined, ready = false) {
  let events: ((event: LocalVoiceEvent) => void) | null = null;
  let systemReady: (() => void) | null = null;
  const bridge = {
    getStatus: vi.fn(async () => ({ llm: { available: true, baseUrl: 'http://llm' }, speech: { available: true, ready: true, error: null } })),
    transcribe: vi.fn(async () => ({ text: 'hi' })),
    respond: vi.fn(async (request: { requestId: string; system?: boolean }) => {
      if (request.system) events?.({ type: 'sentence', requestId: request.requestId, index: 0, text: 'Task one asks a question.', wav: new Uint8Array([1]) });
      return { requestId: request.requestId, text: note ? 'Task one asks a question.' : '', cancelled: !note, ...(note ? { note } : {}) };
    }),
    cancel: vi.fn(async () => undefined),
    resetHistory: vi.fn(async () => undefined),
    onEvent: vi.fn((next: (event: LocalVoiceEvent) => void) => {
      events = next;
      return () => undefined;
    }),
    systemStatus: vi.fn(async () => ({ pending: ready ? 1 : 0, ready, texts: [] })),
    onSystemReady: vi.fn((next: () => void) => {
      systemReady = next;
      return () => {
        systemReady = null;
      };
    }),
  };
  return { bridge: bridge as unknown as LocalVoiceBridge & typeof bridge, fire: () => systemReady?.() };
}

describe('system turns (updates from the coding agent)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a turn when main says an update is ready, without a user transcript', async () => {
    const { context } = createFakeContext();
    const { bridge, fire } = createBridge('[Update from the coding agent, not from Kevin] Task one asks: "Which port?"');
    const onUserTranscript = vi.fn();
    const onSystemNote = vi.fn();
    const onAssistantTranscript = vi.fn();
    const client = new LocalVoiceClient({ getBridge: () => bridge, createAudioContext: () => context, now: () => 10_000, callbacks: { onUserTranscript, onSystemNote, onAssistantTranscript } });
    await client.connect({ inputStream: {} as MediaStream });

    fire();
    await vi.advanceTimersByTimeAsync(1500);

    expect(bridge.respond).toHaveBeenCalledWith(expect.objectContaining({ text: '', system: true }));
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(onSystemNote).toHaveBeenCalledWith('[Update from the coding agent, not from Kevin] Task one asks: "Which port?"');
    expect(onAssistantTranscript).toHaveBeenCalledWith('Task one asks a question.');
    expect(client.getActivity().phase).toBe('listening');
  });

  it('picks up updates that were queued before the conversation started', async () => {
    const { context } = createFakeContext();
    const { bridge } = createBridge('[Update from the coding agent, not from Kevin] Done.', true);
    const client = new LocalVoiceClient({ getBridge: () => bridge, createAudioContext: () => context, now: () => 10_000 });
    await client.connect({ inputStream: {} as MediaStream });
    await vi.advanceTimersByTimeAsync(1500);
    expect(bridge.respond).toHaveBeenCalledWith(expect.objectContaining({ system: true }));
  });

  it('waits while the user is speaking', async () => {
    const { context, processor } = createFakeContext();
    const { bridge, fire } = createBridge('[Update from the coding agent, not from Kevin] Done.');
    const client = new LocalVoiceClient({ getBridge: () => bridge, createAudioContext: () => context, now: () => 10_000 });
    await client.connect({ inputStream: {} as MediaStream });
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.2) } });

    fire();
    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.respond).not.toHaveBeenCalled();
  });

  it('goes back to waiting when main had nothing to say yet', async () => {
    const { context } = createFakeContext();
    const { bridge, fire } = createBridge(undefined);
    const onSystemNote = vi.fn();
    const client = new LocalVoiceClient({ getBridge: () => bridge, createAudioContext: () => context, now: () => 10_000, callbacks: { onSystemNote } });
    await client.connect({ inputStream: {} as MediaStream });
    fire();
    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.respond).toHaveBeenCalledTimes(1);
    expect(onSystemNote).not.toHaveBeenCalled();
    expect(client.getActivity().phase).toBe('waiting');
  });
});
