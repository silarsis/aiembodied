import { describe, expect, it, vi } from 'vitest';
import { MemoryEngineError, registerMemoryEngineIpc, type MemoryEngineRuntime } from '../src/memory-engine/index.js';

const SESSION = '22222222-2222-4222-8222-222222222222';

function setup(runtime: Partial<MemoryEngineRuntime> | null, current: string | null = null) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const order: string[] = [];
  const store = {
    dropMemoryOutboxForSession: vi.fn(() => {
      order.push('drop');
      return 2;
    }),
    deleteSession: vi.fn(),
  };
  const leaveCurrentSession = vi.fn(() => order.push('leave'));
  registerMemoryEngineIpc({
    ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never,
    runtime: () => runtime as MemoryEngineRuntime | null,
    store,
    currentSessionId: () => current,
    leaveCurrentSession,
  });
  // Like ipcMain.handle: a throw becomes a rejected promise.
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  return { call, store, leaveCurrentSession, order };
}

describe('Memory panel IPC', () => {
  it('forgets a conversation everywhere: queued writes, the engine and the local copy', async () => {
    const deleteSession = vi.fn().mockResolvedValue({});
    const { call, store } = setup({ client: { deleteSession } as never, outbox: { status: () => ({ pending: 0 }) } as never });
    await expect(call('memory-engine:forget-session', SESSION)).resolves.toEqual({ forgotten: SESSION, dropped: 2 });
    expect(store.dropMemoryOutboxForSession).toHaveBeenCalledWith(SESSION);
    expect(deleteSession).toHaveBeenCalledWith(SESSION);
    expect(store.deleteSession).toHaveBeenCalledWith(SESSION);
  });

  it('moves on from the conversation in progress before forgetting it, and only that one', async () => {
    const deleteSession = vi.fn().mockResolvedValue({});
    const live = setup({ client: { deleteSession } as never }, SESSION);
    await live.call('memory-engine:forget-session', SESSION);
    expect(live.order).toEqual(['leave', 'drop']);
    const other = setup({ client: { deleteSession } as never }, '33333333-3333-4333-8333-333333333333');
    await other.call('memory-engine:forget-session', SESSION);
    expect(other.leaveCurrentSession).not.toHaveBeenCalled();
  });

  it('says so when the local copy could not be deleted', async () => {
    const deleteSession = vi.fn().mockResolvedValue({});
    const { call, store } = setup({ client: { deleteSession } as never });
    store.deleteSession.mockImplementation(() => {
      throw new Error('database is locked');
    });
    await expect(call('memory-engine:forget-session', SESSION)).rejects.toThrow(/own copy .* could not be deleted \(database is locked\)/);
  });

  it('asks for a whole day of conversations', async () => {
    const timeline = vi.fn().mockResolvedValue({ summaries: [], sessions: [] });
    const { call } = setup({ client: { timeline } as never });
    await call('memory-engine:timeline', { from: '2026-11-03T00:00:00Z', to: '2026-11-04T00:00:00Z' });
    expect(timeline).toHaveBeenCalledWith('2026-11-03T00:00:00.000Z', '2026-11-04T00:00:00.000Z', { turns: 50, limit: 200 });
  });

  it('treats a conversation the engine never had as forgotten', async () => {
    const deleteSession = vi.fn().mockRejectedValue(new MemoryEngineError('no such session', 404, false));
    const { call, store } = setup({ client: { deleteSession } as never });
    await expect(call('memory-engine:forget-session', SESSION)).resolves.toMatchObject({ forgotten: SESSION });
    expect(store.deleteSession).toHaveBeenCalled();
  });

  it('refuses bad ids and reports memory being off', async () => {
    const { call } = setup({ client: {} as never });
    await expect(call('memory-engine:forget-session', '../etc')).rejects.toThrow(/valid conversation id/);
    const off = setup(null);
    await expect(off.call('memory-engine:status')).resolves.toMatchObject({ enabled: false, reachable: false });
    await expect(off.call('memory-engine:facts', {})).rejects.toThrow(/turned off/);
  });

  it('adds facts as the user and only passes known fields when editing', async () => {
    const putFact = vi.fn().mockResolvedValue({});
    const patchFact = vi.fn().mockResolvedValue({});
    const { call } = setup({ client: { putFact, patchFact } as never });
    await call('memory-engine:add-fact', { text: '  Has a dog  ', subject: '', pinned: true });
    expect(putFact).toHaveBeenCalledWith(expect.any(String), { text: 'Has a dog', subject: null, pinned: true, author: 'user' });
    await call('memory-engine:update-fact', { id: SESSION, patch: { pinned: false, status: 'superseded', author: 'x' } });
    expect(patchFact).toHaveBeenCalledWith(SESSION, { pinned: false });
  });

  it('reports an unreachable engine with what is queued', async () => {
    const health = vi.fn().mockRejectedValue(new Error('refused'));
    const { call } = setup({ client: { health, baseUrl: 'http://x' } as never, outbox: { status: () => ({ pending: 3 }) } as never });
    await expect(call('memory-engine:status')).resolves.toMatchObject({ reachable: false, pending: 3, error: 'refused' });
  });
});
