import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from '../src/config/provider-settings.js';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { LocalVoiceService } from '../src/local-voice/local-voice-service.js';
import { OpenAiAudioClient, pcm16ToWav } from '../src/local-voice/openai-audio-client.js';
import { buildVoiceEngines } from '../src/local-voice/voice-engines.js';
import type { LocalVoiceEvent } from '../src/local-voice/types.js';

function sse(deltas: string[]): Response {
  const text = deltas.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('');
  return new Response(text + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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

describe('OpenAiAudioClient', () => {
  it('asks for raw PCM with the voice and style prompt, and returns it as WAV', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([0, 0, 1, 0]))) as unknown as typeof fetch;
    const client = new OpenAiAudioClient({ apiKey: 'sk-test', fetchFn });

    const wav = await client.synthesize({ text: 'Hello.', model: 'gpt-4o-mini-tts', voice: 'alloy', instructions: ' calm ' });

    const [url, init] = vi.mocked(fetchFn).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: 'Hello.',
      response_format: 'pcm',
      instructions: 'calm',
    });
    expect(wav.byteLength).toBe(48);
  });

  it('leaves the style prompt out for tts-1, which rejects it', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array(0))) as unknown as typeof fetch;
    await new OpenAiAudioClient({ apiKey: 'sk', fetchFn }).synthesize({
      text: 'Hi',
      model: 'tts-1',
      voice: 'nova',
      instructions: 'whisper',
    });
    const [, init] = vi.mocked(fetchFn).mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('instructions');
  });

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
    for await (const chunk of llm.streamChat([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
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
      if (url.endsWith('/audio/speech')) return new Response(new Uint8Array([0, 0]));
      if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'hi' }));
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const engines = buildVoiceEngines(
      settings({ llm: { provider: 'openai' }, stt: { provider: 'openai' }, tts: { provider: 'openai', openaiVoice: 'coral' } }),
      'sk',
      fetchFn,
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
    expect(status.tts).toMatchObject({ provider: 'openai', ready: true, voice: 'coral' });
  });

  it('reports OpenAI parts as unavailable without a key, and can be swapped back to local', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const service = new LocalVoiceService(buildVoiceEngines(settings({ tts: { provider: 'openai' } }), '', fetchFn));
    expect((await service.status()).tts).toMatchObject({ provider: 'openai', available: false });

    service.configure(buildVoiceEngines(settings({ tts: { kokoroVoice: 'bf_emma' } }), '', fetchFn));
    expect((await service.status()).tts).toMatchObject({ provider: 'kokoro', voice: 'bf_emma' });
  });
});
