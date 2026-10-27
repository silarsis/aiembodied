import { describe, expect, it, vi } from 'vitest';
import { LocalConversationService } from '../src/voice/local-conversation-service.js';
import { LocalLlmClient } from '../src/voice/local-llm-client.js';
import { ReplySegmenter, toSpeakable } from '../src/voice/reply-segmenter.js';
import type { LocalVoiceEvent } from '../src/voice/types.js';
import { VoiceServiceClient } from '../src/voice/voice-service-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A chat-completions SSE stream whose bytes arrive in awkward pieces. */
function sseResponse(deltas: string[], pieceSize = 13): Response {
  const text =
    deltas.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('') +
    'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += pieceSize) {
          controller.enqueue(bytes.slice(i, i + pieceSize));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function pcmResponse(samples: number): Response {
  return new Response(new Uint8Array(samples * 2), {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': '24000' },
  });
}

async function collect(stream: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of stream) {
    out.push(delta);
  }
  return out;
}

describe('ReplySegmenter', () => {
  it('cuts at sentence ends once the next character arrives', () => {
    const segmenter = new ReplySegmenter();
    expect(segmenter.push('Hello there')).toEqual([]);
    expect(segmenter.push('. How')).toEqual(['Hello there.']);
    expect(segmenter.push(' are you? I')).toEqual(['How are you?']);
    expect(segmenter.flush()).toEqual(['I']);
  });

  it('does not cut inside numbers or avatar tags', () => {
    const segmenter = new ReplySegmenter();
    expect(segmenter.push('It costs 3.5 dollars {move:waves. then bows')).toEqual([]);
    expect(segmenter.push('} Sure! ')).toEqual(['It costs 3.5 dollars {move:waves. then bows} Sure!']);
  });

  it('cuts a long run at a comma', () => {
    const segmenter = new ReplySegmenter();
    const long = `${'word '.repeat(20)}, and then ${'more '.repeat(20)}`;
    const [first] = segmenter.push(long);
    expect(first?.endsWith(',')).toBe(true);
  });

  it('strips tags, markdown and emoji for speech', () => {
    expect(toSpeakable('**Hi** {move:wave} there 👋 {anim:bow}')).toBe('Hi there');
    expect(toSpeakable('{move:wave}')).toBe('');
  });
});

describe('LocalLlmClient', () => {
  it('streams content deltas with Qwen thinking turned off', async () => {
    const fetchFn = vi.fn(async () => sseResponse(['Hel', 'lo', ' world']));
    const client = new LocalLlmClient({ baseUrl: 'http://localhost:1234/v1/', model: 'qwen-next-flash', fetchFn });

    await expect(collect(client.streamChat([{ role: 'user', content: 'hi' }]))).resolves.toEqual([
      'Hel',
      'lo',
      ' world',
    ]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'qwen-next-flash',
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('reports HTTP and in-stream errors', async () => {
    const failing = new LocalLlmClient({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchFn: vi.fn(async () => new Response('model not loaded', { status: 503 })),
    });
    await expect(collect(failing.streamChat([]))).rejects.toThrow(/HTTP 503 model not loaded/);

    const streamError = new LocalLlmClient({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchFn: vi.fn(async () => new Response('data: {"error":{"message":"context full"}}\n\n', { status: 200 })),
    });
    await expect(collect(streamError.streamChat([]))).rejects.toThrow(/context full/);
  });

  it('lists models, or returns null when the server is down', async () => {
    const up = new LocalLlmClient({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchFn: vi.fn(async () => jsonResponse({ data: [{ id: 'qwen-next-flash' }] })),
    });
    await expect(up.listModels()).resolves.toEqual(['qwen-next-flash']);

    const down = new LocalLlmClient({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchFn: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    await expect(down.listModels()).resolves.toBeNull();
  });
});

describe('VoiceServiceClient', () => {
  it('transcribes and synthesizes', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/v1/stt') ? jsonResponse({ text: ' hello ', timings: { sttMs: 120 } }) : pcmResponse(10),
    );
    const client = new VoiceServiceClient({ baseUrl: 'http://127.0.0.1:8191', fetchFn });

    await expect(client.transcribe(new Uint8Array(32))).resolves.toEqual({ text: 'hello', sttMs: 120 });
    const audio = await client.synthesize('Hi.', { voice: 'af_heart' });
    expect(audio.sampleRate).toBe(24000);
    expect(audio.pcm.byteLength).toBe(20);
    const ttsInit = fetchFn.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(ttsInit.body))).toEqual({ text: 'Hi.', voice: 'af_heart' });
  });

  it('surfaces the service error message', async () => {
    const client = new VoiceServiceClient({
      baseUrl: 'http://127.0.0.1:8191',
      fetchFn: vi.fn(async () => jsonResponse({ error: 'models are still loading' }, 503)),
    });
    await expect(client.transcribe(new Uint8Array(2))).rejects.toThrow(/HTTP 503 models are still loading/);
  });
});

describe('LocalConversationService', () => {
  function makeService(options: { transcript?: string; deltas?: string[]; ttsDelayMs?: number } = {}) {
    const llmFetch = vi.fn(async () => sseResponse(options.deltas ?? ['Hi there! ', '{move:waves} Nice ', 'to meet you.']));
    const speechFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/v1/stt')) {
        return jsonResponse({ text: options.transcript ?? 'hello' });
      }
      if (options.ttsDelayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, options.ttsDelayMs);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return pcmResponse(100);
    });
    const service = new LocalConversationService({
      llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'qwen-next-flash', fetchFn: llmFetch }),
      speech: new VoiceServiceClient({ baseUrl: 'http://voice', fetchFn: speechFetch }),
      ttsVoice: 'af_heart',
    });
    return { service, llmFetch, speechFetch };
  }

  it('runs speech-to-text, the LLM and per-sentence speech in order', async () => {
    const { service, llmFetch, speechFetch } = makeService();
    const events: LocalVoiceEvent[] = [];

    const result = await service.runTurn({ turnId: 't1', audio: new Uint8Array(3200), instructions: 'Be brief.' }, (e) =>
      events.push(e),
    );

    expect(result).toMatchObject({
      turnId: 't1',
      transcript: 'hello',
      text: 'Hi there! {move:waves} Nice to meet you.',
      cancelled: false,
    });
    expect(result.timings.firstAudioMs).toBeGreaterThanOrEqual(0);
    expect(events.map((e) => e.type)).toEqual(['transcript', 'text', 'audio', 'text', 'audio']);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual([
      'Hi there!',
      '{move:waves} Nice to meet you.',
    ]);
    const spoken = speechFetch.mock.calls
      .filter(([url]) => String(url).includes('/v1/tts'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).text);
    expect(spoken).toEqual(['Hi there!', 'Nice to meet you.']);
    const messages = JSON.parse(String((llmFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).messages;
    expect(messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('keeps conversation history between turns and resets it', async () => {
    const { service, llmFetch } = makeService({ deltas: ['Sure.'] });
    await service.runTurn({ turnId: 'a', audio: new Uint8Array(2) }, () => {});
    await service.runTurn({ turnId: 'b', audio: new Uint8Array(2) }, () => {});
    const second = JSON.parse(String((llmFetch.mock.calls[1] as unknown as [string, RequestInit])[1].body)).messages;
    expect(second.slice(1)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Sure.' },
      { role: 'user', content: 'hello' },
    ]);

    service.reset();
    await service.runTurn({ turnId: 'c', audio: new Uint8Array(2) }, () => {});
    const third = JSON.parse(String((llmFetch.mock.calls[2] as unknown as [string, RequestInit])[1].body)).messages;
    expect(third).toHaveLength(2);
  });

  it('skips the LLM when nothing was said', async () => {
    const { service, llmFetch } = makeService({ transcript: '' });
    const events: LocalVoiceEvent[] = [];
    const result = await service.runTurn({ turnId: 't', audio: new Uint8Array(2) }, (e) => events.push(e));
    expect(result).toMatchObject({ transcript: '', text: '', cancelled: false });
    expect(events).toEqual([]);
    expect(llmFetch).not.toHaveBeenCalled();
  });

  it('stops speaking when cancelled', async () => {
    const { service } = makeService({ ttsDelayMs: 200 });
    const events: LocalVoiceEvent[] = [];
    const turn = service.runTurn({ turnId: 'x', audio: new Uint8Array(2) }, (e) => events.push(e));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.cancel('x')).toBe(true);

    const result = await turn;
    expect(result.cancelled).toBe(true);
    expect(events.some((e) => e.type === 'audio')).toBe(false);
    expect(service.cancel('x')).toBe(false);
  });

  it('reports status from both services', async () => {
    const { service } = makeService();
    const status = await service.status();
    expect(status.llm).toEqual({ available: false, model: 'qwen-next-flash', baseUrl: 'http://llm/v1' });
    expect(status.speech.available).toBe(false);
  });
});
