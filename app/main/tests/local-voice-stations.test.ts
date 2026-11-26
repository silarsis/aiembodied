import { describe, expect, it, vi } from 'vitest';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { SpeechServiceClient } from '../src/local-voice/speech-service-client.js';
import { LocalVoiceService } from '../src/local-voice/local-voice-service.js';
import { PlaceManager } from '../src/places/place-manager.js';
import { READING_ROOM_ID, StationRegistry } from '../src/stations/station-registry.js';
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

const papersCall: Delta[] = [
  {
    tool_calls: [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'search_papers', arguments: '{"topic":"agents"}' },
      },
    ],
  },
];

function setup(
  options: {
    activeRoom?: string | null;
    holdMs?: number;
    toolDelayMs?: number;
    avatarId?: string;
  } = {},
) {
  const chats: Array<Record<string, unknown>> = [];
  const tts: string[] = [];
  let round = 0;
  const rounds: Delta[][] = [papersCall, [{ content: 'I found three papers.' }]];
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

  const kv = new Map<string, string>();
  const store = {
    getValue: (key: string) => kv.get(key) ?? null,
    setValue: (key: string, value: string) => void kv.set(key, value),
  };
  const places = new PlaceManager({
    store,
    registry: {
      list: () => [
        { id: 'echo', name: 'Echo', vrmModelId: null },
        { id: 'sage', name: 'Sage', vrmModelId: null },
      ],
    },
  });
  const registry = new StationRegistry({
    store,
    servers: () => [{ id: 'srv-1', httpUrl: 'https://academy.dair.ai/api/mcp' }],
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
    holdMs: options.holdMs ?? 6000,
  });

  const ran: number[] = [];
  const tool: RegisteredTool = {
    id: 'srv-1:search_papers',
    serverId: 'srv-1',
    toolName: 'search_papers',
    description: 'Search the paper library.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
    enabled: true,
    confirmationLevel: 'none',
    readOnly: true,
    execute: async () => {
      ran.push(Date.now());
      if (options.toolDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.toolDelayMs));
      return 'three papers';
    },
  };
  const tools = new ToolRegistry();
  tools.register(tool);
  const service = new LocalVoiceService({
    avatarId: options.avatarId ?? 'echo',
    llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'm', fetchFn }),
    speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
    tools,
    stations: createVoiceStations(registry, trips),
  });
  return { service, chats, tts, events, trips, tool, ran };
}

/** Polls until the condition holds (real timers; the voice turn runs on streams and promises). */
async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('LocalVoiceService with stations', () => {
  it('adds where the tool is kept to the description the model sees, and says a notice', async () => {
    const { service, chats, tts, tool, events } = setup({ holdMs: 20 });
    await service.respond({ requestId: 'r1', text: 'Find papers on agents.' }, () => undefined);
    const offered = chats[0].tools as Array<{ function: { name: string; description: string } }>;
    expect(offered[0].function.description).toBe(
      'Search the paper library. (kept on the bookshelf in the Reading room)',
    );
    // The stored description is untouched.
    expect(tool.description).toBe('Search the paper library.');
    expect(tts[0]).toBe('Let me check the bookshelf.');
    expect(events.map((event) => event.phase)).toEqual(['start', 'end']);
  });

  it('starts the tool at once and holds the answer until the avatar arrived', async () => {
    const { service, chats, events, trips, ran } = setup();
    const turn = service.respond({ requestId: 'r1', text: 'Find papers.' }, () => undefined);
    await until(() => events.length > 0);
    // The walk was announced, and the tool did not wait for it.
    expect(events[0]).toMatchObject({ avatarId: 'echo', phase: 'start', objectId: 'bookshelf' });
    await until(() => ran.length > 0);
    // The tool has returned, but the model is not asked again until the avatar is at the shelf.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(chats).toHaveLength(1);

    trips.arrived(events[0].useId);
    const result = await turn;
    expect(chats).toHaveLength(2);
    expect(result.text).toBe('I found three papers.');
    expect(events.at(-1)).toMatchObject({ phase: 'end', ok: true });
  });

  it('goes on without the arrival once the cap is reached', async () => {
    const { service, chats, events } = setup({ holdMs: 40 });
    const started = Date.now();
    await service.respond({ requestId: 'r1', text: 'Find papers.' }, () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(chats).toHaveLength(2);
    expect(events.map((event) => event.phase)).toEqual(['start', 'end']);
  });

  it('does not wait, and sends nothing, with no 3D room', async () => {
    const { service, chats, events, tts } = setup({ activeRoom: 'builtin:garden', holdMs: 60_000 });
    await service.respond({ requestId: 'r1', text: 'Find papers.' }, () => undefined);
    expect(events).toEqual([]);
    expect(chats).toHaveLength(2);
    // The station still words the notice.
    expect(tts[0]).toBe('Let me check the bookshelf.');
  });

  it('attributes the trip to the avatar whose voice service runs the tool', async () => {
    const { service, events } = setup({ avatarId: 'sage', holdMs: 20 });
    await service.respond({ requestId: 'r1', text: 'Find papers.' }, () => undefined);
    expect(events[0]).toMatchObject({ avatarId: 'sage' });
  });
});
