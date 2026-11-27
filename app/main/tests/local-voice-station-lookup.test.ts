/** The conversation sees a reading station as one tool; running it makes the trip and a focused tool loop. */
import { describe, expect, it, vi } from 'vitest';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { SpeechServiceClient } from '../src/local-voice/speech-service-client.js';
import { LocalVoiceService } from '../src/local-voice/local-voice-service.js';
import { PlaceManager } from '../src/places/place-manager.js';
import { READING_ROOM_ID, StationRegistry } from '../src/stations/station-registry.js';
import { StationLookup } from '../src/stations/station-lookup.js';
import { StationTrips } from '../src/stations/station-trips.js';
import type { StationUseEvent } from '../src/shared/stations/types.js';
import { createVoiceStations } from '../src/stations/voice-stations.js';
import { ToolRegistry, type RegisteredTool } from '../src/tools/tool-registry.js';

type Delta = { content?: string; tool_calls?: unknown[] };

function sseResponse(deltas: Delta[]): Response {
  const lines = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  return new Response(new TextEncoder().encode(lines.join('') + 'data: [DONE]\n\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const call = (name: string, args: unknown): Delta => ({
  tool_calls: [
    {
      index: 0,
      id: `call_${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

function tool(name: string, overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    id: `srv-1:${name}`,
    serverId: 'srv-1',
    toolName: name,
    description: `The ${name} tool.`,
    inputSchema: { type: 'object', properties: {} },
    enabled: true,
    confirmationLevel: 'none',
    readOnly: true,
    execute: async () => `result of ${name}`,
    ...overrides,
  };
}

/** `rounds`: what the model streams for each /chat/completions request, in order. */
function setup(
  options: { rounds: Delta[][]; single?: boolean; activeRoom?: string | null } = { rounds: [] },
) {
  const chats: Array<{
    tools?: Array<{ function: { name: string } }>;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const tts: string[] = [];
  let round = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/chat/completions')) {
      chats.push(structuredClone(body) as never);
      return sseResponse(options.rounds[round++] ?? [{ content: 'Done.' }]);
    }
    if (url.endsWith('/v1/tts')) {
      tts.push(body.text as string);
      return new Response(new Uint8Array([1]), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch;

  const kv = new Map<string, string>();
  const store = {
    getValue: (key: string) => kv.get(key) ?? null,
    setValue: (key: string, value: string) => void kv.set(key, value),
  };
  const places = new PlaceManager({
    store,
    registry: { list: () => [{ id: 'echo', name: 'Echo', vrmModelId: null }] },
  });
  const registry = new StationRegistry({
    store,
    servers: () => [
      { id: 'srv-1', name: 'DAIR Academy papers', httpUrl: 'https://academy.dair.ai/api/mcp' },
      {
        id: 'srv-ha',
        name: 'Home Assistant',
        homeAssistant: true,
        httpUrl: 'https://ha.local/api/mcp',
      },
    ],
    describeRoom: async () => ({
      name: 'Reading room',
      objects: [{ id: 'bookshelf', name: 'bookshelf' }],
    }),
  });
  const events: StationUseEvent[] = [];
  const trips = new StationTrips({
    stations: registry,
    places,
    activeRoom: () => (options.activeRoom === undefined ? READING_ROOM_ID : options.activeRoom),
    send: (_avatarId, event) => (events.push(event), true),
    holdMs: 20,
  });

  const ran: string[] = [];
  const registered = new ToolRegistry();
  for (const name of ['latest_papers_of_the_week', 'search_papers', 'get_paper_content']) {
    registered.register(tool(name, { execute: async () => (ran.push(name), `result of ${name}`) }));
  }
  registered.register(tool('web_search', { id: 'builtin:web_search', serverId: 'builtin' }));
  // The Home Assistant panel holds its own tool: trip 'writes', no pursuit. It stays a tool of its own.
  registered.register(
    tool('HassTurnOn', { id: 'srv-ha:HassTurnOn', serverId: 'srv-ha', readOnly: false }),
  );
  registry.hold(
    'room:builtin:studio-flat',
    'home-panel',
    { kind: 'mcp', serverId: 'srv-ha' },
    { trip: 'writes' },
  );

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const lookup = new StationLookup({
    stations: registry,
    tools: registered,
    enabled: options.single === false ? () => false : () => true,
    logger,
  });
  const service = new LocalVoiceService({
    llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'm', fetchFn }),
    speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
    tools: registered,
    stations: createVoiceStations(registry, trips, lookup),
    logger,
  });
  return { service, chats, tts, events, ran, logger };
}

const names = (chat: { tools?: Array<{ function: { name: string } }> }): string[] =>
  (chat.tools ?? []).map((definition) => definition.function.name);

describe('a reading station as one tool', () => {
  it('offers go_to_bookshelf instead of the station tools, and keeps the others', async () => {
    const { service, chats, logger } = setup({ rounds: [[{ content: 'Hello.' }]] });
    await service.respond({ requestId: 'r1', text: 'Hi.' }, () => undefined);
    expect(names(chats[0]).sort()).toEqual(['HassTurnOn', 'go_to_bookshelf', 'web_search']);
    // The offer is logged per turn.
    expect(logger.info).toHaveBeenCalledWith(
      'Local voice: tools offered',
      expect.objectContaining({
        avatarId: 'echo',
        count: 3,
        names: expect.arrayContaining(['go_to_bookshelf', 'HassTurnOn', 'web_search']),
      }),
    );
  });

  it('offers every tool on its own when switched off', async () => {
    const { service, chats } = setup({ rounds: [[{ content: 'Hello.' }]], single: false });
    await service.respond({ requestId: 'r1', text: 'Hi.' }, () => undefined);
    expect(names(chats[0]).sort()).toEqual([
      'HassTurnOn',
      'get_paper_content',
      'latest_papers_of_the_week',
      'search_papers',
      'web_search',
    ]);
  });

  it('runs the trip and a loop with only the station tools, and speaks the summary in the conversation', async () => {
    const { service, chats, tts, events, ran, logger } = setup({
      rounds: [
        [call('go_to_bookshelf', { question: 'latest AI papers' })], // the conversation
        [call('latest_papers_of_the_week', {})], // the focused loop, round 1
        [{ content: 'Paper A https://a.example' }], // the focused loop's summary
        [{ content: 'The newest is Paper A.' }], // the conversation speaks it
      ],
    });
    const result = await service.respond(
      { requestId: 'r1', text: "What's the latest AI papers?" },
      () => undefined,
    );

    expect(result.text).toBe('The newest is Paper A.');
    expect(tts[0]).toBe('Let me check the bookshelf.');
    // The inner loop saw only the station's tools.
    expect(names(chats[1]).sort()).toEqual([
      'get_paper_content',
      'latest_papers_of_the_week',
      'search_papers',
    ]);
    expect(ran).toEqual(['latest_papers_of_the_week']);
    // The conversation model got the summary as the tool result.
    const toolMessage = chats[3].messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toBe('Paper A https://a.example');
    // The walk: start and end, as for any station tool.
    expect(events.map((event) => event.phase)).toEqual(['start', 'end']);
    expect(events[0]).toMatchObject({ avatarId: 'echo', objectId: 'bookshelf' });
    expect(events[0].source).toBeUndefined();
    expect(events[1]).toMatchObject({ ok: true });
    // The call is logged, as is the inner one.
    expect(logger.info).toHaveBeenCalledWith(
      'Local voice: tool call',
      expect.objectContaining({
        avatarId: 'echo',
        name: 'go_to_bookshelf',
        ok: true,
        args: '{"question":"latest AI papers"}',
        resultLength: 25,
        durationMs: expect.any(Number),
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Stations: lookup tool call',
      expect.objectContaining({ tool: 'latest_papers_of_the_week', ok: true }),
    );
  });

  it('still answers when the small model calls no tool inside the lookup', async () => {
    const { service, chats, ran } = setup({
      rounds: [
        [call('go_to_bookshelf', { question: 'latest AI papers' })],
        [{ content: '2-2-2' }], // the focused loop ignores its tools
        [{ content: 'Latest issue: Paper B.' }], // summary of the default call
        [{ content: 'Paper B is new.' }],
      ],
    });
    const result = await service.respond(
      { requestId: 'r1', text: 'Latest AI papers?' },
      () => undefined,
    );
    expect(ran).toEqual(['latest_papers_of_the_week']);
    expect(chats[3].messages.find((message) => message.role === 'tool')?.content).toBe(
      'Latest issue: Paper B.',
    );
    expect(result.text).toBe('Paper B is new.');
  });

  it('writes a warning line for a failed call', async () => {
    const { service, logger } = setup({
      rounds: [[call('nothing_here', {})], [{ content: 'I could not.' }]],
    });
    await service.respond({ requestId: 'r1', text: 'Hi.' }, () => undefined);
    expect(logger.warn).toHaveBeenCalledWith(
      'Local voice: tool call',
      expect.objectContaining({
        name: 'nothing_here',
        ok: false,
        error: expect.stringContaining('no tool called'),
      }),
    );
  });
});

describe('runaway output', () => {
  const runaway = (): Delta[] => Array.from({ length: 150 }, () => ({ content: '2-' }));

  it('stops a "2-2-2-..." reply, speaks a short line instead and keeps it out of the history', async () => {
    const { service, chats, tts, logger } = setup({ rounds: [runaway(), [{ content: 'Fine.' }]] });
    const events: string[] = [];
    const result = await service.respond(
      { requestId: 'r1', text: 'Tell me something.' },
      (event) => {
        if (event.type === 'sentence') events.push(event.text);
      },
    );
    expect(events).toEqual(['Sorry, I lost my train of thought.']);
    expect(tts).toEqual(['Sorry, I lost my train of thought.']);
    expect(result.text).toBe('Sorry, I lost my train of thought.');
    expect(logger.warn).toHaveBeenCalledWith(
      'Local voice: runaway output stopped',
      expect.objectContaining({ requestId: 'r1' }),
    );

    // The next turn's history has the question but neither the garbage nor the fallback line.
    await service.respond({ requestId: 'r2', text: 'Again.' }, () => undefined);
    const sent = chats[1].messages.map((message) => message.content).join('\n');
    expect(sent).toContain('Tell me something.');
    expect(sent).not.toContain('2-2-2');
    expect(sent).not.toContain('lost my train');
  });
});
