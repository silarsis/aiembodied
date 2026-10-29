import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from '../src/config/provider-settings.js';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { LocalVoiceService } from '../src/local-voice/local-voice-service.js';
import { OpenAiAudioClient, pcm16ToWav } from '../src/local-voice/openai-audio-client.js';
import {
  OpenAiRealtimeTts,
  VERBATIM_INSTRUCTIONS,
  type RealtimeSocket,
  type RealtimeSocketFactory,
} from '../src/local-voice/openai-realtime-tts.js';
import { buildVoiceEngines } from '../src/local-voice/voice-engines.js';
import type { LocalVoiceEvent } from '../src/local-voice/types.js';

function sse(deltas: string[]): Response {
  const text = deltas.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('');
  return new Response(text + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * A stand-in for the Realtime API: opens on the next tick and answers each response.create with
 * one audio delta (the text's length in samples, so tests can tell sentences apart).
 */
class FakeRealtime {
  sockets: FakeSocket[] = [];
  sent: Array<Record<string, unknown>> = [];
  headers: Record<string, string> = {};
  url = '';
  /** Set to make the server fail the next response with this message. */
  failNext: string | null = null;
  /** Set to hold responses until release() is called. */
  hold = false;
  private held: Array<() => void> = [];
  private nextId = 1;

  factory: RealtimeSocketFactory = (url, headers) => {
    this.url = url;
    this.headers = headers;
    const socket = new FakeSocket(this);
    this.sockets.push(socket);
    setTimeout(() => {
      socket.readyState = 1;
      socket.onopen?.({});
    }, 0);
    return socket;
  };

  receive(socket: FakeSocket, message: Record<string, unknown>): void {
    this.sent.push(message);
    if (message.type !== 'response.create') {
      return;
    }
    const id = `resp_${this.nextId++}`;
    const text = ((message.response as { input: Array<{ content: Array<{ text: string }> }> }).input[0]?.content[0]?.text) ?? '';
    const emit = (event: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify(event) });
    const respond = () => {
      emit({ type: 'response.created', response: { id } });
      if (this.failNext) {
        const message = this.failNext;
        this.failNext = null;
        emit({ type: 'response.done', response: { id, status: 'failed', status_details: { error: { message } } } });
        return;
      }
      const pcm = Buffer.alloc(text.length * 2, 1);
      emit({ type: 'response.output_audio.delta', response_id: id, delta: pcm.toString('base64') });
      emit({ type: 'response.done', response: { id, status: 'completed' } });
    };
    if (this.hold) {
      this.held.push(respond);
    } else {
      setTimeout(respond, 0);
    }
  }

  release(): void {
    for (const respond of this.held.splice(0)) {
      respond();
    }
  }
}

class FakeSocket implements RealtimeSocket {
  readyState = 0;
  onopen: RealtimeSocket['onopen'] = null;
  onmessage: RealtimeSocket['onmessage'] = null;
  onclose: RealtimeSocket['onclose'] = null;
  onerror: RealtimeSocket['onerror'] = null;
  constructor(private readonly server: FakeRealtime) {}
  send(data: string): void {
    this.server.receive(this, JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function samples(wav: Uint8Array): number {
  return new DataView(wav.buffer, wav.byteOffset).getUint32(40, true) / 2;
}

function settings(overrides: Partial<{ [K in keyof ProviderSettings]: Partial<ProviderSettings[K]> }>): ProviderSettings {
  const base = structuredClone(DEFAULT_PROVIDER_SETTINGS);
  return {
    llm: { ...base.llm, ...overrides.llm },
    stt: { ...base.stt, ...overrides.stt },
    tts: { ...base.tts, ...overrides.tts },
    motion: { ...base.motion, ...overrides.motion },
    speechServiceUrl: base.speechServiceUrl,
  };
}

describe('pcm16ToWav', () => {
  it('writes a mono 16-bit header around the samples and drops an odd trailing byte', () => {
    const wav = pcm16ToWav(new Uint8Array([1, 2, 3, 4, 5]), 24_000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 4]);
  });
});

describe('OpenAiRealtimeTts', () => {
  it('reads each sentence verbatim as an out-of-band response on one session', async () => {
    const server = new FakeRealtime();
    const tts = new OpenAiRealtimeTts({
      apiKey: 'sk-test',
      model: 'gpt-realtime-2.1-mini',
      voice: 'alloy',
      style: 'calm',
      createSocket: server.factory,
    });

    const [first, second] = await Promise.all([tts.synthesize('Hello there.'), tts.synthesize('Bye.')]);
    expect(samples(first)).toBe('Hello there.'.length);
    expect(samples(second)).toBe('Bye.'.length);
    expect(new DataView(first.buffer, first.byteOffset).getUint32(24, true)).toBe(24_000);

    expect(server.sockets).toHaveLength(1);
    expect(server.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
    expect(server.headers).toEqual({ Authorization: 'Bearer sk-test' });
    const [session, ...responses] = server.sent;
    expect(session).toMatchObject({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: { output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: 'alloy' } },
      },
    });
    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['audio'],
        instructions: `${VERBATIM_INSTRUCTIONS}\n\nSpeaking style: calm`,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello there.' }] }],
      },
    });
    tts.close();
  });

  it('surfaces a failed response and keeps going with the next sentence', async () => {
    const server = new FakeRealtime();
    const tts = new OpenAiRealtimeTts({ apiKey: 'sk', model: 'm', voice: 'alloy', createSocket: server.factory });
    server.failNext = 'Rate limit reached';

    await expect(tts.synthesize('One.')).rejects.toThrow('Rate limit reached');
    expect(tts.status().error).toBe('Rate limit reached');
    await expect(tts.synthesize('Two.')).resolves.toBeInstanceOf(Uint8Array);
    tts.close();
  });

  it('cancels a sentence on abort and fails a sentence when the connection drops', async () => {
    const server = new FakeRealtime();
    const tts = new OpenAiRealtimeTts({ apiKey: 'sk', model: 'm', voice: 'alloy', createSocket: server.factory });
    server.hold = true;

    const controller = new AbortController();
    const cancelled = tts.synthesize('Never mind.', { signal: controller.signal });
    await vi.waitFor(() => expect(server.sent.some((m) => m.type === 'response.create')).toBe(true));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.sent.at(-1)).toEqual({ type: 'response.cancel' });
    server.release();

    const dropped = tts.synthesize('Hello.');
    await vi.waitFor(() => expect(server.sent.filter((m) => m.type === 'response.create')).toHaveLength(2));
    server.sockets[0]?.close();
    await expect(dropped).rejects.toThrow(/closed/);

    // The next sentence reconnects.
    server.hold = false;
    await expect(tts.synthesize('Back.')).resolves.toBeInstanceOf(Uint8Array);
    expect(server.sockets).toHaveLength(2);
    tts.close();
  });

  it('needs a key', async () => {
    const tts = new OpenAiRealtimeTts({ apiKey: '', model: 'm', voice: 'alloy', createSocket: new FakeRealtime().factory });
    await expect(tts.synthesize('Hi.')).rejects.toThrow(/API key/);
    expect(tts.status()).toMatchObject({ available: false, error: 'OpenAI API key is not set.' });
  });
});

describe('OpenAiAudioClient', () => {
  it('uploads the utterance for transcription and surfaces API errors', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'hello there' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 }));
    const client = new OpenAiAudioClient({ apiKey: 'sk', fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.transcribe(new Uint8Array([1, 2]), { model: 'gpt-4o-mini-transcribe' })).resolves.toMatchObject({
      text: 'hello there',
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('file')).toBeInstanceOf(Blob);

    await expect(client.transcribe(new Uint8Array([1]), { model: 'whisper-1' })).rejects.toThrow(
      'OpenAI speech-to-text failed: HTTP 401 Incorrect API key',
    );
  });
});

describe('LocalLlmClient with OpenAI', () => {
  it('sends only parameters OpenAI accepts, with the key', async () => {
    const fetchFn = vi.fn(async () => sse(['Hi.'])) as unknown as typeof fetch;
    const llm = new LocalLlmClient({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      apiKey: 'sk',
      flavor: 'openai',
      fetchFn,
    });
    const chunks: string[] = [];
    for await (const part of llm.streamChat([{ role: 'user', content: 'hi' }])) {
      if (part.type === 'text') chunks.push(part.text);
    }
    expect(chunks).toEqual(['Hi.']);
    const [, init] = vi.mocked(fetchFn).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('chat_template_kwargs');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).toMatchObject({ model: 'gpt-4.1-mini', stream: true, max_completion_tokens: 1024 });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk');
    // OpenAI availability is the key, not a request per status poll.
    await expect(llm.isAvailable()).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('buildVoiceEngines', () => {
  it('runs a whole turn on OpenAI when every part is set to it', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/chat/completions')) return sse(['Hello there, friend.']);
      if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'hi' }));
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const server = new FakeRealtime();
    const engines = buildVoiceEngines(
      settings({ llm: { provider: 'openai' }, stt: { provider: 'openai' }, tts: { provider: 'openai', openaiVoice: 'coral' } }),
      'sk',
      { fetchFn, createSocket: server.factory },
    );
    const service = new LocalVoiceService(engines);

    await expect(service.transcribe(new Uint8Array([1]))).resolves.toMatchObject({ text: 'hi' });
    const events: LocalVoiceEvent[] = [];
    await service.respond({ requestId: 'r1', text: 'hi' }, (event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'sentence', text: 'Hello there, friend.' });

    const status = await service.status();
    expect(status.llm).toMatchObject({ provider: 'openai', available: true, model: 'gpt-4.1-mini' });
    expect(status.stt).toMatchObject({ provider: 'openai', available: true, model: 'gpt-4o-mini-transcribe' });
    expect(status.tts).toMatchObject({ provider: 'openai', ready: true, voice: 'coral', model: 'gpt-realtime-2.1-mini' });
    expect(server.sent.some((m) => m.type === 'response.create')).toBe(true);
    engines.tts.close?.();
  });

  it('reports OpenAI parts as unavailable without a key, and can be swapped back to local', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const service = new LocalVoiceService(buildVoiceEngines(settings({ tts: { provider: 'openai' } }), '', { fetchFn }));
    expect((await service.status()).tts).toMatchObject({ provider: 'openai', available: false });

    service.configure(buildVoiceEngines(settings({ tts: { kokoroVoice: 'bf_emma' } }), '', { fetchFn }));
    expect((await service.status()).tts).toMatchObject({ provider: 'kokoro', voice: 'bf_emma' });
  });
});
