import { describe, expect, it, vi } from 'vitest';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { LocalVoiceService } from '../src/local-voice/local-voice-service.js';
import { SpeechServiceClient } from '../src/local-voice/speech-service-client.js';
import type { VoiceMemory } from '../src/memory-engine/voice-memory.js';

function sseResponse(content: string): Response {
  const text = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

type Sent = { messages: Array<{ role: string; content: string }> };

function makeService(memory: VoiceMemory, now = () => 1_000_000) {
  const chats: Sent[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/chat/completions')) {
      chats.push(JSON.parse(String(init?.body)) as Sent);
      return sseResponse('Sure.');
    }
    if (url.endsWith('/v1/tts')) return new Response(new Uint8Array([1]), { status: 200 });
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch;
  const service = new LocalVoiceService({
    llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'qwen', fetchFn }),
    speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
    memory,
    now,
  });
  return { service, chats };
}

describe('LocalVoiceService long-term memory', () => {
  it('fixes the brief at the first turn and puts recalled memories in the user message', async () => {
    let briefs = 0;
    const seen: Array<readonly string[]> = [];
    const memory: VoiceMemory = {
      brief: vi.fn(async () => `Now: brief ${++briefs}.`),
      recall: vi.fn(async (text: string, recalled: readonly string[]) => {
        seen.push([...recalled]);
        return text.includes('tomatoes') ? { block: '<recalled>\n- tomatoes in the greenhouse\n</recalled>', ids: ['m1'] } : null;
      }),
    };
    const { service, chats } = makeService(memory);

    await service.respond({ requestId: 'r1', text: 'how are the tomatoes', instructions: 'Be Echo.' }, () => {});
    await service.respond({ requestId: 'r2', text: 'and the basil?', instructions: 'Be Echo.' }, () => {});

    expect(memory.brief).toHaveBeenCalledTimes(1);
    expect(chats[0].messages[0].content).toMatch(/^Be Echo\.[\s\S]*Now: brief 1\.$/);
    expect(chats[1].messages[0].content).toBe(chats[0].messages[0].content);
    expect(chats[0].messages[1].content).toBe('<recalled>\n- tomatoes in the greenhouse\n</recalled>\n\nhow are the tomatoes');
    // The second turn keeps the first user message as sent, so the prefix is unchanged.
    expect(chats[1].messages.slice(0, 3)).toEqual(chats[0].messages.concat({ role: 'assistant', content: 'Sure.' }));
    expect(chats[1].messages[3]).toEqual({ role: 'user', content: 'and the basil?' });
    expect(seen).toEqual([[], ['m1']]);
  });

  it('marks each turn busy, then idle, for the engine', async () => {
    const activity = vi.fn();
    const memory: VoiceMemory = { brief: async () => null, recall: async () => null, activity };
    const { service } = makeService(memory);
    await service.respond({ requestId: 'r1', text: 'hello' }, () => {});
    expect(activity.mock.calls).toEqual([[true], [false]]);
  });

  it('starts a new brief after the conversation goes idle', async () => {
    let clock = 1_000_000;
    let briefs = 0;
    const memory: VoiceMemory = { brief: async () => `Now: brief ${++briefs}.`, recall: async () => null };
    const { service, chats } = makeService(memory, () => clock);
    await service.respond({ requestId: 'r1', text: 'hello' }, () => {});
    clock += 11 * 60_000;
    await service.respond({ requestId: 'r2', text: 'hello again' }, () => {});
    expect(chats[1].messages).toHaveLength(2);
    expect(chats[1].messages[0].content).toContain('Now: brief 2.');
  });

  it('answers without memory when there is none', async () => {
    const memory: VoiceMemory = { brief: async () => null, recall: async () => null };
    const { service, chats } = makeService(memory);
    const result = await service.respond({ requestId: 'r1', text: 'hello' }, () => {});
    expect(result.text).toBe('Sure.');
    expect(chats[0].messages[1]).toEqual({ role: 'user', content: 'hello' });
  });
});
