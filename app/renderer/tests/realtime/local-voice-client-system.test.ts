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

function createBridge(note: string | undefined, ready = false, urgent = false) {
  let events: ((event: LocalVoiceEvent) => void) | null = null;
  let systemReady: ((info?: { urgent: boolean }) => void) | null = null;
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
    systemStatus: vi.fn(async () => ({ pending: ready ? 1 : 0, ready, texts: [], urgent })),
    onSystemReady: vi.fn((next: (info?: { urgent: boolean }) => void) => {
      systemReady = next;
      return () => {
        systemReady = null;
      };
    }),
  };
  return { bridge: bridge as unknown as LocalVoiceBridge & typeof bridge, fire: (info?: { urgent: boolean }) => systemReady?.(info) };
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

  describe('announcements while no conversation is running', () => {
    const NOTE = '[Update from the coding agent, not from Kevin] Task one asks: "Which port?"';

    it('announces an urgent update when idle, output only', async () => {
      const { context, processor } = createFakeContext();
      const { bridge, fire } = createBridge(NOTE);
      const getUserMedia = vi.fn();
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
      const onRemoteStream = vi.fn();
      const onAnnouncement = vi.fn();
      const onSystemNote = vi.fn();
      const onAssistantTranscript = vi.fn();
      const client = new LocalVoiceClient({
        getBridge: () => bridge,
        createAudioContext: () => context,
        now: () => 10_000,
        callbacks: { onRemoteStream, onAnnouncement, onSystemNote, onAssistantTranscript },
      });
      client.watchUpdates();
      fire({ urgent: true });
      await vi.advanceTimersByTimeAsync(1500);

      expect(bridge.respond).toHaveBeenCalledWith(expect.objectContaining({ text: '', system: true }));
      expect(onRemoteStream).toHaveBeenCalledTimes(1);
      expect(onAnnouncement).toHaveBeenCalledWith({ note: NOTE, reply: 'Task one asks a question.' });
      expect(onSystemNote).not.toHaveBeenCalled();
      expect(onAssistantTranscript).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(context.createMediaStreamSource).not.toHaveBeenCalled();
      expect(context.createScriptProcessor).not.toHaveBeenCalled();
      expect(processor.onaudioprocess).toBeNull();
      expect(context.close).toHaveBeenCalledTimes(1);
      expect(client.getActivity().phase).toBe('off');
      expect(client.getState().status).toBe('idle');
      expect(client.getRemoteStream()).toBeNull();
      vi.unstubAllGlobals();
    });

    it('ignores non-urgent updates and a missing flag while idle', async () => {
      const { context } = createFakeContext();
      const { bridge, fire } = createBridge(NOTE);
      const client = new LocalVoiceClient({ getBridge: () => bridge, createAudioContext: () => context, now: () => 10_000 });
      client.watchUpdates();
      fire({ urgent: false });
      fire();
      await vi.advanceTimersByTimeAsync(1500);
      expect(bridge.respond).not.toHaveBeenCalled();
    });

    it('announces urgent updates that were queued before the window loaded', async () => {
      const { context } = createFakeContext();
      const { bridge } = createBridge(NOTE, true, true);
      const onAnnouncement = vi.fn();
      const client = new LocalVoiceClient({ getBridge: () => bridge, createAudioContext: () => context, now: () => 10_000, callbacks: { onAnnouncement } });
      client.watchUpdates();
      await vi.advanceTimersByTimeAsync(1500);
      expect(onAnnouncement).toHaveBeenCalledTimes(1);
    });

    it('does not announce non-urgent updates queued before load, and stops after unwatch', async () => {
      const { context } = createFakeContext();
      const { bridge, fire } = createBridge(NOTE, true, false);
      const client = new LocalVoiceClient({ getBridge: () => bridge, createAudioContext: () => context, now: () => 10_000 });
      client.watchUpdates();
      await vi.advanceTimersByTimeAsync(500);
      expect(bridge.respond).not.toHaveBeenCalled();
      client.unwatchUpdates();
      fire({ urgent: true });
      await vi.advanceTimersByTimeAsync(500);
      expect(bridge.respond).not.toHaveBeenCalled();
    });

    it('still runs a normal system turn when connected', async () => {
      const { context } = createFakeContext();
      const { bridge, fire } = createBridge(NOTE);
      const onSystemNote = vi.fn();
      const onAnnouncement = vi.fn();
      const client = new LocalVoiceClient({ getBridge: () => bridge, createAudioContext: () => context, now: () => 10_000, callbacks: { onSystemNote, onAnnouncement } });
      client.watchUpdates();
      await client.connect({ inputStream: {} as MediaStream });
      fire({ urgent: false });
      await vi.advanceTimersByTimeAsync(1500);
      expect(onSystemNote).toHaveBeenCalledWith(NOTE);
      expect(onAnnouncement).not.toHaveBeenCalled();
      expect(client.getActivity().phase).toBe('listening');
    });

    it('does not close the new connection when connect() happens during an announcement', async () => {
      const announceCtx = createFakeContext();
      const connectCtx = createFakeContext();
      const contexts = [announceCtx.context, connectCtx.context];
      const { bridge, fire } = createBridge(NOTE);
      let release: () => void = () => undefined;
      bridge.respond.mockImplementationOnce(
        (request: { requestId: string }) =>
          new Promise((resolve) => {
            release = () => resolve({ requestId: request.requestId, text: 'late', cancelled: false, note: NOTE });
          }),
      );
      const onAnnouncement = vi.fn();
      const client = new LocalVoiceClient({ getBridge: () => bridge, createAudioContext: () => contexts.shift() as AudioContext, now: () => 10_000, callbacks: { onAnnouncement } });
      client.watchUpdates();
      fire({ urgent: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(bridge.respond).toHaveBeenCalledTimes(1);

      await client.connect({ inputStream: {} as MediaStream });
      release();
      await vi.advanceTimersByTimeAsync(1500);

      expect(connectCtx.context.close).not.toHaveBeenCalled();
      expect(client.getState().status).toBe('connected');
      expect(onAnnouncement).not.toHaveBeenCalled();
    });
  });
});
