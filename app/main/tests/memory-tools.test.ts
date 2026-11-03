import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryTools,
  describeAgo,
  formatSearchResults,
  MEMORY_TOOL_IDS,
  parsePeriod,
  type MemoryEngineMemoryDetail,
  type MemoryEngineSearchResult,
  type MemoryEngineTimeline,
  type OutboxItem,
} from '../src/memory-engine/index.js';

// Tuesday 3 November 2026, 15:30 local time.
const NOW = new Date(2026, 10, 3, 15, 30);

function local(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day);
}

describe('parsePeriod', () => {
  it.each([
    ['today', local(2026, 11, 3), local(2026, 11, 4)],
    ['yesterday', local(2026, 11, 2), local(2026, 11, 3)],
    ['this week', local(2026, 11, 2), local(2026, 11, 9)],
    ['last week', local(2026, 10, 26), local(2026, 11, 2)],
    ['last month', local(2026, 10, 1), local(2026, 11, 1)],
    ['in March', local(2026, 3, 1), local(2026, 4, 1)],
    ['december', local(2025, 12, 1), local(2026, 1, 1)],
    ['march 2025', local(2025, 3, 1), local(2025, 4, 1)],
    ['3 weeks ago', local(2026, 10, 12), local(2026, 10, 19)],
    ['a couple of days ago', local(2026, 11, 1), local(2026, 11, 2)],
    ['the last 10 days', local(2026, 10, 24), local(2026, 11, 4)],
    ['last tuesday', local(2026, 10, 27), local(2026, 10, 28)],
    ['monday', local(2026, 11, 2), local(2026, 11, 3)],
    ['2026-10-14', local(2026, 10, 14), local(2026, 10, 15)],
    ['2026-10', local(2026, 10, 1), local(2026, 11, 1)],
    ['2026-10-01 to 2026-10-03', local(2026, 10, 1), local(2026, 10, 4)],
  ])('reads %s', (input, from, to) => {
    expect(parsePeriod(input, NOW)).toEqual({ from, to });
  });

  it('gives null for what it cannot read', () => {
    expect(parsePeriod('', NOW)).toBeNull();
    expect(parsePeriod('when the moon was blue', NOW)).toBeNull();
  });
});

describe('describeAgo', () => {
  it('says roughly how long ago', () => {
    expect(describeAgo(new Date(2026, 10, 3, 9), NOW)).toBe('today');
    expect(describeAgo(local(2026, 11, 2), NOW)).toBe('yesterday');
    expect(describeAgo(local(2026, 10, 29), NOW)).toBe('5 days ago');
    expect(describeAgo(local(2026, 10, 6), NOW)).toBe('4 weeks ago');
    expect(describeAgo(local(2026, 6, 3), NOW)).toBe('5 months ago');
    expect(describeAgo(local(2025, 10, 30), NOW)).toBe('a year ago');
  });
});

function result(overrides: Partial<MemoryEngineSearchResult> = {}): MemoryEngineSearchResult {
  return {
    id: 'r1',
    kind: 'turn',
    source_id: 's1',
    session_id: 'sess',
    agent: 'Echo',
    period_start: local(2026, 11, 1).toISOString(),
    period_end: local(2026, 11, 1).toISOString(),
    text: 'Kevin: the tomatoes are in\nEcho: lovely',
    score: 1,
    private: false,
    ...overrides,
  };
}

function makeTools() {
  const client = {
    search: vi.fn(async () => [result()]),
    timeline: vi.fn(async (): Promise<MemoryEngineTimeline> => ({
      summaries: [],
      sessions: [
        {
          session_id: 'sess',
          agent: 'Echo',
          channel: 'voice',
          title: null,
          started_at: new Date(2026, 10, 2, 9).toISOString(),
          last_at: new Date(2026, 10, 2, 9, 10).toISOString(),
          message_count: 4,
          turns: [{ id: 't1', at: new Date(2026, 10, 2, 9).toISOString(), text: 'Kevin: hi\nEcho: hello' }],
        },
      ],
    })),
    memory: vi.fn(async (): Promise<MemoryEngineMemoryDetail> => ({
      id: 't1',
      kind: 'turn',
      period_start: new Date(2026, 10, 2, 9).toISOString(),
      agent: 'Echo',
      messages: [
        { id: 'm1', role: 'user', speaker: null, content: 'hi', tool: null, created_at: new Date(2026, 10, 2, 9).toISOString() },
        { id: 'm2', role: 'assistant', speaker: null, content: 'hello', tool: null, created_at: new Date(2026, 10, 2, 9, 1).toISOString() },
      ],
    })),
  };
  const queued: OutboxItem[] = [];
  const tools = createMemoryTools({
    client,
    outbox: { enqueue: (item) => queued.push(item) },
    currentSessionId: () => 'sess',
    agentName: () => 'Echo',
    now: () => NOW,
  });
  const byId = Object.fromEntries(tools.map((tool) => [tool.id, tool]));
  return { client, queued, byId };
}

describe('memory tools', () => {
  it('offers four tools the voice can use without a confirmation', () => {
    const { byId } = makeTools();
    expect(Object.keys(byId).sort()).toEqual(Object.values(MEMORY_TOOL_IDS).sort());
    for (const tool of Object.values(byId)) {
      expect(['none', 'notify']).toContain(tool.confirmationLevel);
    }
  });

  it('recall_memories passes the query and period to the engine', async () => {
    const { client, byId } = makeTools();
    const text = await byId[MEMORY_TOOL_IDS.recall].execute({ query: 'tomatoes', subject: 'garden', period: 'last week' });
    expect(client.search).toHaveBeenCalledWith('tomatoes garden', {
      from: local(2026, 10, 26).toISOString(),
      to: local(2026, 11, 2).toISOString(),
      limit: 6,
    });
    expect(text).toContain('[r1]');
    expect(text).toContain('2 days ago');
    expect(text).toContain('with Echo');
  });

  it('explains a period it cannot read instead of searching', async () => {
    const { client, byId } = makeTools();
    const text = await byId[MEMORY_TOOL_IDS.recall].execute({ query: 'x', period: 'the other day-ish thing' });
    expect(text).toMatch(/could not read that period/);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('recall_timeline lists conversations in the period', async () => {
    const { client, byId } = makeTools();
    const text = await byId[MEMORY_TOOL_IDS.timeline].execute({ period: 'yesterday' });
    expect(client.timeline).toHaveBeenCalledWith(local(2026, 11, 2).toISOString(), local(2026, 11, 3).toISOString());
    expect(text).toContain('4 messages');
    expect(text).toContain('[t1] Kevin: hi / Echo: hello');
  });

  it('open_memory reads a memory in full, accepting the id in brackets', async () => {
    const { client, byId } = makeTools();
    const text = await byId[MEMORY_TOOL_IDS.open].execute({ id: '[t1]' });
    expect(client.memory).toHaveBeenCalledWith('t1', 1);
    expect(text).toContain('User: hi');
    expect(text).toContain('Echo: hello');
  });

  it('remember queues a fact linked to the conversation', async () => {
    const { queued, byId } = makeTools();
    expect(await byId[MEMORY_TOOL_IDS.remember].execute({ fact: 'Kevin prefers wslc', subject: 'tools' })).toBe('Saved.');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: 'fact',
      fact: { text: 'Kevin prefers wslc', subject: 'tools', author: 'agent', agent: 'Echo', session_id: 'sess' },
    });
  });

  it('uses summaries in the timeline once they exist', async () => {
    const { client, byId } = makeTools();
    client.timeline.mockResolvedValueOnce({
      summaries: [
        { id: 'd1', kind: 'day', period_start: local(2026, 10, 27).toISOString(), period_end: local(2026, 10, 28).toISOString(),
          title: 'Garden day', text: 'The user planted tomatoes.', topics: ['garden'] },
      ],
      sessions: [
        {
          session_id: 's', agent: 'Echo', channel: 'voice', title: null,
          started_at: new Date(2026, 9, 27, 9).toISOString(), last_at: new Date(2026, 9, 27, 9, 5).toISOString(),
          message_count: 6,
          summary: { id: 'x1', title: 'Tomatoes', text: 'They talked about planting tomatoes.', topics: [] },
          turns: [{ id: 't9', at: new Date(2026, 9, 27, 9).toISOString(), text: 'User: hi' }],
        },
      ],
    });
    const text = await byId[MEMORY_TOOL_IDS.timeline].execute({ period: 'last week' });
    expect(text).toContain('[d1] Tue, 27 Oct 2026: Garden day. The user planted tomatoes.');
    expect(text).toContain('Echo "Tomatoes", 6 messages:');
    expect(text).toContain('[x1] They talked about planting tomatoes.');
    expect(text).not.toContain('[t9]');
  });

  it('labels summaries in search results and opens them', async () => {
    const { client, byId } = makeTools();
    client.search.mockResolvedValueOnce([result({ id: 'w1', kind: 'week', agent: null, text: 'A busy week.' })]);
    expect(await byId[MEMORY_TOOL_IDS.recall].execute({ query: 'week' })).toContain('summary of the week:');
    client.memory.mockResolvedValueOnce({ id: 'w1', kind: 'week', period_start: local(2026, 10, 26).toISOString(), text: 'A busy week.' });
    expect(await byId[MEMORY_TOOL_IDS.open].execute({ id: 'w1' })).toMatch(/^Summary of the week, .*: A busy week\.$/);
  });

  it('caps long results', () => {
    const many = Array.from({ length: 40 }, (_, i) => result({ id: `r${i}`, text: 'x'.repeat(400) }));
    const text = formatSearchResults(many, NOW);
    expect(text.length).toBeLessThan(6200);
    expect(text).toContain('more not shown');
  });
});
