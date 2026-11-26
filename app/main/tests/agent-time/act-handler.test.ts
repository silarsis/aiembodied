import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  ACT_KINDS,
  AgentActHandler,
  localIso,
  type AgentActDeps,
} from '../../src/agent-time/act-handler.js';
import { AgentSleep } from '../../src/agent-time/sleep.js';
import { QuietSaves } from '../../src/agent-time/quiet-saves.js';
import { LocalOnlyBus } from '../../src/switchboard/bus.js';
import { makeEventId } from '../../src/switchboard/client.js';
import { LlmGate } from '../../src/pursuits/pursuit-llm.js';
import type { ApprovalOutcome } from '../../src/tools/approvals.js';
import type { PendingApproval } from '../../src/shared/tools/approvals-types.js';
import type { RegisteredTool } from '../../src/tools/tool-registry.js';
import type { SwitchboardEvent } from '../../src/switchboard/types.js';
import { FakeChat } from '../pursuits/fakes.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function tool(
  name: string,
  level: RegisteredTool['confirmationLevel'],
  execute: RegisteredTool['execute'] = async () => 'done',
): RegisteredTool {
  return {
    id: `t:${name}`,
    serverId: 't',
    toolName: name,
    description: name,
    inputSchema: { type: 'object' },
    enabled: true,
    confirmationLevel: level,
    execute,
  };
}

function setup(
  overrides: Partial<AgentActDeps> & { chat?: FakeChat; tools?: RegisteredTool[] } = {},
) {
  const bus = new LocalOnlyBus(makeEventId);
  const results: SwitchboardEvent[] = [];
  bus.subscribe({
    to: ['service:workflows'],
    types: ['agent.act.result'],
    onEvent: (event) => results.push(event),
  });
  const sleep = new AgentSleep();
  const quietSaves = new QuietSaves();
  const approvals = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
  approvals.request = vi.fn(
    async (t: RegisteredTool, params: unknown): Promise<PendingApproval> => ({
      id: 'ap-1',
      toolId: t.id,
      toolName: t.toolName,
      params,
      summary: 's',
      createdAt: 0,
      expiresAt: 1,
      source: 'voice',
      cardOnly: false,
      requestedBy: 'avatar:echo',
      approvers: [],
    }),
  );
  const registered = overrides.tools ?? [
    tool('lights', 'none'),
    tool('buy', 'confirm'),
    tool('nuke', 'block'),
  ];
  const executed: Array<{ id: string; params: unknown; context: unknown }> = [];
  const say = vi.fn();
  const nextDoor = { tryAvatar: vi.fn(() => ({ moved: true })) };
  const pursuits = {
    isRunning: vi.fn(() => false),
    offers: vi.fn(() => [
      {
        stationId: 'shelf',
        roomId: 'r',
        objectId: 'o',
        objectName: 'bookshelf',
        characters: 'all' as const,
      },
      { stationId: 'desk', roomId: 'r', objectId: 'd', objectName: 'desk', characters: ['sage'] },
    ]),
    start: vi.fn(() => ({ ok: true })),
    interrupt: vi.fn(() => true),
  };
  const deps: AgentActDeps = {
    bus: () => bus,
    now: () => new Date('2026-11-26T01:30:00Z').getTime(),
    sleep,
    quietSaves,
    presence: {
      snapshot: () => ({
        doNotDisturb: false,
        listening: true,
        voicePhase: 'waiting',
        secondsSinceUserSpoke: 30,
        secondsSinceAssistantSpoke: 90,
        secondsSinceFaceSeen: 5,
        localTime: 'Thu 09:30',
      }),
    },
    avatarName: (id) => (id === 'echo' ? 'Echo' : id === 'sage' ? 'Sage' : null),
    persona: () => 'You are warm.',
    habits: () => 'likes the window',
    placeOf: () => 'home',
    restlessness: () => 'normal',
    conversationActive: () => false,
    pursuits,
    say,
    chatFor: () => overrides.chat ?? new FakeChat(() => ({ text: 'thought' })),
    brief: async () => 'Now: today.',
    llmGate: new LlmGate(1),
    tools: {
      list: () => registered,
      execute: async (id, params, context) => {
        executed.push({ id, params, context });
        const found = registered.find((t) => t.id === id);
        return { success: true, data: await found?.execute(params, context), durationMs: 1 };
      },
    },
    approvals,
    nextDoor,
    thinkBusyWaitMs: 30,
    ...overrides,
  } as AgentActDeps;
  const handler = new AgentActHandler(deps);
  handler.start();
  let n = 0;
  const act = async (
    kind: string,
    args: Record<string, unknown> = {},
    avatarId = 'echo',
    txn = `act:${++n}`,
  ) => {
    bus.publish({
      type: 'agent.act',
      producer: { kind: 'service', id: 'workflows' },
      to: ['service:app'],
      audience: 'private',
      txn: { id: txn, state: 'open' },
      payload: { avatarId, kind, args, workflowId: 'life:echo' },
    });
    for (let i = 0; i < 100 && !results.some((event) => event.txn?.id === txn); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    return results.find((event) => event.txn?.id === txn);
  };
  return {
    act,
    results,
    sleep,
    quietSaves,
    approvals,
    say,
    nextDoor,
    pursuits,
    executed,
    handler,
    bus,
  };
}

describe('AgentActHandler', () => {
  it('answers context with the avatar state', async () => {
    const { act, quietSaves } = setup();
    quietSaves.add('echo', 'door was opened');
    const answer = await act('context');
    expect(answer?.txn?.state).toBe('done');
    expect(answer?.to).toEqual(['service:workflows']);
    expect(answer?.producer).toEqual({ kind: 'service', id: 'app' });
    expect(answer?.payload).toMatchObject({ ok: true });
    const result = (answer?.payload as { result: Record<string, unknown> }).result;
    expect(result).toMatchObject({
      avatarName: 'Echo',
      place: 'home',
      voicePhase: 'waiting',
      conversationActive: false,
      secondsSinceKevinSpoke: 30,
      secondsSinceAvatarSpoke: 90,
      secondsSinceFaceSeen: 5,
      doNotDisturb: false,
      pursuitRunning: false,
      restlessness: 'normal',
      quietSaves: ['door was opened'],
      asleep: false,
      personality: 'You are warm.',
      idleHabits: 'likes the window',
      pursuitOffers: [{ stationId: 'shelf', label: 'bookshelf' }],
    });
    expect(result.localTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(typeof result.hour).toBe('number');
  });

  it('offers a station only to the characters it is for', async () => {
    const { act } = setup();
    const answer = await act('context', {}, 'sage');
    expect(
      (answer?.payload as { result: { pursuitOffers: unknown[] } }).result.pursuitOffers,
    ).toHaveLength(2);
  });

  it('fails with bad_args for an unknown avatar or kind and answers each txn once', async () => {
    const { act, results } = setup();
    expect((await act('context', {}, 'nobody'))?.payload).toMatchObject({
      ok: false,
      code: 'bad_args',
    });
    expect((await act('dance'))?.payload).toMatchObject({ ok: false, code: 'bad_args' });
    expect((await act('context', {}, 'echo', 'act:dup'))?.txn?.state).toBe('done');
    await act('context', {}, 'echo', 'act:dup');
    expect(results.filter((event) => event.txn?.id === 'act:dup')).toHaveLength(1);
    expect(ACT_KINDS).toHaveLength(8);
  });

  it('say goes through the inbox with a default source', async () => {
    const { act, say } = setup();
    expect((await act('say', { text: 'Hello there' }))?.payload).toEqual({
      ok: true,
      result: { queued: true },
    });
    expect(await act('say', { text: 'Fire!', urgent: true, source: 'a reminder' })).toBeDefined();
    expect(say.mock.calls).toEqual([
      ['echo', 'Hello there', false, 'own thoughts'],
      ['echo', 'Fire!', true, 'a reminder'],
    ]);
    expect((await act('say', {}))?.payload).toMatchObject({ ok: false, code: 'bad_args' });
  });

  it('think answers with the model text and, with safe tools, the tool calls', async () => {
    const chat = new FakeChat((call) =>
      call.tools.length > 0 && !call.messages.some((m) => m.role === 'tool')
        ? { calls: [{ name: 'lights', arguments: {} }] }
        : {
            text:
              call.tools.length > 0 || call.messages.some((m) => m.role === 'tool')
                ? 'SAY: hi'
                : 'plain',
          },
    );
    const { act, executed } = setup({ chat });
    const plain = await act('think', { prompt: 'what now?' });
    expect(plain?.payload).toEqual({ ok: true, result: { text: 'plain', toolCalls: [] } });
    const safe = await act('think', { prompt: 'what now?', tools: 'safe' });
    expect(safe?.payload).toEqual({
      ok: true,
      result: { text: 'SAY: hi', toolCalls: [{ name: 'lights', ok: true }] },
    });
    expect(executed[0]).toMatchObject({ id: 't:lights', context: { avatarId: 'echo' } });
    // Only none/notify tools are offered.
    const offered = chat.seen
      .find((call) => call.tools.length > 0)
      ?.tools.map((t) => t.function.name);
    expect(offered).toEqual(['lights']);
    // The system message has the persona and the brief.
    expect(chat.seen[0].messages[0].content).toContain('You are warm.');
    expect(chat.seen[0].messages[0].content).toContain('Now: today.');
    expect((await act('think', {}))?.payload).toMatchObject({ ok: false, code: 'bad_args' });
  });

  it('think fails busy while a conversation goes on, and when a voice turn starts', async () => {
    const busy = setup({ conversationActive: () => true });
    expect((await busy.act('think', { prompt: 'x' }))?.payload).toMatchObject({
      ok: false,
      code: 'busy',
    });

    const chat = new FakeChat(() => ({ text: 'never' }));
    chat.holdOn.add(0);
    const live = setup({ chat });
    live.bus.publish({
      type: 'agent.act',
      producer: { kind: 'service', id: 'workflows' },
      to: ['service:app'],
      txn: { id: 'act:slow', state: 'open' },
      payload: { avatarId: 'echo', kind: 'think', args: { prompt: 'x' } },
    });
    await flush();
    live.handler.interruptThinking('echo');
    for (let i = 0; i < 40 && live.results.length === 0; i += 1) await flush();
    expect(live.results.find((event) => event.txn?.id === 'act:slow')?.payload).toMatchObject({
      ok: false,
      code: 'busy',
    });
  });

  it('tool runs a normal tool for the avatar, refuses block, and reports unknown names', async () => {
    const { act, executed } = setup();
    expect((await act('tool', { name: 'lights', params: { on: true } }))?.payload).toEqual({
      ok: true,
      result: { ok: true, data: 'done' },
    });
    expect(executed[0]).toMatchObject({ params: { on: true }, context: { avatarId: 'echo' } });
    expect((await act('tool', { name: 'nuke', params: {} }))?.payload).toMatchObject({
      ok: false,
      code: 'refused',
    });
    expect((await act('tool', { name: 'nope' }))?.payload).toMatchObject({
      ok: false,
      code: 'bad_args',
    });
  });

  it('tool with a confirm level waits for the approval card', async () => {
    const { act, approvals, results } = setup();
    const promise = act('tool', { name: 'buy', params: { item: 'milk' } }, 'echo', 'act:buy');
    await flush();
    expect(approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'buy' }),
      { item: 'milk' },
      'echo',
      expect.objectContaining({ ttlMs: expect.any(Number) }),
    );
    expect(results).toHaveLength(0);
    approvals.emit('outcome', {
      approval: { id: 'ap-1' },
      decision: 'approved',
      by: 'card',
      ok: true,
      result: 'bought',
      delivered: false,
    } as ApprovalOutcome);
    expect((await promise)?.payload).toEqual({ ok: true, result: { ok: true, data: 'bought' } });
  });

  it('a declined confirm tool is refused', async () => {
    const { act, approvals } = setup();
    const promise = act('tool', { name: 'buy', params: {} }, 'echo', 'act:buy2');
    await flush();
    approvals.emit('outcome', {
      approval: { id: 'ap-1' },
      decision: 'declined',
      by: 'card',
      delivered: false,
    } as ApprovalOutcome);
    expect((await promise)?.payload).toMatchObject({ ok: false, code: 'refused' });
  });

  it('ask shows a card-only question and returns the answer', async () => {
    const { act, approvals } = setup();
    const promise = act(
      'ask',
      { question: 'Order milk?', detail: 'two litres' },
      'echo',
      'act:ask',
    );
    await flush();
    const [questionTool, params] = approvals.request.mock.calls[0] as [
      RegisteredTool,
      Record<string, unknown>,
    ];
    expect(questionTool.confirmationLevel).toBe('confirm');
    expect(await questionTool.cardOnly?.(params)).toBe(true);
    expect(questionTool.describeCall?.(params)).toBe('Echo asks: Order milk? (two litres)');
    approvals.emit('outcome', {
      approval: { id: 'ap-1' },
      decision: 'approved',
      by: 'card',
      ok: true,
      result: 'yes',
      delivered: false,
    } as ApprovalOutcome);
    expect((await promise)?.payload).toEqual({ ok: true, result: { approved: true } });
    const no = act('ask', { question: 'Again?' }, 'echo', 'act:ask2');
    await flush();
    approvals.emit('outcome', {
      approval: { id: 'ap-1' },
      decision: 'declined',
      by: 'card',
      delivered: false,
    } as ApprovalOutcome);
    expect((await no)?.payload).toEqual({ ok: true, result: { approved: false } });
  });

  it('start_pursuit uses the given station or the first offer for the avatar', async () => {
    const { act, pursuits } = setup();
    await act('start_pursuit', { stationId: 'desk' });
    await act('start_pursuit', {});
    expect(pursuits.start.mock.calls).toEqual([
      ['echo', 'desk'],
      ['echo', 'shelf'],
    ]);
    pursuits.start.mockReturnValueOnce({ ok: false, reason: 'asleep' } as never);
    expect((await act('start_pursuit', {}))?.payload).toEqual({
      ok: true,
      result: { ok: false, reason: 'asleep' },
    });
  });

  it('return_home asks next door about that avatar', async () => {
    const { act, nextDoor } = setup();
    expect((await act('return_home', {}, 'sage'))?.payload).toEqual({
      ok: true,
      result: { moved: true },
    });
    expect(nextDoor.tryAvatar).toHaveBeenCalledWith('sage');
    nextDoor.tryAvatar.mockReturnValueOnce({
      moved: false,
      reason: 'nobody is anywhere it may go',
    } as never);
    expect((await act('return_home', {}, 'sage'))?.payload).toEqual({
      ok: true,
      result: { moved: false, reason: 'nobody is anywhere it may go' },
    });
  });

  it('sleep_state sets the sleep map and stops a reading session', async () => {
    const { act, sleep, pursuits } = setup();
    expect((await act('sleep_state', { asleep: true, reason: 'late' }))?.payload).toEqual({
      ok: true,
      result: { ok: true },
    });
    expect(sleep.isAsleep('echo')).toBe(true);
    expect(pursuits.interrupt).toHaveBeenCalledWith('echo', 'asleep');
    expect(((await act('context'))?.payload as { result: { asleep: boolean } }).result.asleep).toBe(
      true,
    );
    await act('sleep_state', { asleep: false });
    expect(sleep.isAsleep('echo')).toBe(false);
    expect((await act('sleep_state', {}))?.payload).toMatchObject({ ok: false, code: 'bad_args' });
  });

  it('logs one line per act and never throws when the bus is gone', async () => {
    const info = vi.fn();
    const { act } = setup({ logger: { info, warn: vi.fn() } });
    await act('context');
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/^Agent act context for echo -> ok \(\d+ ms\)$/),
      expect.anything(),
    );
    const quiet = setup({ bus: () => null });
    await expect(
      quiet.handler.handle({
        id: 'e',
        v: 1,
        at: '',
        type: 'agent.act',
        producer: { kind: 'service', id: 'workflows' },
        to: ['service:app'],
        txn: { id: 'x' },
        payload: { avatarId: 'echo', kind: 'context' },
      }),
    ).resolves.toBeUndefined();
  });

  it('formats local time with an offset', () => {
    expect(localIso(new Date(2026, 10, 26, 7, 5, 9))).toMatch(/^2026-11-26T07:05:09[+-]\d\d:\d\d$/);
  });
});
