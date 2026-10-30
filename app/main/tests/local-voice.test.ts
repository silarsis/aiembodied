import { describe, expect, it, vi } from 'vitest';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { SpeechServiceClient } from '../src/local-voice/speech-service-client.js';
import {
  LocalVoiceService,
  SPOKEN_REPLY_GUIDANCE,
  SentenceSplitter,
  ThinkFilter,
  toSpeakableText,
} from '../src/local-voice/local-voice-service.js';
import type { LocalVoiceEvent } from '../src/local-voice/types.js';

/** An SSE chat-completions stream whose bytes arrive in awkward pieces, splitting lines mid-way. */
function sseResponse(deltas: string[], pieceSize = 11): Response {
  const lines = deltas.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  const bytes = new TextEncoder().encode(lines.join('') + 'data: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += pieceSize) {
        controller.enqueue(bytes.slice(i, i + pieceSize));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function wavFor(text: string): Response {
  return new Response(new TextEncoder().encode(`WAV:${text}`), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
}

function makeService(deltas: string[], options: { now?: () => number } = {}) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
    requests.push({ url, body });
    if (url.endsWith('/chat/completions')) {
      return sseResponse(deltas);
    }
    if (url.endsWith('/v1/tts')) {
      return wavFor((body as { text: string }).text);
    }
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch;
  const service = new LocalVoiceService({
    llm: new LocalLlmClient({ baseUrl: 'http://llm/v1/', model: 'qwen-next-flash', fetchFn }),
    speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
    voice: 'bm_george',
    now: options.now,
  });
  return { service, requests };
}

describe('SentenceSplitter', () => {
  it('cuts streamed text at sentence ends and keeps the rest buffered', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('Good evening, sir. How')).toEqual(['Good evening, sir.']);
    expect(splitter.push(' can I help? I am')).toEqual(['How can I help?']);
    expect(splitter.flush()).toBe('I am');
    expect(splitter.flush()).toBeNull();
  });

  it('never splits inside an avatar tag and keeps short fragments together', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('Hi! {move:waves. then bows} Nice to see you. ')).toEqual([
      'Hi! {move:waves. then bows} Nice to see you.',
    ]);
  });

  it('breaks very long sentences at a comma', () => {
    const splitter = new SentenceSplitter();
    const clause = 'this clause keeps going and going without any full stop at all';
    const sentences = splitter.push(`${clause}, ${clause}, ${clause}, ${clause} and more`);
    expect(sentences.length).toBeGreaterThan(0);
    expect(sentences[0]?.endsWith(',')).toBe(true);
  });
});

describe('ThinkFilter', () => {
  it('drops think blocks split across deltas', () => {
    const filter = new ThinkFilter();
    const out = ['<thi', 'nk>\nplanning', ' things</think>\n\nHel', 'lo there.'].map((d) => filter.push(d)).join('');
    expect(out.trim()).toBe('Hello there.');
    expect(filter.visible.trim()).toBe('Hello there.');
  });

  it('passes ordinary angle brackets through once it is clear they are not a tag', () => {
    const filter = new ThinkFilter();
    expect(filter.push('3 <')).toBe('3 ');
    expect(filter.push(' 4')).toBe('< 4');
  });
});

describe('toSpeakableText', () => {
  it('removes tags and markdown, and returns empty when nothing is left to say', () => {
    expect(toSpeakableText('**Sure** {anim:wave} thing.')).toBe('Sure thing.');
    expect(toSpeakableText('{anim:wave}')).toBe('');
    expect(toSpeakableText(' * ')).toBe('');
  });
});

describe('LocalVoiceService', () => {
  it('streams a reply sentence by sentence with audio, keeping tags in the text', async () => {
    const { service, requests } = makeService(['Canberra is the capital. ', '{anim:wave} Anything', ' else?']);
    const events: LocalVoiceEvent[] = [];

    const result = await service.respond(
      { requestId: 'r1', text: 'What is the capital of Australia?', instructions: 'You are Jarvis.' },
      (event) => events.push(event),
    );

    expect(result).toEqual({ requestId: 'r1', text: 'Canberra is the capital. {anim:wave} Anything else?', cancelled: false });
    const sentences = events.filter((e): e is Extract<LocalVoiceEvent, { type: 'sentence' }> => e.type === 'sentence');
    expect(sentences.map((e) => [e.index, e.text])).toEqual([
      [0, 'Canberra is the capital.'],
      [1, '{anim:wave} Anything else?'],
    ]);
    expect(new TextDecoder().decode(sentences[1]?.wav)).toBe('WAV:Anything else?');

    const chat = requests.find((r) => r.url === 'http://llm/v1/chat/completions')?.body as Record<string, unknown>;
    expect(chat).toMatchObject({
      model: 'qwen-next-flash',
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(chat.messages).toEqual([
      { role: 'system', content: `You are Jarvis.\n\n${SPOKEN_REPLY_GUIDANCE}` },
      { role: 'user', content: 'What is the capital of Australia?' },
    ]);
    const tts = requests.filter((r) => r.url === 'http://speech/v1/tts').map((r) => r.body);
    expect(tts).toEqual([
      { text: 'Canberra is the capital.', voice: 'bm_george' },
      { text: 'Anything else?', voice: 'bm_george' },
    ]);
  });

  it('remembers earlier turns and forgets them after a long pause', async () => {
    let now = 1_000_000;
    const { service, requests } = makeService(['Sure thing.'], { now: () => now });
    await service.respond({ requestId: 'a', text: 'first' }, () => undefined);
    await service.respond({ requestId: 'b', text: 'second' }, () => undefined);
    const chats = () =>
      requests.filter((r) => r.url.endsWith('/chat/completions')).map((r) => (r.body as { messages: unknown[] }).messages);
    expect(chats()[1]).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'Sure thing.' },
      { role: 'user', content: 'second' },
    ]);

    now += 11 * 60_000;
    await service.respond({ requestId: 'c', text: 'third' }, () => undefined);
    expect(chats()[2]).toHaveLength(2);
  });

  it('reports a cancelled reply without throwing', async () => {
    const fetchFn = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    const service = new LocalVoiceService({
      llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'm', fetchFn }),
      speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
    });

    const pending = service.respond({ requestId: 'x', text: 'hello' }, () => undefined);
    service.cancel('x');
    await expect(pending).resolves.toEqual({ requestId: 'x', text: '', cancelled: true });
  });

  it('summarises service status, treating unreachable services as unavailable', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/models')) {
        return new Response('{}', { status: 200 });
      }
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const service = new LocalVoiceService({
      llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'qwen-next-flash', fetchFn }),
      speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
    });

    await expect(service.status()).resolves.toEqual({
      llm: { available: true, model: 'qwen-next-flash', baseUrl: 'http://llm/v1', provider: 'local' },
      stt: { provider: 'local', available: false, model: null, url: null },
      tts: { provider: 'kokoro', available: false, ready: false, model: null, voice: null, error: null },
      speech: { available: false, ready: false, sttModel: null, ttsModel: null, voices: [], defaultVoice: null, error: null },
    });
  });

  it('checks a separate STT server itself, since the speech service reports ready without it', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://speech/health') {
        return new Response(
          JSON.stringify({
            ready: true,
            error: null,
            stt: { engine: 'openai-compatible', model: 'qwen3-asr', url: 'http://asr/v1/' },
            tts: { engine: 'kokoro', voices: ['bf_lily'], default_voice: 'bf_lily' },
          }),
        );
      }
      if (url === 'http://llm/v1/models') {
        return new Response('{}', { status: 200 });
      }
      // The ASR llama-server is down.
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const service = new LocalVoiceService({
      llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'qwen-next-flash', fetchFn }),
      speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
    });

    const status = await service.status();
    expect(status.stt).toEqual({ provider: 'local', available: false, model: 'qwen3-asr', url: 'http://asr/v1' });
    expect(status.tts).toMatchObject({ provider: 'kokoro', ready: true, voice: 'bf_lily' });
    expect(status.speech).toMatchObject({ available: true, ready: true, ttsModel: 'kokoro' });
    expect(fetchFn).toHaveBeenCalledWith('http://asr/v1/models', expect.anything());
  });
});

describe('SpeechServiceClient', () => {
  it('posts WAV for transcription and parses health', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/health')) {
        return new Response(
          JSON.stringify({
            ready: true,
            error: null,
            stt: { model: 'small.en' },
            tts: { voices: ['bm_george', 'af_heart'], default_voice: 'bm_george' },
          }),
        );
      }
      expect(init?.headers).toEqual({ 'Content-Type': 'audio/wav' });
      return new Response(JSON.stringify({ text: 'hello', timings: { transcribe_ms: 12, bogus: 'x' } }));
    }) as unknown as typeof fetch;
    const client = new SpeechServiceClient({ baseUrl: 'http://speech/', fetchFn });

    await expect(client.health()).resolves.toEqual({
      ready: true,
      error: null,
      sttModel: 'small.en',
      sttUrl: null,
      ttsModel: null,
      voices: ['bm_george', 'af_heart'],
      defaultVoice: 'bm_george',
    });
    await expect(client.transcribe(new Uint8Array([1, 2, 3]))).resolves.toEqual({
      text: 'hello',
      timings: { transcribe_ms: 12 },
    });
  });

  it('surfaces the service error message', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'engines are still loading' }), { status: 503 }),
    ) as unknown as typeof fetch;
    const client = new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn });
    await expect(client.synthesize({ text: 'hi' })).rejects.toThrow('HTTP 503 engines are still loading');
  });
});
