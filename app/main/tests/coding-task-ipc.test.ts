import { describe, expect, it, vi } from 'vitest';
import { registerCodingTaskIpc } from '../src/coding/task-ipc.js';
import { registerApprovalsIpc } from '../src/tools/approvals-ipc.js';
import { ApprovalBroker } from '../src/tools/approvals.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import type { RunnerEvent } from '../src/coding/runner-client.js';

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void handlers.set(channel, fn), call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args), handlers };
}

describe('coding task IPC', () => {
  it('passes the card actions to the runner and forwards its events', async () => {
    const ipc = fakeIpc();
    const client = {
      listTasks: vi.fn(async () => []),
      getTask: vi.fn(async () => ({})),
      taskDiff: vi.fn(async () => 'diff'),
      createTask: vi.fn(async () => ({})),
      answer: vi.fn(async () => ({})),
      followUp: vi.fn(async () => ({})),
      cancel: vi.fn(async () => ({})),
      discard: vi.fn(async () => ({})),
      apply: vi.fn(async () => ({})),
    };
    let listener: (e: RunnerEvent) => void = () => undefined;
    const broadcast = vi.fn();
    registerCodingTaskIpc({
      ipcMain: ipc,
      client: () => client as never,
      onRunnerEvent: (l) => {
        listener = l;
        return () => undefined;
      },
      broadcast,
    });
    expect(await ipc.call('coding:diff', 't1')).toBe('diff');
    await ipc.call('coding:start-task', { workspace_id: 'a', goal: 'g', acceptance: ['x', '', 4] });
    expect(client.createTask).toHaveBeenCalledWith({ workspace_id: 'a', goal: 'g', acceptance: ['x'] });
    await ipc.call('coding:answer-task', 't1', { value: 'v', dialog_id: 'a1', junk: 1 });
    expect(client.answer).toHaveBeenCalledWith('t1', { value: 'v', dialog_id: 'a1' });
    await ipc.call('coding:follow-up', 't1', 'more');
    await ipc.call('coding:cancel-task', 't1');
    await ipc.call('coding:discard-task', 't1');
    await ipc.call('coding:apply-task', 't1');
    expect(client.followUp).toHaveBeenCalledWith('t1', 'more');
    expect(client.apply).toHaveBeenCalledWith('t1');
    expect(() => ipc.call('coding:task', '')).toThrow('id is required');
    listener({ task_id: null });
    listener({ task_id: 't1', status: 'working' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('coding:task-event', { task_id: 't1', status: 'working' });
  });

  it('fails clearly when the runner is not connected', () => {
    const ipc = fakeIpc();
    registerCodingTaskIpc({ ipcMain: ipc, client: () => null, onRunnerEvent: () => () => undefined, broadcast: vi.fn() });
    expect(() => ipc.call('coding:tasks')).toThrow('not connected');
  });
});

describe('approvals IPC', () => {
  it('lists without params, approves and declines on the card, and pushes changes', async () => {
    const ipc = fakeIpc();
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => 'done');
    const tool = { id: 't:x', serverId: 't', toolName: 'x', description: '', inputSchema: {}, enabled: true, confirmationLevel: 'confirm' as const, execute, cardOnly: () => true };
    registry.register(tool);
    const broker = new ApprovalBroker({ registry });
    const broadcast = vi.fn();
    const off = registerApprovalsIpc({ ipcMain: ipc, broker, broadcast });
    const approval = await broker.request(tool, { secret: 'p' });
    expect(broadcast).toHaveBeenLastCalledWith('approvals:changed', [expect.objectContaining({ id: approval.id, cardOnly: true })]);
    const listed = (await ipc.call('approvals:list')) as Array<Record<string, unknown>>;
    expect(listed[0]).not.toHaveProperty('params');
    // The card may approve a card-only request.
    expect(await ipc.call('approvals:approve', approval.id)).toMatchObject({ decision: 'approved', ok: true, result: 'done' });
    expect(execute).toHaveBeenCalledWith({ secret: 'p' });
    const second = await broker.request(tool, { secret: 'q' });
    expect(await ipc.call('approvals:decline', second.id)).toMatchObject({ decision: 'declined' });
    expect(await ipc.call('approvals:approve', 'nope')).toBeNull();
    off();
    await broker.request(tool, { secret: 'r' });
    expect(broadcast).toHaveBeenCalledTimes(4);
  });
});
