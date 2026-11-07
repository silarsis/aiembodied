import { describe, expect, it, vi } from 'vitest';
import {
  createVoiceMemory,
  formatBrief,
  type MemoryEngineBrief,
  type MemoryEngineRecall,
} from '../src/memory-engine/index.js';

const NOW = new Date(2026, 10, 3, 19, 15);

const BRIEF: MemoryEngineBrief = {
  agent: 'Echo',
  facts: [{ id: 'f1', text: "Kevin's partner is Erika", subject: null, pinned: true, created_at: NOW.toISOString() }],
  last_session: {
    session_id: 's0',
    agent: 'Echo',
    channel: 'voice',
    title: null,
    started_at: new Date(2026, 10, 1, 9).toISOString(),
    last_at: new Date(2026, 10, 1, 9, 30).toISOString(),
    turns: ['User: the greenhouse door is broken\nEcho: I will remind you.'],
  },
};

function makeClient(overrides: { brief?: () => Promise<MemoryEngineBrief>; recall?: () => Promise<MemoryEngineRecall> } = {}) {
  return {
    brief: vi.fn(overrides.brief ?? (async () => BRIEF)),
    recall: vi.fn(overrides.recall ?? (async (): Promise<MemoryEngineRecall> => ({ items: [], reason: 'no strong match' }))),
  };
}

describe('voice memory', () => {
  it('builds the brief from the time, saved facts and the last conversation', async () => {
    const client = makeClient();
    const memory = createVoiceMemory({ client, currentSessionId: () => 's1', agentName: () => 'Echo', now: () => NOW });
    const brief = await memory.brief();
    expect(client.brief).toHaveBeenCalledWith({ sessionId: 's1', agent: 'Echo', timeoutMs: 600 });
    expect(brief).toContain('Now: Tuesday 3 November 2026');
    expect(brief).toContain("- Kevin's partner is Erika");
    expect(brief).toContain('How your last conversation ended (2 days ago, with Echo):');
    expect(brief).toContain('- User: the greenhouse door is broken / Echo: I will remind you.');
  });

  it('prefers summaries for the last conversation and recent days', async () => {
    const client = makeClient({
      brief: async () => ({
        ...BRIEF,
        last_session: BRIEF.last_session && { ...BRIEF.last_session, summary: 'They fixed the\ngreenhouse door.' },
        recent_days: [{ period_start: new Date(2026, 10, 2).toISOString(), title: 'Monday', text: 'A quiet day.' }],
      }),
    });
    const memory = createVoiceMemory({ client, currentSessionId: () => 's1', agentName: () => 'Echo', now: () => NOW });
    const brief = await memory.brief();
    expect(brief).toContain('Recent days:\n- Mon, 2 Nov 2026: A quiet day.');
    expect(brief).toContain('Your last conversation (2 days ago, with Echo): They fixed the / greenhouse door.');
    expect(brief).not.toContain('How your last conversation ended');
  });

  it('puts the note left for this conversation in the brief word for word', async () => {
    const client = makeClient({
      brief: async () => ({
        ...BRIEF,
        handoff: {
          id: 'h1', session_id: 's0', agent: 'Echo', model: 'qwen-next-flash',
          text: 'Halfway through the garden plan.\nAsk about the budget.',
          written_at: new Date(2026, 10, 1, 9, 30).toISOString(),
        },
      }),
    });
    const memory = createVoiceMemory({ client, currentSessionId: () => 's1', agentName: () => 'Echo', now: () => NOW });
    expect(await memory.brief()).toContain(
      'The note you left yourself for this conversation (2 days ago, written by qwen-next-flash):\n' +
        'Halfway through the garden plan.\nAsk about the budget.',
    );
  });

  it('tells the engine when a turn starts and ends, ignoring failures', async () => {
    const activity = vi.fn(async () => { throw new Error('down'); });
    const memory = createVoiceMemory({ client: { ...makeClient(), activity }, currentSessionId: () => null, agentName: () => 'Echo' });
    memory.activity?.(true);
    memory.activity?.(false);
    await Promise.resolve();
    expect(activity.mock.calls).toEqual([[true], [false]]);
  });

  it('still gives the time when the engine is down or the brief is off', async () => {
    const down = createVoiceMemory({
      client: makeClient({ brief: async () => { throw new Error('unreachable'); } }),
      currentSessionId: () => null,
      agentName: () => 'Echo',
      now: () => NOW,
      logger: { warn: () => {} },
    });
    expect(await down.brief()).toBe(formatBrief(null, NOW));
    const client = makeClient();
    const off = createVoiceMemory({ client, currentSessionId: () => null, agentName: () => 'Echo', brief: false, now: () => NOW });
    expect(await off.brief()).toMatch(/^Now: /);
    expect(client.brief).not.toHaveBeenCalled();
  });

  it('turns recalled items into a dated block, and gives null when nothing matched', async () => {
    const item = {
      id: 'm1', kind: 'turn', source_id: 'x', session_id: 's0', agent: 'Echo',
      period_start: new Date(2026, 9, 14, 10).toISOString(), period_end: new Date(2026, 9, 14, 10).toISOString(),
      text: 'User: the tomatoes went in\nEcho: lovely', score: 1, private: false, similarity: 0.8,
    };
    const client = makeClient({ recall: async () => ({ items: [item], reason: null }) });
    const memory = createVoiceMemory({ client, currentSessionId: () => 's1', agentName: () => 'Echo', now: () => NOW });
    const recalled = await memory.recall('how are the tomatoes doing', ['old']);
    expect(client.recall).toHaveBeenCalledWith({ text: 'how are the tomatoes doing', session_id: 's1', exclude: ['old'] }, 150);
    expect(recalled?.ids).toEqual(['m1']);
    expect(recalled?.block).toContain('<recalled>');
    expect(recalled?.block).toContain('Wed, 14 Oct 2026 (3 weeks ago, talked): User: the tomatoes went in / Echo: lovely');

    // Outside a conversation nothing is asked, so nothing is logged that could never be forgotten.
    const outside = makeClient();
    const none = createVoiceMemory({ client: outside, currentSessionId: () => null, agentName: () => 'Echo' });
    expect(await none.recall('anything at all here', [])).toBeNull();
    expect(outside.recall).not.toHaveBeenCalled();
    const failing = createVoiceMemory({
      client: makeClient({ recall: async () => { throw new Error('timeout'); } }),
      currentSessionId: () => 's1',
      agentName: () => 'Echo',
    });
    expect(await failing.recall('anything at all here', [])).toBeNull();
  });
});
