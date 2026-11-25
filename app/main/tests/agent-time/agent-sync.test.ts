import { describe, expect, it, vi } from 'vitest';
import { AgentSync } from '../../src/agent-time/agent-sync.js';

function setup(putAgents: ReturnType<typeof vi.fn>) {
  const timers: Array<() => void> = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sync = new AgentSync({
    client: { putAgents } as never,
    avatars: () => [{ id: 'echo', name: 'Echo' }, { id: 'sage', name: 'Sage' }],
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => undefined,
    logger,
  });
  return { sync, timers, logger };
}

describe('AgentSync', () => {
  it('puts all avatar ids and names', async () => {
    const put = vi.fn(async () => ({ agents: ['echo', 'sage'], started: ['echo'], stopped: [] }));
    const { sync, timers } = setup(put);
    expect(await sync.sync()).toBe(true);
    expect(put).toHaveBeenCalledWith([{ id: 'echo', name: 'Echo' }, { id: 'sage', name: 'Sage' }]);
    expect(timers).toHaveLength(0);
  });

  it('retries every 15 s and logs one warning per failure streak', async () => {
    const put = vi.fn().mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down')).mockResolvedValue({ agents: [], started: [], stopped: [] });
    const { sync, timers, logger } = setup(put);
    expect(await sync.sync()).toBe(false);
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(put).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith('Workflows service reached again', expect.anything());
    // A new streak warns again.
    put.mockRejectedValueOnce(new Error('down again'));
    await sync.sync();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('does nothing after stop', async () => {
    const put = vi.fn(async () => ({ agents: [], started: [], stopped: [] }));
    const { sync } = setup(put);
    sync.stop();
    expect(await sync.sync()).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
