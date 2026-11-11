import { describe, expect, it, vi } from 'vitest';
import { VoiceServices } from '../src/avatars/voice-services.js';
import { LocalVoiceService } from '../src/local-voice/local-voice-service.js';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { SpeechServiceClient } from '../src/local-voice/speech-service-client.js';

function makeServices() {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string; content: string }> };
      const last = body.messages[body.messages.length - 1]?.content ?? '';
      const encoder = new TextEncoder();
      const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: `Re: ${last}.` } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(new ReadableStream({ start: (c) => { c.enqueue(encoder.encode(chunk)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('/tts') || url.includes('/speech')) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  const engines = {
    llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'm', fetchFn }),
    speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
  };
  const created: string[] = [];
  const services = new VoiceServices({
    create: (avatarId) => {
      created.push(avatarId);
      return new LocalVoiceService({ ...engines, avatarId });
    },
  });
  return { services, created, engines };
}

describe('VoiceServices', () => {
  it('makes one service per avatar, lazily, with echo as the default', () => {
    const { services, created } = makeServices();
    expect(created).toEqual([]);
    const echo = services.get();
    expect(echo.avatarId).toBe('echo');
    expect(services.get('echo')).toBe(echo);
    const sage = services.get('sage');
    expect(sage).not.toBe(echo);
    expect(sage.avatarId).toBe('sage');
    expect(created).toEqual(['echo', 'sage']);
    expect(services.entries().map(([id]) => id)).toEqual(['echo', 'sage']);
  });

  it('keeps notes separate per avatar', () => {
    const { services } = makeServices();
    services.get('echo').notify('for echo');
    services.get('sage').notify('for sage one');
    services.get('sage').notify('for sage two', { urgent: true });
    expect(services.get('echo').systemStatus()).toMatchObject({ pending: 1, texts: ['for echo'], urgent: false });
    expect(services.get('sage').systemStatus()).toMatchObject({ pending: 2, urgent: true });
    services.get('sage').resetHistory();
    expect(services.get('echo').systemStatus().pending).toBe(1);
  });

  it('keeps history separate and shares engines when configured', () => {
    const { services, engines } = makeServices();
    const echo = services.get('echo');
    const sage = services.get('sage');
    const close = vi.fn();
    const tts = { status: vi.fn(), close } as never;
    services.configure({ ...engines, tts });
    // The shared engine is closed once, not once per service.
    const next = { status: vi.fn(), close: vi.fn() } as never;
    services.configure({ tts: next });
    expect(close).toHaveBeenCalledTimes(1);
    expect(echo).not.toBe(sage);
  });

  it('answers each avatar from its own history', async () => {
    const { services } = makeServices();
    const events: unknown[] = [];
    await services.get('echo').respond({ requestId: 'r1', text: 'hello echo' }, (e) => events.push(e));
    await services.get('sage').respond({ requestId: 'r2', text: 'hello sage' }, (e) => events.push(e));
    const echoHistory = (services.get('echo') as unknown as { history: Array<{ content: string }> }).history;
    const sageHistory = (services.get('sage') as unknown as { history: Array<{ content: string }> }).history;
    expect(echoHistory.map((m) => m.content).join('|')).toContain('hello echo');
    expect(echoHistory.map((m) => m.content).join('|')).not.toContain('hello sage');
    expect(sageHistory.map((m) => m.content).join('|')).toContain('hello sage');
    services.get('echo').resetHistory();
    expect((services.get('sage') as unknown as { history: unknown[] }).history.length).toBeGreaterThan(0);
  });
});
