import { describe, expect, it, vi } from 'vitest';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { SpeechServiceClient } from '../src/local-voice/speech-service-client.js';
import { LocalVoiceService, TOOL_GUIDANCE } from '../src/local-voice/local-voice-service.js';
import type { LocalVoiceEvent } from '../src/local-voice/types.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import {
  BraveSearchProvider,
  DEFAULT_WEB_SEARCH_PROVIDER,
  DEFAULT_SEARXNG_URL,
  FallbackSearchProvider,
  SearxngSearchProvider,
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

  it('has no provider until WEB_SEARCH_PROVIDER names one it can use', () => {
    const warn = vi.fn();
    expect(createWebSearchProvider(undefined, {}, { warn })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(createWebSearchProvider('bogus', {}, { warn })).toBeNull();
    // brave without a key is skipped rather than failing on every search.
    expect(createWebSearchProvider('brave', {}, { warn })).toBeNull();
    expect(createWebSearchProvider('searxng', {})?.name).toBe('searxng');
    expect(createWebSearchProvider('brave', { braveApiKey: 'k' })?.name).toBe('brave');
    expect(createWebSearchProvider(' SearXNG , brave ', { braveApiKey: 'k' })?.name).toBe('searxng,brave');
    expect(createWebSearchProvider('searxng,brave', {}, { warn })?.name).toBe('searxng');
  });
});

function jsonFetch(status: number, body: unknown) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe('SearXNG provider', () => {
  it('queries the JSON API and maps results', async () => {
    const fetchFn = jsonFetch(200, {
      results: [
        { title: 'Canberra weather', url: 'https://bom.gov.au/act', content: 'Sunny, 24 &amp; clear' },
        { title: 'No url' },
        { title: 'Two', url: 'https://example.com/2' },
        { title: 'Three', url: 'https://example.com/3', content: 'x' },
      ],
    });
    const provider = new SearxngSearchProvider('http://127.0.0.1:8888/', fetchFn);

    const results = await provider.search('canberra weather', { limit: 2 });

    const url = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:8888/search');
    expect(url.searchParams.get('q')).toBe('canberra weather');
    expect(url.searchParams.get('format')).toBe('json');
    expect(results).toEqual([
      { title: 'Canberra weather', url: 'https://bom.gov.au/act', snippet: 'Sunny, 24 & clear' },
      { title: 'Two', url: 'https://example.com/2', snippet: '' },
    ]);
  });

  it('explains a 403 as JSON output being switched off', async () => {
    const provider = new SearxngSearchProvider(DEFAULT_SEARXNG_URL, jsonFetch(403, {}));
    await expect(provider.search('q', { limit: 5 })).rejects.toThrow(/search\.formats/);
  });
});

describe('Brave provider', () => {
  it('sends the token, asks for the limit and strips highlight markup', async () => {
    const fetchFn = jsonFetch(200, {
      web: { results: [{ title: 'Brave <strong>Search</strong>', url: 'https://brave.com', description: 'A <strong>private</strong> index' }] },
    });
    const provider = new BraveSearchProvider('token-1', fetchFn);

    const results = await provider.search('brave', { limit: 5 });

    const [input, init] = fetchFn.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('count')).toBe('5');
    expect((init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('token-1');
    expect(results).toEqual([{ title: 'Brave Search', url: 'https://brave.com', snippet: 'A private index' }]);
  });

  it('leaves no markup behind, even nested or escaped', async () => {
    const fetchFn = jsonFetch(200, {
      web: { results: [{ title: 'a<scr<b>ipt>b', url: 'https://x.test', description: '&lt;b&gt;bold&lt;/b&gt; 1 &lt; 2' }] },
    });
    const [result] = await new BraveSearchProvider('k', fetchFn).search('q', { limit: 5 });
    expect(result).toMatchObject({ title: 'ab', snippet: 'bold 1  2' });
  });

  it('reports a bad key and an exhausted quota plainly', async () => {
    await expect(new BraveSearchProvider('bad', jsonFetch(401, {})).search('q', { limit: 5 })).rejects.toThrow(
      /BRAVE_SEARCH_API_KEY/,
    );
    await expect(new BraveSearchProvider('k', jsonFetch(429, {})).search('q', { limit: 5 })).rejects.toThrow(/quota/);
  });
});

describe('fallback search', () => {
  const hit = { title: 'T', url: 'https://example.com', snippet: 's' };
  const provider = (name: string, search: WebSearchProvider['search']): WebSearchProvider => ({ name, search });

  it('moves on when a provider fails or finds nothing, and stops at the first with results', async () => {
    const third = vi.fn(async () => [hit]);
    const chain = new FallbackSearchProvider([
      provider('down', async () => {
        throw new Error('down');
      }),
      provider('empty', async () => []),
      provider('brave', async () => [hit]),
      provider('never', third),
    ]);
    expect(await chain.search('q', { limit: 5 })).toEqual([hit]);
    expect(third).not.toHaveBeenCalled();
  });

  it('gives a hung provider only its slice of time before trying the next', async () => {
    const hung = provider(
      'hung',
      (_query, options) =>
        new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason))),
    );
    const chain = new FallbackSearchProvider([hung, provider('brave', async () => [hit])], 20);
    expect(await chain.search('q', { limit: 5 })).toEqual([hit]);
  });

  it('reports the last error when every provider fails', async () => {
    const chain = new FallbackSearchProvider([
      provider('a', async () => {
        throw new Error('first');
      }),
      provider('b', async () => {
        throw new Error('second');
      }),
    ]);
    await expect(chain.search('q', { limit: 5 })).rejects.toThrow('second');
  });
});

describe('web search defaults and failures', () => {
  it('uses SearXNG unless WEB_SEARCH_PROVIDER is off', () => {
    expect(DEFAULT_WEB_SEARCH_PROVIDER).toBe('searxng');
    expect(createWebSearchProvider('off')).toBeNull();
    expect(createWebSearchProvider(' None ')).toBeNull();
  });

  it('tells the model plainly when SearXNG cannot be reached or is too slow', async () => {
    const refused = new SearxngSearchProvider('http://127.0.0.1:8888', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await expect(refused.search('q', { limit: 5 })).rejects.toThrow(
      'Web search is unavailable: could not reach SearXNG at http://127.0.0.1:8888 (fetch failed).',
    );

    const slow = new SearxngSearchProvider('http://127.0.0.1:8888', (_input, init) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    await expect(slow.search('q', { limit: 5, signal: AbortSignal.timeout(10) })).rejects.toThrow(/did not answer in time/);
  });
});
