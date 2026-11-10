import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalOnlyBus } from '../src/switchboard/bus.js';
import { SwitchboardClient, makeEventId, type WebSocketLike } from '../src/switchboard/client.js';
import type { Decision } from '../src/switchboard/deliberate.js';
import { AvatarInbox, DEFAULT_INBOX_POLICY, lookupRule } from '../src/switchboard/inbox.js';
import { SwitchboardMirror } from '../src/switchboard/mirror.js';
import type { SwitchboardEvent, SwitchboardEventInput } from '../src/switchboard/types.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const warn = { warn: vi.fn() };
const ev = (type: string, extra: Partial<SwitchboardEventInput> = {}): SwitchboardEventInput => ({
  type, producer: { kind: 'service', id: 'app' }, to: ['avatar:echo'], payload: { text: 'hello' }, ...extra,
});

describe('inbox policy', () => {
  it('maps types to rules', () => {
    expect(lookupRule(DEFAULT_INBOX_POLICY, 'home.alert')?.action).toBe('speak-urgent');
    const inboxAction = lookupRule(DEFAULT_INBOX_POLICY, 'avatar.inbox')?.action as (e: SwitchboardEvent) => string;
    expect(inboxAction({ priority: 'normal' } as SwitchboardEvent)).toBe('deliberate');
    expect(inboxAction({ priority: 'high' } as SwitchboardEvent)).toBe('speak-urgent');
    expect(inboxAction({ priority: 'urgent' } as SwitchboardEvent)).toBe('speak-urgent');
    expect(lookupRule(DEFAULT_INBOX_POLICY, 'home.change')?.action).toBe('remember');
    expect(lookupRule(DEFAULT_INBOX_POLICY, 'speech.heard')?.action).toBe('ignore');
    expect(lookupRule({ 'home.*': { action: 'speak-idle' }, '*': { action: 'ignore' } }, 'home.door')?.action).toBe('speak-idle');
  });

  it('speaks by action and drops expired or textless events', async () => {
    const bus = new LocalOnlyBus(makeEventId);
    const notify = vi.fn();
    new AvatarInbox({ avatarId: 'echo', bus, notify, logger: warn }).start();
    bus.publish(ev('avatar.inbox', { priority: 'high' }));
    bus.publish(ev('avatar.inbox', { priority: 'normal', payload: { text: 'later', source: 'coding' } })); // deliberate, no model: falls back to speak-idle
    bus.publish(ev('home.alert', { payload: { text: 'Smoke in kitchen' } }));
    bus.publish(ev('home.change'));
    bus.publish(ev('speech.heard'));
    bus.publish(ev('avatar.inbox', { expires: '2000-01-01T00:00:00Z' }));
    bus.publish(ev('avatar.inbox', { payload: {} }));
    bus.publish(ev('avatar.inbox', { to: ['avatar:other'] }));
    await flush();
    await flush();
    expect(notify.mock.calls).toEqual([
      ['hello', { urgent: true, source: undefined }],
      ['later', { urgent: false, source: undefined }],
      ['Smoke in kitchen', { urgent: true, source: 'Home Assistant' }],
    ]);
  });
});

describe('inbox decision step', () => {
  function setup(opts: { decision?: Decision | null | Error; dnd?: boolean; noDeliberate?: boolean } = {}) {
    const bus = new LocalOnlyBus(makeEventId);
    const notify = vi.fn();
    const remember = vi.fn();
    const deliberate = vi.fn(async () => {
      if (opts.decision instanceof Error) throw opts.decision;
      return opts.decision === undefined ? { action: 'say', reason: 'r', urgent: false } satisfies Decision : opts.decision;
    });
    const journal: SwitchboardEvent[] = [];
    bus.subscribe({ actor: 'service:test', to: [], types: ['avatar.decision'], observe: true, onEvent: (e) => journal.push(e) } as never);
    const originalPublish = bus.publish.bind(bus);
    bus.publish = (input) => {
      if (input.type === 'avatar.decision') journal.push(input as SwitchboardEvent);
      return originalPublish(input);
    };
    new AvatarInbox({ avatarId: 'echo', bus, notify, remember, deliberate: opts.noDeliberate ? undefined : deliberate, doNotDisturb: () => opts.dnd === true, logger: warn }).start();
    return { bus, notify, remember, deliberate, journal };
  }

  it('say speaks urgently so it announces at once', async () => {
    const t = setup();
    t.bus.publish(ev('avatar.inbox', { payload: { text: 'Build finished', source: 'ci' } }));
    await flush();
    await flush();
    expect(t.notify).toHaveBeenCalledWith('Build finished', { urgent: true, source: 'ci' });
    expect(t.remember).not.toHaveBeenCalled();
    expect(t.journal).toHaveLength(1);
    expect(t.journal[0]).toMatchObject({ type: 'avatar.decision', to: [], audience: 'private', producer: { kind: 'avatar', id: 'echo' } });
    expect(t.journal[0].payload).toMatchObject({ type: 'avatar.inbox', action: 'say', reason: 'r', fallback: false, doNotDisturb: false });
    expect(t.journal[0].txn?.state).toBe('done');
  });

  it('remember saves quietly; ignore does nothing', async () => {
    const r = setup({ decision: { action: 'remember', reason: 'later', urgent: false } });
    r.bus.publish(ev('avatar.inbox', { payload: { text: 'FYI', source: 'ci' } }));
    await flush();
    await flush();
    expect(r.remember).toHaveBeenCalledTimes(1);
    expect(r.remember.mock.calls[0][1]).toBe('FYI');
    expect(r.notify).not.toHaveBeenCalled();
    const i = setup({ decision: { action: 'ignore', reason: 'noise', urgent: false } });
    i.bus.publish(ev('avatar.inbox'));
    await flush();
    await flush();
    expect(i.notify).not.toHaveBeenCalled();
    expect(i.remember).not.toHaveBeenCalled();
    expect(i.journal[0].payload).toMatchObject({ action: 'ignore' });
  });

  it('do not disturb remembers without calling the model', async () => {
    const t = setup({ dnd: true });
    t.bus.publish(ev('avatar.inbox'));
    await flush();
    await flush();
    expect(t.deliberate).not.toHaveBeenCalled();
    expect(t.remember).toHaveBeenCalledTimes(1);
    expect(t.notify).not.toHaveBeenCalled();
    expect(t.journal[0].payload).toMatchObject({ action: 'remember', doNotDisturb: true });
  });

  it('priority urgent bypasses the model and do not disturb', async () => {
    const t = setup({ dnd: true });
    t.bus.publish(ev('avatar.inbox', { priority: 'urgent' }));
    await flush();
    expect(t.deliberate).not.toHaveBeenCalled();
    expect(t.notify).toHaveBeenCalledWith('hello', { urgent: true, source: undefined });
  });

  it('falls back to speaking when idle if the model fails or throws', async () => {
    for (const decision of [null, new Error('boom')]) {
      const t = setup({ decision });
      t.bus.publish(ev('avatar.inbox'));
      await flush();
      await flush();
      expect(t.notify).toHaveBeenCalledWith('hello', { urgent: false, source: undefined });
      expect(t.journal[0].payload).toMatchObject({ fallback: true });
    }
  });

  it('closes the incoming txn and still drops expired events', async () => {
    const t = setup();
    t.bus.publish(ev('avatar.inbox', { txn: { id: 'turn:1', state: 'open' } }));
    t.bus.publish(ev('avatar.inbox', { expires: '2000-01-01T00:00:00Z' }));
    await flush();
    await flush();
    expect(t.deliberate).toHaveBeenCalledTimes(1);
    expect(t.journal).toHaveLength(1);
    expect(t.journal[0].txn).toEqual({ id: 'turn:1', state: 'done' });
  });
});

describe('notify lambdas go through the inbox', () => {
  it('mirror.noteQueued reaches notify via the local bus', async () => {
    const bus = new LocalOnlyBus(makeEventId);
    const notify = vi.fn();
    new AvatarInbox({ avatarId: 'echo', bus, notify }).start();
    new SwitchboardMirror({ client: bus, node: 'n' }).noteQueued('Task 1 needs an answer', true);
    expect(notify).not.toHaveBeenCalled();
    await flush();
    expect(notify).toHaveBeenCalledWith('Task 1 needs an answer', { urgent: true, source: undefined });
  });
});

class FakeWs implements WebSocketLike {
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.onclose?.({}); }
  open() { this.onopen?.({}); }
  serve(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

describe('client subscription', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('delivers locally while disconnected, dedupes the replay, resumes with since', async () => {
    const sockets: FakeWs[] = [];
    const fetchFn = vi.fn(async () => new Response('{"ids":[]}'));
    const client = new SwitchboardClient({ baseUrl: 'http://sb', fetchFn: fetchFn as unknown as typeof fetch, webSocketFactory: () => { const w = new FakeWs(); sockets.push(w); return w; } });
    const got: SwitchboardEvent[] = [];
    client.subscribe({ to: ['avatar:echo'], onEvent: (e) => got.push(e) });
    expect(client.connected()).toBe(false);
    const local = client.publish(ev('avatar.inbox'))!;
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((r) => setImmediate(r));
    expect(got.map((e) => e.id)).toEqual([local.id]);

    sockets[0].open();
    expect(sockets[0].sent[0]).toMatchObject({ op: 'hello', since: null, subscribe: { to: ['avatar:echo'], observe: false } });
    sockets[0].serve({ op: 'welcome' });
    expect(client.connected()).toBe(true);
    sockets[0].serve({ op: 'event', event: local }); // replay of what was delivered locally
    sockets[0].serve({ op: 'event', event: { ...local, id: 'X'.repeat(26) } });
    expect(got).toHaveLength(2);

    // Connected: a publish is not looped back.
    client.publish(ev('avatar.inbox'));
    await new Promise((r) => setImmediate(r));
    expect(got).toHaveLength(2);

    sockets[0].close();
    expect(client.connected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].sent[0]).toMatchObject({ since: 'X'.repeat(26) });
    await client.stop();
  });
});

describe('approvals and task parentage', () => {
  it('uses requestedBy and approvers; hangs a task under the start tool call', () => {
    const events: SwitchboardEventInput[] = [];
    const mirror = new SwitchboardMirror({ client: { publish: (e) => events.push(e) }, node: 'n' });
    mirror.approvalRequested({ id: 'a', toolId: 't', toolName: 'x', params: {}, summary: 's', createdAt: 0, expiresAt: 1, source: 'voice', cardOnly: false, requestedBy: 'tool:coding', approvers: ['person:ann'] });
    expect(events[0].producer).toMatchObject({ kind: 'tool', id: 'coding' });
    expect(events[0].to).toEqual(['person:ann']);
    mirror.toolResult({ name: 'start_coding_task', arguments: {}, result: 'Started task T-1 in ws. It runs', ok: true, at: 1 }, 'r1');
    mirror.runnerEvent({ task_id: 'T-1', status: 'running' } as never);
    expect(events[2].txn).toMatchObject({ id: 'task:T-1', parent: 'tool:r1:1' });
  });
});
