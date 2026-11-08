import { describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, parseSpeakingModel, formatSpeakingModel, speakingVoiceKey } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { LocalVoiceService } from '../src/local-voice/local-voice-service.js';
import { SpeechServiceTts } from '../src/local-voice/speech-engines.js';
import { SpeechServiceClient } from '../src/local-voice/speech-service-client.js';
import { buildVoiceEngines } from '../src/local-voice/voice-engines.js';

type Sent = Record<string, unknown>;

function speechFetch(sent: Sent[], fail?: (body: Sent) => boolean) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/tts')) {
      const body = JSON.parse(String(init?.body)) as Sent;
      sent.push(body);
      if (fail?.(body)) return new Response(JSON.stringify({ error: `unknown voice '${String(body.voice)}'` }), { status: 400 });
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    }
    if (url.endsWith('/v1/tts/engines')) {
      return Response.json({
        engines: [
          { id: 'kitten', label: 'Kitten TTS', available: true, error: null, models: [{ id: 'mini-0.8', label: 'Kitten mini 0.8', installed: true, size_mb: 80, voices: ['Rosie'], default_voice: 'Rosie', download: { status: 'done', received: 5, total: 5, error: null } }] },
        ],
      });
    }
    if (url.endsWith('/chat/completions')) {
      const text = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello there.' } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
}

describe('Speaking engines', () => {
  it('reads the engine from the route, keeping an old Kokoro voice name as Kokoro', () => {
    expect(parseSpeakingModel(undefined)).toEqual({ engine: 'kokoro' });
    expect(parseSpeakingModel('kitten:nano-0.8')).toEqual({ engine: 'kitten', model: 'nano-0.8' });
    expect(parseSpeakingModel('kitten')).toEqual({ engine: 'kitten', model: 'mini-0.8' });
    expect(parseSpeakingModel('piper')).toEqual({ engine: 'piper' });
    expect(parseSpeakingModel('bf_lily')).toEqual({ engine: 'kokoro', legacyVoice: 'bf_lily' });
    expect(formatSpeakingModel('kitten')).toBe('kitten:mini-0.8');
    expect(formatSpeakingModel('piper', 'x')).toBe('piper');
  });

  it('saves a character voice per engine, and OpenAI separately', () => {
    const servers = builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' });
    const routes = defaultRoutes(DEFAULT_PROVIDER_SETTINGS);
    expect(speakingVoiceKey({ servers, routes })).toBe('kokoro');
    expect(speakingVoiceKey({ servers, routes: { ...routes, tts: { server: 'local-speech', model: 'kitten:mini-0.8' } } })).toBe('kitten');
    expect(speakingVoiceKey({ servers, routes: { ...routes, tts: { server: 'openai' } } })).toBe('openai');
  });

  it('sends the engine, model and character voice to the speech service', async () => {
    const sent: Sent[] = [];
    const servers = builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' });
    const routes = { ...defaultRoutes(DEFAULT_PROVIDER_SETTINGS), tts: { server: 'local-speech', model: 'kitten:mini-0.8', voice: 'Bella' } };
    const { tts } = buildVoiceEngines({ servers, routes }, () => undefined, { fetchFn: speechFetch(sent) });
    await tts.synthesize('Hi.');
    await tts.synthesize('Hi.', { voice: 'Rosie' });
    expect(sent).toEqual([
      { text: 'Hi.', voice: 'Bella', engine: 'kitten', model: 'mini-0.8' },
      { text: 'Hi.', voice: 'Rosie', engine: 'kitten', model: 'mini-0.8' },
    ]);
  });

  it('falls back to the default voice when the character’s is unknown to the engine', async () => {
    const sent: Sent[] = [];
    const speech = new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn: speechFetch(sent, (body) => body.voice === 'af_heart') });
    const tts = new SpeechServiceTts(speech, { engine: 'piper', voice: 'en_GB-alba-medium' });
    await expect(tts.synthesize('Hi.', { voice: 'af_heart' })).resolves.toEqual(new Uint8Array([1, 2]));
    expect(sent.map((body) => body.voice)).toEqual(['af_heart', 'en_GB-alba-medium']);
  });

  it('speaks a reply in the character’s voice', async () => {
    const sent: Sent[] = [];
    const fetchFn = speechFetch(sent);
    const service = new LocalVoiceService({
      llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'qwen', fetchFn }),
      speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
      tts: new SpeechServiceTts(new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }), { engine: 'kitten', model: 'mini-0.8' }),
      voiceFor: async () => 'Luna',
    });
    await service.respond({ requestId: 'r1', text: 'hello' }, () => {});
    expect(sent).toEqual([{ text: 'Hello there.', voice: 'Luna', engine: 'kitten', model: 'mini-0.8' }]);
  });

  it('lists a speech service’s engines and models', async () => {
    const speech = new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn: speechFetch([]) });
    const [kitten] = (await speech.ttsEngines()) ?? [];
    expect(kitten.models[0]).toEqual({
      id: 'mini-0.8',
      label: 'Kitten mini 0.8',
      installed: true,
      sizeMb: 80,
      voices: ['Rosie'],
      defaultVoice: 'Rosie',
      download: { status: 'done', received: 5, total: 5, error: null },
    });
  });
});
