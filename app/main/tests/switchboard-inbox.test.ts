import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalOnlyBus } from '../src/switchboard/bus.js';
import { SwitchboardClient, makeEventId, type WebSocketLike } from '../src/switchboard/client.js';
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
    expect(lookupRule(DEFAULT_INBOX_POLICY, 'home.change')?.action).toBe('remember');
    expect(lookupRule(DEFAULT_INBOX_POLICY, 'speech.heard')?.action).toBe('ignore');
    expect(lookupRule({ 'home.*': { action: 'speak-idle' }, '*': { action: 'ignore' } }, 'home.door')?.action).toBe('speak-idle');
  });

  it('speaks by action and drops expired or textless events', async () => {
    const bus = new LocalOnlyBus(makeEventId);
    const notify = vi.fn();
    new AvatarInbox({ avatarId: 'echo', bus, notify, logger: warn }).start();
    bus.publish(ev('avatar.inbox', { priority: 'high' }));
    bus.publish(ev('avatar.inbox', { priority: 'normal', payload: { text: 'later', source: 'coding' } }));
    bus.publish(ev('home.alert', { payload: { text: 'Smoke in kitchen' } }));
    bus.publish(ev('home.change'));
    bus.publish(ev('speech.heard'));
    bus.publish(ev('avatar.inbox', { expires: '2000-01-01T00:00:00Z' }));
    bus.publish(ev('avatar.inbox', { payload: {} }));
    bus.publish(ev('avatar.inbox', { to: ['avatar:other'] }));
    await flush();
    expect(notify.mock.calls).toEqual([
      ['hello', { urgent: true, source: undefined }],
      ['later', { urgent: false, source: undefined }],
      ['Smoke in kitchen', { urgent: true, source: 'Home Assistant' }],
    ]);
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
