import { describe, expect, it, vi } from 'vitest';
import type { SystemOneClient } from '../src/decide/system-one.js';
import { PresenceTracker } from '../src/presence/presence.js';
import { DELIBERATE_QUICK_THRESHOLD, deliberateFast, deliberateQuick } from '../src/switchboard/deliberate-system-one.js';
import type { Decision } from '../src/switchboard/deliberate.js';
import type { SwitchboardEvent } from '../src/switchboard/types.js';

const event = (extra: Partial<SwitchboardEvent> = {}): SwitchboardEvent => ({
  id: 'E1', v: 1, at: '2026-11-10T20:00:00Z', type: 'avatar.inbox', producer: { kind: 'service', id: 'app' }, to: ['avatar:echo'],
  priority: 'normal', payload: { text: 'Tests passed', source: 'coding' }, ...extra,
});

function client(action: Record<string, number>, urgent = 0.1) {
  const ask = vi.fn(async () => ({ action, urgent }));
  return { ask, client: { ask } as unknown as SystemOneClient };
}

describe('deliberateQuick', () => {
  const presence = new PresenceTracker();
  it('picks say, remember and ignore', async () => {
    for (const action of ['say', 'remember', 'ignore'] as const) {
      const { client: c } = client({ ignore: 0.05, remember: 0.05, say: 0.05, [action]: 0.9 });
      const d = await deliberateQuick(event(), presence, { client: c });
      expect(d).toMatchObject({ action, urgent: false, engine: 'system-one', reason: `quick decision (${action} 0.90)` });
    }
  });
  it('sends a small state', async () => {
    const { ask, client: c } = client({ ignore: 0, remember: 0, say: 1 });
    await deliberateQuick(event({ payload: { text: 'x'.repeat(5000), source: 'coding' } }), presence, { client: c });
    const state = (ask.mock.calls[0] as unknown[])[0] as { event: { text: string } };
    expect(state.event.text.length).toBe(600);
  });
  it('is unsure below the threshold', async () => {
    const { client: c } = client({ ignore: 0.3, remember: 0.3, say: DELIBERATE_QUICK_THRESHOLD - 0.01 });
    expect(await deliberateQuick(event(), presence, { client: c })).toBeNull();
  });
  it('model urgency needs say and 0.85', async () => {
    expect((await deliberateQuick(event(), presence, { client: client({ ignore: 0, remember: 0, say: 1 }, 0.9).client }))?.urgent).toBe(true);
    expect((await deliberateQuick(event(), presence, { client: client({ ignore: 0, remember: 0, say: 1 }, 0.8).client }))?.urgent).toBe(false);
    expect((await deliberateQuick(event(), presence, { client: client({ ignore: 0, remember: 1, say: 0 }, 0.99).client }))?.urgent).toBe(false);
  });
  it('do not disturb blocks model urgency but not event priority', async () => {
    const dnd = new PresenceTracker();
    dnd.update({ doNotDisturb: true });
    const c = client({ ignore: 0, remember: 0, say: 1 }, 0.99).client;
    expect((await deliberateQuick(event(), dnd, { client: c }))?.urgent).toBe(false);
    expect((await deliberateQuick(event({ priority: 'urgent' }), dnd, { client: c }))?.urgent).toBe(true);
  });
  it('urgent priority passes through', async () => {
    const d = await deliberateQuick(event({ priority: 'urgent' }), presence, { client: client({ ignore: 0, remember: 1, say: 0 }, 0).client });
    expect(d?.urgent).toBe(true);
  });
});

describe('deliberateFast', () => {
  const presence = new PresenceTracker();
  const llm: Decision = { action: 'remember', reason: 'llm', urgent: false, engine: 'llm' };
  it('uses the quick decision and skips the fallback', async () => {
    const fallback = vi.fn(async () => llm);
    const d = await deliberateFast(event(), presence, { makeClient: () => client({ ignore: 0, remember: 0, say: 1 }).client, fallback });
    expect(d?.engine).toBe('system-one');
    expect(fallback).not.toHaveBeenCalled();
  });
  it('falls back when unsure, when it throws and when the route is off', async () => {
    const fallback = vi.fn(async () => llm);
    const warn = vi.fn();
    expect(await deliberateFast(event(), presence, { makeClient: () => client({ ignore: 0.4, remember: 0.3, say: 0.3 }).client, fallback })).toBe(llm);
    const broken = { ask: vi.fn(async () => { throw new Error('down'); }) } as unknown as SystemOneClient;
    expect(await deliberateFast(event(), presence, { makeClient: () => broken, fallback, logger: { warn } })).toBe(llm);
    expect(warn).toHaveBeenCalled();
    expect(await deliberateFast(event(), presence, { makeClient: () => null, fallback })).toBe(llm);
    expect(fallback).toHaveBeenCalledTimes(3);
  });
});
