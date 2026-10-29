import { describe, expect, it, vi } from 'vitest';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { SpeechServiceClient } from '../src/local-voice/speech-service-client.js';
import { LocalVoiceService, TOOL_GUIDANCE } from '../src/local-voice/local-voice-service.js';
import type { LocalVoiceEvent } from '../src/local-voice/types.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import {
  WEB_SEARCH_TOOL_ID,
  createWebSearchProvider,
  createWebSearchTool,
  type WebSearchProvider,
} from '../src/tools/web-search.js';

type Delta = { content?: string; tool_calls?: unknown[] };

/** An SSE chat-completions stream of raw deltas, cut into small byte pieces. */
function sseResponse(deltas: Delta[], pieceSize = 13): Response {
  const lines = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
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

/** A web_search call whose arguments arrive in two pieces, as llama-server streams them. */
const searchCall: Delta[] = [
  { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query": "Canb' } }] },
  { tool_calls: [{ index: 0, function: { arguments: 'erra weather"}' } }] },
];

class FakeSearch implements WebSearchProvider {
  readonly name = 'fake';
  readonly queries: string[] = [];
  constructor(private readonly fail = false) {}
  async search(query: string, options: { limit: number }) {
    this.queries.push(query);
    if (this.fail) {
      throw new Error('search is down');
    }
    return Array.from({ length: options.limit + 2 }, (_, i) => ({
      title: ` Result ${i} `,
      url: `https://example.com/${i}`,
      snippet: `Sunny,\n  ${i} degrees.`,
    }));
  }
}

function makeService(rounds: Delta[][], search = new FakeSearch()) {
  const chats: Array<Record<string, unknown>> = [];
  const tts: string[] = [];
  let round = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/chat/completions')) {
      chats.push(structuredClone(body));
      return sseResponse(rounds[round++] ?? [{ content: 'Done.' }]);
    }
    if (url.endsWith('/v1/tts')) {
      tts.push(body.text as string);
      return new Response(new Uint8Array([1]), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch;
  const tools = new ToolRegistry();
  tools.register(createWebSearchTool(search, { limit: 3 }));
  const service = new LocalVoiceService({
    llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'qwen-next-flash', fetchFn }),
    speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
    tools,
  });
  return { service, chats, tts, search };
}

describe('LocalLlmClient tool calls', () => {
  it('sends tool definitions and assembles streamed tool calls', async () => {
    let sent: Record<string, unknown> = {};
    const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([{ content: 'Checking.' }, ...searchCall]);
    }) as unknown as typeof fetch;
    const client = new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'm', fetchFn });
    const tool = { type: 'function' as const, function: { name: 'web_search', description: 'd', parameters: {} } };

    const parts = [];
    for await (const part of client.streamChat([{ role: 'user', content: 'hi' }], { tools: [tool] })) {
      parts.push(part);
    }

    expect(sent.tools).toEqual([tool]);
    expect(parts).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_calls', calls: [{ id: 'call_1', name: 'web_search', arguments: '{"query": "Canberra weather"}' }] },
    ]);
  });
});

describe('LocalVoiceService tools', () => {
  it('runs web_search, says something while it does, and answers from the results', async () => {
    const { service, chats, tts, search } = makeService([searchCall, [{ content: 'It is sunny in Canberra.' }]]);
    const events: LocalVoiceEvent[] = [];

    const result = await service.respond({ requestId: 'r1', text: 'What is the weather in Canberra?' }, (e) => events.push(e));

    expect(result.text).toBe('It is sunny in Canberra.');
    expect(search.queries).toEqual(['Canberra weather']);
    expect(tts).toEqual(['Let me look that up.', 'It is sunny in Canberra.']);

    expect(chats[0]?.tools).toEqual([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'web_search' }) }),
    ]);
    expect((chats[0]?.messages as Array<{ content: string }>)[0]?.content).toContain(TOOL_GUIDANCE);

    const followUp = chats[1]?.messages as Array<Record<string, unknown>>;
    expect(followUp[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search' } }],
    });
    expect(followUp[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    const toolResult = JSON.parse(followUp[3]?.content as string) as { results: unknown[] };
    expect(toolResult.results).toHaveLength(3);
    expect(toolResult.results[0]).toEqual({ title: 'Result 0', url: 'https://example.com/0', snippet: 'Sunny, 0 degrees.' });

    const toolEvents = events.filter((e) => e.type === 'tool');
    expect(toolEvents.map((e) => [e.status, e.name, e.label])).toEqual([
      ['started', 'web_search', 'Canberra weather'],
      ['done', 'web_search', 'Canberra weather'],
    ]);
  });

  it('keeps tool exchanges out of the conversation history', async () => {
    const { service, chats } = makeService([searchCall, [{ content: 'Sunny.' }], [{ content: 'You are welcome.' }]]);
    await service.respond({ requestId: 'r1', text: 'Weather?' }, () => undefined);
    await service.respond({ requestId: 'r2', text: 'Thanks.' }, () => undefined);

    const messages = chats[2]?.messages as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('tells the model when a tool fails, and reports the failure', async () => {
    const { service, chats } = makeService([searchCall, [{ content: 'I could not check that.' }]], new FakeSearch(true));
    const events: LocalVoiceEvent[] = [];

    const result = await service.respond({ requestId: 'r1', text: 'Weather?' }, (e) => events.push(e));

    expect(result.text).toBe('I could not check that.');
    const toolMessage = (chats[1]?.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
    expect(JSON.parse(toolMessage?.content ?? '{}')).toEqual({ error: 'search is down' });
    expect(events.filter((e) => e.type === 'tool').at(-1)).toMatchObject({ status: 'failed', detail: 'search is down' });
  });

  it('offers no tools on the last round, so a model that keeps calling them still answers', async () => {
    const { service, chats, tts } = makeService([searchCall, searchCall, [{ content: 'Here is what I found.' }]]);

    const result = await service.respond({ requestId: 'r1', text: 'Weather?' }, () => undefined);

    expect(result.text).toBe('Here is what I found.');
    expect(chats).toHaveLength(3);
    expect(chats[2]).not.toHaveProperty('tools');
    expect(tts.filter((text) => text === 'Let me look that up.')).toHaveLength(2);
  });

  it('answers a call to an unknown tool with an error instead of failing the turn', async () => {
    const unknown: Delta[] = [{ tool_calls: [{ index: 0, id: 'x', function: { name: 'open_door', arguments: '{}' } }] }];
    const { service, chats } = makeService([unknown, [{ content: 'I cannot do that.' }]]);

    const result = await service.respond({ requestId: 'r1', text: 'Open the door.' }, () => undefined);

    expect(result.text).toBe('I cannot do that.');
    const toolMessage = (chats[1]?.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('no tool called open_door');
  });
});

describe('web search tool', () => {
  it('is registered under a stable id and rejects an empty query', async () => {
    const registry = new ToolRegistry();
    registry.register(createWebSearchTool(new FakeSearch()));
    expect(registry.get(WEB_SEARCH_TOOL_ID)?.toolName).toBe('web_search');
    expect(await registry.execute(WEB_SEARCH_TOOL_ID, { query: '  ' })).toMatchObject({ success: false });
  });

  it('has no provider until WEB_SEARCH_PROVIDER names one it knows', () => {
    const warn = vi.fn();
    expect(createWebSearchProvider(undefined, { warn })).toBeNull();
    expect(createWebSearchProvider('bogus', { warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
