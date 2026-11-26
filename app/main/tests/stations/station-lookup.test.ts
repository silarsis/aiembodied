import { describe, expect, it, vi } from 'vitest';
import { LOOKUP_MAX_TOOL_CALLS, StationLookup, defaultLookupTool, lookupToolName } from '../../src/stations/station-lookup.js';
import type { Station } from '../../src/shared/stations/types.js';
import type { RegisteredTool } from '../../src/tools/tool-registry.js';
import { FakeChat, executorFor, libraryTool, type Reply, type SeenCall } from '../pursuits/fakes.js';

const bookshelf: Station = {
  id: 'default:bookshelf',
  roomId: 'room:builtin:reading-room',
  objectId: 'bookshelf',
  source: { kind: 'mcp', serverId: 'srv-1', preset: 'dair-academy-papers' },
  verb: 'read',
  activity: 'pulls a book from the shelf and reads',
  trip: 'all',
  characters: 'all',
};
const panel: Station = {
  id: 'default:home-assistant',
  roomId: 'room:builtin:studio-flat',
  objectId: 'home-panel',
  source: { kind: 'mcp', serverId: 'srv-ha' },
  verb: 'use',
  activity: 'taps at the home panel',
  trip: 'writes',
  characters: 'all',
  pursuit: 'none',
};

const DAIR_NAMES = [
  'papers_of_the_week_info',
  'list_papers_of_the_week_issues',
  'get_papers_of_the_week_issue',
  'latest_papers_of_the_week',
  'search_papers_of_the_week',
  'papers_of_the_week_tags',
  'list_paper_collections',
  'get_paper_collection',
  'search_papers',
  'discover_papers',
  'get_paper_content',
  'search_paper_content',
];

function setup(options: { enabled?: boolean; respond?: (call: SeenCall, index: number) => Reply; timeoutMs?: number } = {}) {
  const ran: Array<{ name: string; params: unknown }> = [];
  const dair = DAIR_NAMES.map((name) =>
    libraryTool(name, (params) => (ran.push({ name, params }), `result of ${name}`), {
      inputSchema: name.startsWith('search') ? { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } : { type: 'object', properties: {} },
    }),
  );
  const others: RegisteredTool[] = [
    libraryTool('memory_recall', () => 'm', { id: 'builtin:memory_recall', serverId: 'builtin' }),
    libraryTool('web_search', () => 'w', { id: 'builtin:web_search', serverId: 'builtin' }),
    libraryTool('HassTurnOn', () => 'on', { id: 'srv-ha:HassTurnOn', serverId: 'srv-ha', readOnly: false }),
  ];
  const all = [...dair, ...others];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const chat = new FakeChat(options.respond ?? (() => ({ text: 'nothing' })));
  const execute = vi.fn(executorFor(all));
  const lookup = new StationLookup({
    stations: {
      stationForTool: (tool) => {
        const serverId = typeof tool === 'string' ? tool : tool.serverId;
        return serverId === 'srv-1' ? bookshelf : serverId === 'srv-ha' ? panel : null;
      },
      labelsFor: (station) => (station === bookshelf ? { roomName: 'Reading room', objectName: 'bookshelf' } : { roomName: 'Studio flat', objectName: 'home panel' }),
      serverNameFor: (station) => (station === bookshelf ? 'DAIR Academy papers' : 'Home Assistant'),
    },
    tools: { execute },
    enabled: options.enabled === undefined ? undefined : () => options.enabled === true,
    timeoutMs: options.timeoutMs,
    logger,
  });
  return { lookup, all, dair, chat, logger, ran, execute };
}

describe('StationLookup.offer', () => {
  it('replaces the station tools with one go_to_bookshelf tool and leaves the rest alone', () => {
    const { lookup, all } = setup();
    const offered = lookup.offer(all);
    const names = offered.map((tool) => tool.toolName);
    expect(names).toEqual(['memory_recall', 'web_search', 'HassTurnOn', 'go_to_bookshelf']);
    for (const name of DAIR_NAMES) expect(names).not.toContain(name);

    const tool = offered.find((candidate) => candidate.toolName === 'go_to_bookshelf')!;
    expect(lookup.isLookup(tool)).toBe(true);
    expect(tool.readOnly).toBe(true);
    expect(tool.spokenNotice).toBe('Let me check the bookshelf.');
    expect(tool.inputSchema).toMatchObject({ properties: { question: { type: 'string' } }, required: ['question'] });
    // Built from the object, room, verb, server and tool names, so the model knows when to use it.
    expect(tool.description).toContain('bookshelf');
    expect(tool.description).toContain('Reading room');
    expect(tool.description).toContain('DAIR Academy papers');
    expect(tool.description).toContain('read');
    expect(tool.description).toContain('latest papers of the week');
    expect(tool.description).toContain('AI research papers');
    // It is a station tool as far as the trip code can tell: the server id is the library's.
    expect(tool.serverId).toBe('srv-1');
    // The caller's own list is not changed.
    expect(all).toHaveLength(15);
  });

  it('leaves tools of a writes-only station without a pursuit (Home Assistant) as they are', () => {
    const { lookup, all } = setup();
    const offered = lookup.offer(all);
    expect(offered.some((tool) => tool.toolName === 'HassTurnOn')).toBe(true);
    expect(offered.filter((tool) => lookup.isLookup(tool))).toHaveLength(1);
  });

  it('offers everything on its own when switched off', () => {
    const { lookup, all } = setup({ enabled: false });
    expect(lookup.offer(all)).toBe(all);
  });

  it('is switched off by STATION_SINGLE_TOOL=0 and on otherwise', () => {
    const { lookup, all } = setup();
    const lookupFromEnv = new StationLookup({
      stations: { stationForTool: () => null, labelsFor: () => ({ roomName: '', objectName: '' }), serverNameFor: () => null },
      tools: { execute: vi.fn() },
    });
    const before = process.env.STATION_SINGLE_TOOL;
    try {
      process.env.STATION_SINGLE_TOOL = '0';
      expect(lookup.offer(all)).toHaveLength(15);
      delete process.env.STATION_SINGLE_TOOL;
      expect(lookup.offer(all)).toHaveLength(4);
      expect(lookupFromEnv.offer(all)).toBe(all);
    } finally {
      if (before === undefined) delete process.env.STATION_SINGLE_TOOL;
      else process.env.STATION_SINGLE_TOOL = before;
    }
  });

  it('keeps a tool that needs approval on its own', () => {
    const { lookup, all } = setup();
    all.find((tool) => tool.toolName === 'get_paper_content')!.confirmationLevel = 'confirm';
    const names = lookup.offer(all).map((tool) => tool.toolName);
    expect(names).toContain('get_paper_content');
    expect(names).toContain('go_to_bookshelf');
    expect(names).not.toContain('search_papers');
  });
});

describe('lookupToolName', () => {
  it('sanitises the object id and makes the name unique', () => {
    expect(lookupToolName('bookshelf', new Set())).toBe('go_to_bookshelf');
    expect(lookupToolName('Book-Shelf #1', new Set())).toBe('go_to_book_shelf_1');
    expect(lookupToolName('bookshelf', new Set(['go_to_bookshelf']))).toBe('go_to_bookshelf_2');
    expect(lookupToolName('!!!', new Set())).toBe('go_to_station');
  });

  it('avoids the name of another tool', () => {
    const { lookup, all } = setup();
    const clash = libraryTool('go_to_bookshelf', () => 'x', { id: 'builtin:go_to_bookshelf', serverId: 'builtin' });
    expect(lookup.offer([...all, clash]).map((tool) => tool.toolName)).toContain('go_to_bookshelf_2');
  });
});

describe('defaultLookupTool', () => {
  it('prefers latest*, then list*, and skips tools that need arguments', () => {
    const { dair } = setup();
    expect(defaultLookupTool(dair)?.toolName).toBe('latest_papers_of_the_week');
    expect(defaultLookupTool(dair.filter((tool) => tool.toolName !== 'latest_papers_of_the_week'))?.toolName).toBe('list_papers_of_the_week_issues');
    expect(defaultLookupTool(dair.filter((tool) => tool.toolName.startsWith('search')))).toBeNull();
  });
});

describe('StationLookup.run', () => {
  const abort = () => new AbortController().signal;

  it('runs a focused loop with only the station tools and returns the summary', async () => {
    const { lookup, all, chat, logger, ran } = setup({
      respond: (call, index) => (index === 0 ? { calls: [{ name: 'search_papers', arguments: { query: 'agents' } }] } : { text: 'Paper A https://a.example' }),
    });
    const tool = lookup.offer(all).find((candidate) => lookup.isLookup(candidate))!;
    const answer = await lookup.run('echo', tool, { question: 'latest AI papers' }, { chat, signal: abort() });

    expect(answer).toBe('Paper A https://a.example');
    // Only the 12 library tools were offered (the model has several rounds; only the last offers none).
    expect(chat.seen[0].tools.map((definition) => definition.function.name)).toEqual(DAIR_NAMES);
    expect(chat.seen[1].tools.map((definition) => definition.function.name)).toEqual(DAIR_NAMES);
    expect(chat.userAt(0)).toContain('latest AI papers');
    expect(ran).toEqual([{ name: 'search_papers', params: { query: 'agents' } }]);
    // The inner call is logged, without anything but what the model sent.
    expect(logger.info).toHaveBeenCalledWith('Stations: lookup tool call', expect.objectContaining({ avatarId: 'echo', tool: 'search_papers', ok: true, args: '{"query":"agents"}' }));
    expect(logger.info).toHaveBeenCalledWith('Stations: lookup end', expect.objectContaining({ toolCalls: 1, ok: true }));
  });

  it('makes the default call itself when the model calls no tool', async () => {
    const { lookup, all, chat, ran, logger } = setup({
      // Round 1: chatter, no tool. Then the summary of what the default call returned.
      respond: (call, index) => (index === 0 ? { text: '2 2 2' } : { text: 'This week: the latest papers.' }),
    });
    const tool = lookup.offer(all).find((candidate) => lookup.isLookup(candidate))!;
    const answer = await lookup.run('echo', tool, { question: 'latest AI papers' }, { chat, signal: abort() });

    expect(ran).toEqual([{ name: 'latest_papers_of_the_week', params: {} }]);
    expect(answer).toBe('This week: the latest papers.');
    expect(chat.userAt(1)).toContain('result of latest_papers_of_the_week');
    expect(logger.info).toHaveBeenCalledWith('Stations: lookup made no tool call', expect.objectContaining({ fallback: 'latest_papers_of_the_week' }));
  });

  it('returns the raw result when the model also fails to summarise the fallback call', async () => {
    const { lookup, all, chat } = setup({ respond: () => ({ text: '' }) });
    const tool = lookup.offer(all).find((candidate) => lookup.isLookup(candidate))!;
    const answer = await lookup.run('echo', tool, { question: 'anything' }, { chat, signal: abort() });
    expect(answer).toBe('result of latest_papers_of_the_week');
  });

  it('is never empty, even when there is nothing to call', async () => {
    const { lookup, all, chat } = setup({ respond: () => ({ text: '' }) });
    // Only tools that need arguments: no default call exists.
    const onlySearch = all.filter((candidate) => candidate.serverId !== 'srv-1' || candidate.toolName.startsWith('search'));
    const tool = lookup.offer(onlySearch).find((candidate) => lookup.isLookup(candidate))!;
    const answer = await lookup.run('echo', tool, {}, { chat, signal: abort() });
    expect(answer).toContain('bookshelf');
  });

  it('stops calling tools after the limit', async () => {
    const { lookup, all, chat, ran } = setup({ respond: () => ({ calls: [{ name: 'latest_papers_of_the_week' }, { name: 'latest_papers_of_the_week' }, { name: 'latest_papers_of_the_week' }] }) });
    const tool = lookup.offer(all).find((candidate) => lookup.isLookup(candidate))!;
    await lookup.run('echo', tool, { question: 'x' }, { chat, signal: abort() });
    expect(ran.length).toBe(LOOKUP_MAX_TOOL_CALLS);
  });

  it('reports a failing tool instead of throwing', async () => {
    const { lookup, all, chat, execute } = setup({ respond: (_call, index) => (index === 0 ? { calls: [{ name: 'latest_papers_of_the_week' }] } : { text: '' }) });
    execute.mockResolvedValue({ success: false, error: 'not signed in', durationMs: 1 });
    const tool = lookup.offer(all).find((candidate) => lookup.isLookup(candidate))!;
    const answer = await lookup.run('echo', tool, { question: 'x' }, { chat, signal: abort() });
    expect(answer).toContain('not signed in');
  });

  it('rethrows when the turn is cancelled', async () => {
    const { lookup, all, chat } = setup({ respond: () => ({ text: 'x' }) });
    const tool = lookup.offer(all).find((candidate) => lookup.isLookup(candidate))!;
    const controller = new AbortController();
    controller.abort();
    await expect(lookup.run('echo', tool, { question: 'x' }, { chat, signal: controller.signal })).rejects.toBeDefined();
  });
});
