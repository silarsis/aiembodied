import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalVoiceClient } from '../../src/realtime/local-voice-client.js';
import type { LocalVoiceBridge } from '../../src/preload-api.js';
import type { LocalVoiceEvent } from '../../../main/src/local-voice/types.js';
import type { VoiceActivity } from '../../src/realtime/voice-activity.js';

const SAMPLE_RATE = 16000;
const FRAME = 2048;
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;

interface FakeNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  stream: MediaStream;
}

function createFakeContext() {
  const processor = { onaudioprocess: null as null | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void), connect: vi.fn(), disconnect: vi.fn() };
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } });
  const destinations: FakeNode[] = [];
  const sources: Array<{ connect: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const context = {
    sampleRate: SAMPLE_RATE,
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createMediaStreamSource: vi.fn(node),
    createScriptProcessor: vi.fn(() => processor),
    createGain: vi.fn(node),
    createMediaStreamDestination: vi.fn(() => {
      const created = { ...node(), stream: { id: `stream-${destinations.length}` } as unknown as MediaStream };
      destinations.push(created);
      return created;
    }),
    decodeAudioData: vi.fn(async () => ({ duration: 0.01 })),
    createBufferSource: vi.fn(() => {
      const source = { ...node(), buffer: null, start: vi.fn(), stop: vi.fn(), onended: null };
      sources.push(source);
      return source;
    }),
  };
  return { context: context as unknown as AudioContext, processor, destinations, sources };
}

function createBridge(respond: (request: { requestId: string }, emit: (event: LocalVoiceEvent) => void) => Promise<unknown>) {
  let listener: ((event: LocalVoiceEvent) => void) | null = null;
  const emit = (event: LocalVoiceEvent) => listener?.(event);
  const bridge: LocalVoiceBridge = {
    getStatus: vi.fn(async () => ({
      llm: { available: true, baseUrl: 'http://llm' },
      speech: { available: true, ready: true, error: null },
    })) as unknown as LocalVoiceBridge['getStatus'],
    transcribe: vi.fn(async () => ({ text: 'Hey Jarvis, what time is it?' })) as unknown as LocalVoiceBridge['transcribe'],
    respond: vi.fn((request: { requestId: string }) => respond(request, emit)) as unknown as LocalVoiceBridge['respond'],
    cancel: vi.fn(async () => undefined),
    resetHistory: vi.fn(async () => undefined),
    onEvent: vi.fn((next: (event: LocalVoiceEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
  };
  return { bridge, emit };
}

const sentence = (requestId: string, avatarId: string | undefined, text = 'Hello.'): LocalVoiceEvent =>
  ({ type: 'sentence', requestId, index: 0, text, wav: new Uint8Array([1]), ...(avatarId ? { avatarId } : {}) }) as LocalVoiceEvent;

describe('LocalVoiceClient with several avatars', () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 10_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(respond: Parameters<typeof createBridge>[0], extra: { interruptFloor?: () => Promise<void> } = {}) {
    const { bridge, emit } = createBridge(respond);
    let systemListener: ((info?: { urgent: boolean; avatarId?: string }) => void) | null = null;
    bridge.onSystemReady = (next) => {
      systemListener = next;
      return () => undefined;
    };
    const fake = createFakeContext();
    const activity: VoiceActivity[] = [];
    const callbacks = {
      onRemoteStream: vi.fn(),
      onAvatarStream: vi.fn(),
      onTextContent: vi.fn(),
      onFirstAudioFrame: vi.fn(),
      onAssistantTranscript: vi.fn(),
      onActivity: (next: VoiceActivity) => activity.push(next),
    };
    const client = new LocalVoiceClient({
      getBridge: () => bridge,
      wakePhrase: 'Hey Jarvis',
      createAudioContext: () => fake.context,
      now: () => now,
      callbacks,
      ...extra,
    });
    await client.connect({ inputStream: {} as MediaStream });
    const ask = async () => {
      client.talk();
      for (let i = 0; i < 8; i += 1) {
        now += FRAME_MS;
        fake.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(FRAME).fill(0.2) } });
      }
      for (let i = 0; i < 8; i += 1) {
        now += FRAME_MS;
        fake.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(FRAME) } });
      }
      await vi.advanceTimersByTimeAsync(2000);
    };
    const emitSystemReady = (info: { urgent: boolean; avatarId?: string }) => systemListener?.(info);
    return { client, bridge, emit, fake, callbacks, activity, ask, emitSystemReady };
  }

  it('keeps the echo path as it was: one output, the same stream, callbacks without an avatar id', async () => {
    const { client, fake, callbacks, ask } = await setup(async (request, emit) => {
      emit(sentence(request.requestId, 'echo', 'It is noon.'));
      return { text: 'It is noon.', cancelled: false, avatarId: 'echo' };
    });
    await ask();

    expect(fake.destinations).toHaveLength(1);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(1);
    expect(callbacks.onRemoteStream).toHaveBeenCalledWith(fake.destinations[0]?.stream);
    expect(client.getRemoteStream()).toBe(fake.destinations[0]?.stream);
    expect(callbacks.onAvatarStream).not.toHaveBeenCalled();
    expect(fake.sources.length).toBeGreaterThan(0);
    expect(fake.sources[0]?.connect).toHaveBeenCalledWith(fake.destinations[0]);
    expect(callbacks.onTextContent).toHaveBeenCalledWith('It is noon.');
    expect(callbacks.onFirstAudioFrame).toHaveBeenCalledWith();
    expect(callbacks.onAssistantTranscript).toHaveBeenCalledWith('It is noon.');
  });

  it('treats events and results without an avatar id as echo', async () => {
    const { fake, callbacks, ask } = await setup(async (request, emit) => {
      emit(sentence(request.requestId, undefined, 'Hi.'));
      return { text: 'Hi.', cancelled: false };
    });
    await ask();
    expect(fake.destinations).toHaveLength(1);
    expect(fake.sources[0]?.connect).toHaveBeenCalledWith(fake.destinations[0]);
    expect(callbacks.onAssistantTranscript).toHaveBeenCalledWith('Hi.');
  });

  it('plays a turn on the output of the avatar the event names, creating it lazily', async () => {
    const { client, fake, callbacks, ask } = await setup(async (request, emit) => {
      emit(sentence(request.requestId, 'sage', 'Sage here.'));
      return { text: 'Sage here.', cancelled: false, avatarId: 'sage' };
    });
    expect(fake.destinations).toHaveLength(1);
    await ask();

    expect(fake.destinations).toHaveLength(2);
    const sage = fake.destinations[1] as FakeNode;
    expect(callbacks.onAvatarStream).toHaveBeenCalledTimes(1);
    expect(callbacks.onAvatarStream).toHaveBeenCalledWith('sage', sage.stream);
    expect(callbacks.onRemoteStream).toHaveBeenCalledTimes(1);
    expect(fake.sources[0]?.connect).toHaveBeenCalledWith(sage);
    expect(fake.sources[0]?.connect).not.toHaveBeenCalledWith(fake.destinations[0]);
    expect(callbacks.onTextContent).toHaveBeenCalledWith('Sage here.', 'sage');
    expect(callbacks.onFirstAudioFrame).toHaveBeenCalledWith('sage');
    expect(callbacks.onAssistantTranscript).toHaveBeenCalledWith('Sage here.', 'sage');
    expect(client.getRemoteStream()).toBe(fake.destinations[0]?.stream);

    // A second turn by Sage reuses the output.
    await ask();
    expect(fake.destinations).toHaveLength(2);
    expect(callbacks.onAvatarStream).toHaveBeenCalledTimes(1);
  });

  it('plays out-loud chatter of an unknown request on the speaker output, without touching busy state', async () => {
    const { client, emit, fake, callbacks, activity } = await setup(async () => ({ text: '', cancelled: false }));
    client.notifyWake(now);
    expect(client.getActivity().phase).toBe('listening');
    (fake.context.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 0.5 });

    emit(sentence('chatter-1-sage', 'sage', 'Psst.'));
    await vi.advanceTimersByTimeAsync(100);

    expect(fake.destinations).toHaveLength(2);
    expect(callbacks.onAvatarStream).toHaveBeenCalledWith('sage', fake.destinations[1]?.stream);
    expect(fake.sources[0]?.connect).toHaveBeenCalledWith(fake.destinations[1]);
    expect(callbacks.onTextContent).toHaveBeenCalledWith('Psst.', 'sage');
    expect(callbacks.onAssistantTranscript).not.toHaveBeenCalled();
    expect(activity.at(-1)).toMatchObject({ phase: 'responding', detail: 'Avatar chatter' });

    // Once played, the activity it took is given back.
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getActivity().phase).toBe('listening');
    // The microphone still works (not busy): speech is captured.
    expect(fake.sources.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
  });

  it('holds chatter, and its activity, while a turn is going on', async () => {
    let release: (() => void) | null = null;
    const { emit, ask, activity, callbacks } = await setup(
      (request) =>
        new Promise((resolve) => {
          release = () => resolve({ text: 'x', cancelled: false, avatarId: 'echo' });
          void request;
        }),
    );
    await ask();
    const before = activity.length;
    emit(sentence('chatter-2-rex', 'rex', 'Interjecting.'));
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks.onTextContent).not.toHaveBeenCalledWith('Interjecting.', 'rex');
    expect(activity.slice(before).some((entry) => entry.detail === 'Avatar chatter')).toBe(false);
    (release as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks.onTextContent).toHaveBeenCalledWith('Interjecting.', 'rex');
  });

  it('holds chatter while the own request is still transcribing, before any turn audio exists', async () => {
    let transcribed: (() => void) | null = null;
    const { bridge, emit, ask, callbacks, fake } = await setup(async () => ({ text: 'Hi.', cancelled: false, avatarId: 'echo' }));
    bridge.transcribe = vi.fn(
      () =>
        new Promise((resolve) => {
          transcribed = () => resolve({ text: 'Hey Jarvis, what time is it?' });
        }),
    ) as unknown as LocalVoiceBridge['transcribe'];
    await ask();
    expect(bridge.transcribe).toHaveBeenCalled();
    expect(bridge.respond).not.toHaveBeenCalled();
    emit(sentence('chatter-t', 'sage', 'Too early.'));
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onTextContent).not.toHaveBeenCalledWith('Too early.', 'sage');
    expect(fake.sources).toHaveLength(0);
    (transcribed as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(bridge.respond).toHaveBeenCalledTimes(1);
    expect(callbacks.onTextContent).toHaveBeenCalledWith('Too early.', 'sage');
  });

  it('holds chatter while the own request is thinking, with no turn audio yet', async () => {
    let finish: (() => void) | null = null;
    const { emit, ask, callbacks } = await setup(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ text: 'Answer.', cancelled: false, avatarId: 'echo' });
        }),
    );
    await ask();
    emit(sentence('chatter-u', 'sage', 'Not yet.'));
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onTextContent).not.toHaveBeenCalledWith('Not yet.', 'sage');
    (finish as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(callbacks.onTextContent).toHaveBeenCalledWith('Not yet.', 'sage');
  });

  it('lets chatter proceed when the own request fails or is cancelled', async () => {
    const failing = await setup(async () => {
      throw new Error('model down');
    });
    await failing.ask();
    failing.emit(sentence('chatter-v', 'sage', 'After failure.'));
    await vi.advanceTimersByTimeAsync(500);
    expect(failing.callbacks.onTextContent).toHaveBeenCalledWith('After failure.', 'sage');

    const cancelled = await setup(async () => ({ text: '', cancelled: true, avatarId: 'echo' }));
    await cancelled.ask();
    cancelled.emit(sentence('chatter-w', 'sage', 'After cancel.'));
    await vi.advanceTimersByTimeAsync(500);
    expect(cancelled.callbacks.onTextContent).toHaveBeenCalledWith('After cancel.', 'sage');
  });

  it('drops chatter that waited for the own request when Kevin talks again', async () => {
    const { client, emit, ask, callbacks } = await setup(() => new Promise(() => undefined));
    await ask();
    emit(sentence('chatter-x', 'sage', 'Waiting.'));
    await vi.advanceTimersByTimeAsync(100);
    expect(client.stopChatter()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks.onTextContent).not.toHaveBeenCalledWith('Waiting.', 'sage');
  });

  it('stops chatter with stopChatter() and when Kevin talks', async () => {
    const { client, emit, fake } = await setup(async () => ({ text: '', cancelled: false }));
    client.notifyWake(now);
    // Long enough that it is still playing.
    (fake.context.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 5 });
    emit(sentence('chatter-3-sage', 'sage', 'One.'));
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0]?.stop).not.toHaveBeenCalled();

    client.stopChatter();
    expect(fake.sources[0]?.stop).toHaveBeenCalled();

    emit(sentence('chatter-4-sage', 'sage', 'Two.'));
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.sources).toHaveLength(2);
    client.talk();
    expect(fake.sources[1]?.stop).toHaveBeenCalled();
  });

  it('ignores late events of its own finished requests instead of treating them as chatter', async () => {
    let requestId = '';
    const { ask, emit, fake } = await setup(async (request, emitEvent) => {
      requestId = request.requestId;
      emitEvent(sentence(request.requestId, 'echo', 'Done.'));
      return { text: 'Done.', cancelled: false, avatarId: 'echo' };
    });
    await ask();
    const count = fake.sources.length;
    emit(sentence(requestId, 'echo', 'Late.'));
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.sources).toHaveLength(count);
  });
  it('plays a second chatter turn only after the first has finished', async () => {
    const { emit, fake, callbacks } = await setup(async () => ({ text: '', cancelled: false }));
    (fake.context.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 1 });
    emit(sentence('chatter-a', 'sage', 'First.'));
    emit(sentence('chatter-b', 'rex', 'Second.'));
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.sources).toHaveLength(1);
    expect(callbacks.onTextContent).toHaveBeenCalledWith('First.', 'sage');
    expect(callbacks.onTextContent).not.toHaveBeenCalledWith('Second.', 'rex');
    // A later sentence of the first request stays in its turn and does not jump the queue.
    emit(sentence('chatter-a', 'sage', 'First again.'));
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.sources).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(callbacks.onTextContent).toHaveBeenCalledWith('Second.', 'rex');
    expect(fake.sources).toHaveLength(3);
  });

  it('holds chatter while the client own turn is still playing', async () => {
    let finish: (() => void) | null = null;
    const { emit, fake, callbacks, ask } = await setup(async (request, emitEvent) => {
      emitEvent(sentence(request.requestId, 'echo', 'Own.'));
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { text: 'Own.', cancelled: false, avatarId: 'echo' };
    });
    (fake.context.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 2 });
    await ask();
    const own = fake.sources.length;
    expect(own).toBe(1);
    emit(sentence('chatter-c', 'sage', 'Wait.'));
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.sources).toHaveLength(own);
    expect(callbacks.onTextContent).not.toHaveBeenCalledWith('Wait.', 'sage');
    // Its audio is over but the request is not, so chatter still waits.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.sources).toHaveLength(own);
    (finish as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(4000);
    expect(fake.sources).toHaveLength(own + 1);
    expect(callbacks.onTextContent).toHaveBeenCalledWith('Wait.', 'sage');
  });

  describe('microphone during chatter', () => {
    const speak = (fake: ReturnType<typeof createFakeContext>, loud: boolean, frames: number) => {
      for (let i = 0; i < frames; i += 1) {
        now += FRAME_MS;
        fake.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(FRAME).fill(loud ? 0.2 : 0) } });
      }
    };

    it('does not hear the avatars as Kevin: loud mic input while chatter plays is dropped', async () => {
      const { client, bridge, emit, fake } = await setup(async () => ({ text: '', cancelled: false }));
      client.notifyWake(now); // awake, so speech would be answered
      (fake.context.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 5 });
      emit(sentence('chatter-m1', 'sage', 'Loud talk.'));
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.sources).toHaveLength(1);
      speak(fake, true, 8);
      speak(fake, false, 8);
      await vi.advanceTimersByTimeAsync(1000);
      expect(bridge.transcribe).not.toHaveBeenCalled();
      expect(fake.sources[0]?.stop).not.toHaveBeenCalled();
    });

    it('keeps ignoring the mic for the playback tail, then listens again with a clean buffer', async () => {
      const { client, bridge, emit, fake } = await setup(async () => ({ text: '', cancelled: false }));
      client.notifyWake(now);
      (fake.context.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 0.5 });
      emit(sentence('chatter-m2', 'sage', 'Short.'));
      await vi.advanceTimersByTimeAsync(50);
      speak(fake, true, 2); // ignored: chatter is playing
      await vi.advanceTimersByTimeAsync(1000); // chatter ends, now() has not moved: still inside the tail
      speak(fake, true, 1);
      expect(bridge.transcribe).not.toHaveBeenCalled();
      now += 1000;
      client.notifyWake(now);
      speak(fake, true, 8);
      speak(fake, false, 8);
      await vi.advanceTimersByTimeAsync(1000);
      expect(bridge.transcribe).toHaveBeenCalledTimes(1);
    });

    it('lets the wake word, push-to-talk and a tap interrupt chatter', async () => {
      const interruptFloor = vi.fn(async () => undefined);
      const { client, emit, fake } = await setup(async () => ({ text: '', cancelled: false }), { interruptFloor });
      (fake.context.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 5 });
      emit(sentence('chatter-m3', 'sage', 'Chat.'));
      await vi.advanceTimersByTimeAsync(50);
      client.notifyWake(now);
      expect(fake.sources[0]?.stop).toHaveBeenCalled();
      expect(interruptFloor).toHaveBeenCalledTimes(1);
      // The microphone is open again at once, without a tail.
      expect(client.getActivity().phase).toBe('listening');
      emit(sentence('chatter-m4', 'sage', 'More.'));
      await vi.advanceTimersByTimeAsync(50);
      client.talk();
      expect(fake.sources[1]?.stop).toHaveBeenCalled();
      expect(interruptFloor).toHaveBeenCalledTimes(2);
    });
  });

  it('drops waiting chatter turns with stopChatter()', async () => {
    const { client, emit, fake, callbacks } = await setup(async () => ({ text: '', cancelled: false }));
    (fake.context.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 5 });
    emit(sentence('chatter-d', 'sage', 'Playing.'));
    emit(sentence('chatter-e', 'rex', 'Waiting.'));
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.sources).toHaveLength(1);
    expect(client.stopChatter()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.sources).toHaveLength(1);
    expect(callbacks.onTextContent).not.toHaveBeenCalledWith('Waiting.', 'rex');
    expect(client.stopChatter()).toBe(false);
  });

  it('runs the system turn for the avatar main names, and for echo without an avatarId', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const { bridge, emitSystemReady } = await setup(async (request) => {
      requests.push(request as Record<string, unknown>);
      return { text: '', cancelled: false, note: 'n', avatarId: 'sage' };
    });
    emitSystemReady({ urgent: false, avatarId: 'sage' });
    await vi.advanceTimersByTimeAsync(1500);
    emitSystemReady({ urgent: false });
    await vi.advanceTimersByTimeAsync(1500);
    expect(bridge.respond).toHaveBeenCalledTimes(2);
    expect(requests[0]).toMatchObject({ system: true, avatarId: 'sage' });
    expect(requests[1]).toMatchObject({ system: true });
    expect(requests[1]).not.toHaveProperty('avatarId');
  });

  it('tells main about a barge-in only when chatter was active', async () => {
    const interruptFloor = vi.fn(async () => undefined);
    const { client, emit, fake } = await setup(async () => ({ text: '', cancelled: false }), { interruptFloor });
    client.talk();
    expect(interruptFloor).not.toHaveBeenCalled();
    (fake.context.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ duration: 5 });
    emit(sentence('chatter-f', 'sage', 'Hmm.'));
    await vi.advanceTimersByTimeAsync(100);
    client.talk();
    expect(interruptFloor).toHaveBeenCalledTimes(1);
    client.talk();
    expect(interruptFloor).toHaveBeenCalledTimes(1);
  });
});
