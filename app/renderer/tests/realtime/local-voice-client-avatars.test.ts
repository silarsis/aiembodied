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

  async function setup(respond: Parameters<typeof createBridge>[0]) {
    const { bridge, emit } = createBridge(respond);
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
    return { client, bridge, emit, fake, callbacks, activity, ask };
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

  it('does not set activity for chatter while a turn is going on', async () => {
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
    expect(callbacks.onTextContent).toHaveBeenCalledWith('Interjecting.', 'rex');
    expect(activity.slice(before).some((entry) => entry.detail === 'Avatar chatter')).toBe(false);
    (release as (() => void) | null)?.();
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
});
