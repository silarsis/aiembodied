import { describe, expect, it } from 'vitest';
import { SwitchboardMirror } from '../src/switchboard/mirror.js';
import type { SwitchboardEventInput } from '../src/switchboard/types.js';
import type { PendingApproval } from '../src/tools/approvals.js';

function setup() {
  const events: SwitchboardEventInput[] = [];
  const mirror = new SwitchboardMirror({ client: { publish: (e) => void events.push(e) }, node: 'bija' });
  return { events, mirror };
}

const approval: PendingApproval = { id: 'ap-1', toolId: 't', toolName: 'coding_start', params: {}, summary: 'start a task', createdAt: 0, expiresAt: Date.UTC(2026, 0, 1), source: 'voice', cardOnly: false };

describe('SwitchboardMirror', () => {
  it('skips previews entirely', () => {
    const { events, mirror } = setup();
    mirror.turnStarted('r1', { text: 'hello', preview: true });
    expect(events).toEqual([]);
  });

  it('mirrors a Kevin turn and its reply under one txn', () => {
    const { events, mirror } = setup();
    mirror.turnStarted('r1', { text: 'hello  there' });
    mirror.turnFinished('r1', { text: 'Hi!', cancelled: false });
    mirror.turnFinished('r2', { text: '', cancelled: true });
    mirror.turnFinished('r3', { text: '', error: 'boom' });
    expect(events[0]).toMatchObject({ type: 'speech.heard', producer: { kind: 'person', id: 'kevin' }, to: ['avatar:echo'], txn: { id: 'turn:r1', state: 'open', title: 'hello there' } });
    expect(events[1]).toMatchObject({ type: 'avatar.utterance', producer: { kind: 'avatar', id: 'echo' }, to: ['person:kevin'], txn: { id: 'turn:r1', state: 'done' }, payload: { text: 'Hi!' } });
    expect(events[2].txn?.state).toBe('cancelled');
    expect(events[3].txn?.state).toBe('failed');
  });

  it('mirrors a system turn as avatar.note from the app', () => {
    const { events, mirror } = setup();
    mirror.turnStarted('r1', { text: 'updates', system: true });
    expect(events[0]).toMatchObject({ type: 'avatar.note', producer: { kind: 'service', id: 'app' }, payload: { system: true }, txn: { id: 'turn:r1', state: 'open' } });
  });

  it('mirrors tool results with a parent turn, clipped result and privacy', () => {
    const { events, mirror } = setup();
    mirror.toolResult({ name: 'web_search', arguments: { q: 'x' }, result: 'a'.repeat(5000), ok: true, at: 5 }, 'r1');
    mirror.toolResult({ name: 'home_history', arguments: {}, result: 'no', ok: false, at: 6 }, 'r1');
    mirror.toolResult({ name: 'recall', arguments: {}, result: 'x', ok: true, at: 7 });
    expect(events[0]).toMatchObject({ type: 'tool.result', producer: { kind: 'tool', id: 'web_search' }, txn: { id: 'tool:r1:1', parent: 'turn:r1', state: 'done', title: 'web_search' }, audience: 'household' });
    expect((events[0].payload as { result: string }).result.length).toBeLessThanOrEqual(2001);
    expect(events[1]).toMatchObject({ txn: { id: 'tool:r1:2', state: 'failed' }, audience: 'private' });
    expect(events[2].txn?.parent).toBeUndefined();
    expect(events[2].txn?.id).toContain('tool:7:recall');
  });

  it('mirrors approval requests and outcomes', () => {
    const { events, mirror } = setup();
    mirror.approvalRequested(approval);
    mirror.approvalOutcome({ approval, decision: 'approved', by: 'card', ok: true, delivered: false });
    mirror.approvalOutcome({ approval, decision: 'approved', by: 'voice', ok: false, delivered: false });
    mirror.approvalOutcome({ approval, decision: 'declined', by: 'card', delivered: false });
    mirror.approvalOutcome({ approval, decision: 'expired', by: 'timeout', delivered: false });
    expect(events[0]).toMatchObject({ type: 'approval.requested', to: ['person:kevin'], txn: { id: 'approval:ap-1', state: 'waiting', deadline: '2026-01-01T00:00:00.000Z' } });
    expect(events.slice(1).map((e) => e.txn?.state)).toEqual(['done', 'failed', 'cancelled', 'expired']);
    expect(events[1].producer).toMatchObject({ kind: 'person', id: 'kevin' });
    expect(events[4].producer).toMatchObject({ kind: 'service', id: 'app' });
  });

  it('maps runner events to task.status and emits each question once', () => {
    const { events, mirror } = setup();
    mirror.runnerEvent({ task_id: null });
    mirror.runnerEvent({ task_id: 't1', status: 'running' });
    mirror.runnerEvent({ task_id: 't1', status: 'running' });
    const question = { id: 'q1', kind: 'confirm' as const, method: 'confirm', title: 'Run it?' };
    mirror.runnerEvent({ task_id: 't1', status: 'paused', questions: [question] });
    mirror.runnerEvent({ task_id: 't1', status: 'paused', questions: [question] });
    mirror.runnerEvent({ task_id: 't1', status: 'done' });
    const status = events.filter((e) => e.type === 'task.status');
    expect(status.map((e) => e.txn?.state)).toEqual(['open', 'progress', 'waiting', 'waiting', 'done']);
    expect(status[0]).toMatchObject({ producer: { kind: 'tool', id: 'coding' }, to: ['avatar:echo'], txn: { id: 'task:t1' } });
    expect(status[0].payload).not.toHaveProperty('questions');
    const questions = events.filter((e) => e.type === 'tool.question');
    expect(questions).toHaveLength(1);
    expect(questions[0].txn).toMatchObject({ id: 'question:t1:q1', parent: 'task:t1', state: 'waiting' });
  });

  it('mirrors queued updates with priority', () => {
    const { events, mirror } = setup();
    mirror.noteQueued('urgent one', true);
    mirror.noteQueued('calm one', false);
    expect(events.map((e) => [e.type, e.priority])).toEqual([['avatar.inbox', 'high'], ['avatar.inbox', 'normal']]);
    expect(events[0].payload).toEqual({ text: 'urgent one' });
  });

  it('never throws when the client does', () => {
    const mirror = new SwitchboardMirror({ client: { publish: () => { throw new Error('x'); } } });
    expect(() => mirror.noteQueued('a', false)).not.toThrow();
  });
});
