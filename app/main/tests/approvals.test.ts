import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBroker, APPROVAL_TTL_MS, describeOutcome, parseSpokenDecision } from '../src/tools/approvals.js';
import { ToolRegistry, type RegisteredTool } from '../src/tools/tool-registry.js';

function makeTool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    id: 'coding:start_coding_task',
    serverId: 'coding',
    toolName: 'start_coding_task',
    description: 'd',
    inputSchema: { type: 'object' },
    enabled: true,
    confirmationLevel: 'confirm',
    describeCall: (p) => `start a task: ${(p as { goal: string }).goal}`,
    execute: vi.fn(async () => 'Started task t1.'),
    ...overrides,
  };
}

function setup(tool = makeTool()) {
  const registry = new ToolRegistry();
  registry.register(tool);
  const logger = { info: vi.fn(), warn: vi.fn() };
  let now = 1_000;
  const broker = new ApprovalBroker({ registry, logger, now: () => now });
  return { broker, tool, logger, advance: (ms: number) => (now += ms) };
}

afterEach(() => vi.useRealTimers());

describe('parseSpokenDecision', () => {
  it.each([
    ['yes', 'yes'],
    ['Yeah.', 'yes'],
    ['Go ahead!', 'yes'],
    ['do it', 'yes'],
    ['approve', 'yes'],
    ['ok go', 'yes'],
    ['yes please', 'yes'],
    ['yes go ahead', 'yes'],
    ['no', 'no'],
    ["don't", 'no'],
    ['Cancel.', 'no'],
    ['stop', 'no'],
    ['not now', 'no'],
    ['no thanks', 'no'],
  ])('%s is a clear answer', (text, expected) => {
    expect(parseSpokenDecision(text)).toBe(expected);
  });

  it.each(['what is the weather', 'yes but change the name to foo please', 'maybe', 'go ahead and also tell me a joke now', ''])(
    'leaves %s to the model',
    (text) => {
      expect(parseSpokenDecision(text)).toBeNull();
    },
  );
});

describe('ApprovalBroker', () => {
  it('records a request without running the tool, and logs it', async () => {
    const { broker, tool, logger } = setup();
    const approval = await broker.request(tool, { goal: 'Fix X' });
    expect(tool.execute).not.toHaveBeenCalled();
    expect(approval).toMatchObject({ toolName: 'start_coding_task', summary: 'start a task: Fix X', source: 'voice', cardOnly: false });
    expect(broker.list()).toHaveLength(1);
    expect(broker.waitingMessage(approval)).toBe('Waiting for Kevin to approve: start a task: Fix X. Ask him out loud whether to go ahead.');
    expect(logger.info).toHaveBeenCalledWith('Approval requested', expect.objectContaining({ id: approval.id }));
  });

  it('does not add the same call twice', async () => {
    const { broker, tool } = setup();
    const a = await broker.request(tool, { goal: 'Fix X' });
    const b = await broker.request(tool, { goal: 'Fix X' });
    expect(b.id).toBe(a.id);
    expect(broker.list()).toHaveLength(1);
  });

  it('runs the tool on approval and reports the outcome', async () => {
    const { broker, tool, logger } = setup();
    const outcomes: unknown[] = [];
    broker.on('outcome', (o) => outcomes.push(o));
    const changes: number[] = [];
    broker.on('changed', (list: unknown[]) => changes.push(list.length));
    const approval = await broker.request(tool, { goal: 'Fix X' });
    const outcome = await broker.approve(approval.id, 'card');
    expect(tool.execute).toHaveBeenCalledWith({ goal: 'Fix X' });
    expect(outcome).toMatchObject({ decision: 'approved', by: 'card', ok: true, result: 'Started task t1.', delivered: false });
    expect(broker.list()).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(changes).toEqual([1, 0]);
    expect(logger.info).toHaveBeenCalledWith('Approval granted', expect.objectContaining({ by: 'card' }));
    expect(describeOutcome(outcome!)).toContain('Kevin approved: start a task: Fix X. Done. Result: Started task t1.');
    expect(await broker.approve(approval.id)).toBeNull();
  });

  it('reports a failing tool', async () => {
    const { broker, tool } = setup(makeTool({ execute: vi.fn(async () => { throw new Error('runner down'); }) }));
    const approval = await broker.request(tool, { goal: 'x' });
    const outcome = await broker.approve(approval.id);
    expect(outcome).toMatchObject({ decision: 'approved', ok: false, result: 'runner down' });
    expect(describeOutcome(outcome!)).toContain('but it failed: runner down');
  });

  it('declines on request', async () => {
    const { broker, tool } = setup();
    const approval = await broker.request(tool, { goal: 'x' });
    const outcome = broker.decline(approval.id);
    expect(outcome?.decision).toBe('declined');
    expect(tool.execute).not.toHaveBeenCalled();
    expect(describeOutcome(outcome!)).toBe('Kevin declined: start a task: x.');
  });

  it('settles the newest approval on a spoken yes or no and marks it delivered', async () => {
    const { broker, tool } = setup();
    await broker.request(tool, { goal: 'one' });
    const second = await broker.request(tool, { goal: 'two' });
    const yes = await broker.resolveSpoken('go ahead');
    expect(yes).toMatchObject({ decision: 'approved', by: 'voice', delivered: true });
    expect(yes?.approval.id).toBe(second.id);
    const no = await broker.resolveSpoken('no');
    expect(no).toMatchObject({ decision: 'declined', by: 'voice', delivered: true });
    expect(broker.list()).toEqual([]);
  });

  it('marks spoken outcomes delivered before emitting them', async () => {
    const { broker, tool } = setup();
    const seen: boolean[] = [];
    broker.on('outcome', (o: { delivered: boolean }) => seen.push(o.delivered));
    await broker.request(tool, { goal: 'one' });
    await broker.resolveSpoken('yes');
    await broker.request(tool, { goal: 'two' });
    await broker.resolveSpoken('no');
    expect(seen).toEqual([true, true]);
  });

  it('does not settle an approval older than five minutes by voice', async () => {
    const { broker, tool, advance } = setup();
    await broker.request(tool, { goal: 'old' });
    advance(6 * 60_000);
    expect(await broker.resolveSpoken('yes')).toBeNull();
    expect(broker.list()).toHaveLength(1);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('ignores long or unclear speech and leaves the approval pending', async () => {
    const { broker, tool } = setup();
    await broker.request(tool, { goal: 'x' });
    expect(await broker.resolveSpoken('yes but first tell me what the weather is like')).toBeNull();
    expect(await broker.resolveSpoken('hmm')).toBeNull();
    expect(broker.list()).toHaveLength(1);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('never approves a card-only request by voice, but a spoken no declines it', async () => {
    const { broker, tool } = setup(makeTool({ cardOnly: () => true }));
    const approval = await broker.request(tool, { goal: 'x' });
    expect(approval.cardOnly).toBe(true);
    expect(broker.waitingMessage(approval)).toContain('only be approved by tapping Approve');
    expect(await broker.resolveSpoken('yes')).toBeNull();
    expect(await broker.approve(approval.id, 'voice')).toBeNull();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(broker.list()).toHaveLength(1);
    expect((await broker.resolveSpoken('no'))?.decision).toBe('declined');
  });

  it('treats a card-only check that throws as card-only', async () => {
    const { broker, tool, logger } = setup(makeTool({ cardOnly: () => { throw new Error('lookup failed'); } }));
    expect((await broker.request(tool, { goal: 'x' })).cardOnly).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('declines an approval nobody answered in 30 minutes', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    const tool = makeTool();
    registry.register(tool);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const broker = new ApprovalBroker({ registry, logger });
    const outcomes: Array<{ decision: string }> = [];
    broker.on('outcome', (o) => outcomes.push(o));
    await broker.request(tool, { goal: 'x' });
    expect(APPROVAL_TTL_MS).toBe(30 * 60_000);
    await vi.advanceTimersByTimeAsync(APPROVAL_TTL_MS + 100);
    expect(broker.list()).toEqual([]);
    expect(outcomes.map((o) => o.decision)).toEqual(['expired']);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Approval expired (declined)', expect.anything());
  });

  it('falls back to a generic summary', async () => {
    const { broker, tool } = setup(makeTool({ describeCall: undefined }));
    const approval = await broker.request(tool, { goal: 'x' });
    expect(approval.summary).toBe('start coding task {"goal":"x"}');
  });
});
