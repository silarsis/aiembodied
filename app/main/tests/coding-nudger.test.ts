import { describe, expect, it, vi } from 'vitest';
import { CodingNudger } from '../src/coding/nudger.js';
import type { RunnerTask } from '../src/coding/runner-client.js';
import type { ApprovalOutcome } from '../src/tools/approvals.js';

function setup(tasks: Record<string, RunnerTask>) {
  const notify = vi.fn();
  const nudger = new CodingNudger({
    notify,
    getTask: async (id) => tasks[id] ?? null,
    workspaceName: (id) => (id === 'aiembodied' ? 'aiembodied' : (id ?? '?')),
  });
  return { nudger, notify };
}

const base: RunnerTask = { id: 't1', status: 'working', workspace_id: 'aiembodied', goal: 'Fix X' };

describe('CodingNudger', () => {
  it('turns a new question into one urgent update, once', async () => {
    const question = { id: 'a1', kind: 'ask_echo' as const, method: 'input', message: 'Which port?' };
    const { nudger, notify } = setup({ t1: { ...base, status: 'question', questions: [question] } });
    await nudger.handleEvent({ task_id: 't1', status: 'question', questions: [question] });
    await nudger.handleEvent({ task_id: 't1', status: 'question', questions: [question] });
    expect(notify).toHaveBeenCalledTimes(1);
    const [text, options] = notify.mock.calls[0];
    expect(options).toEqual({ urgent: true });
    expect(text).toContain('Task t1 (aiembodied: Fix X) asks: "Which port?"');
    expect(text).toContain('answer_coding_question');
    expect(text).toContain('Otherwise ask Kevin briefly');
  });

  it('asks Kevin first for a permission question', async () => {
    const question = { id: 'c1', kind: 'confirm' as const, method: 'confirm', title: 'Recursive delete', message: 'rm -rf build' };
    const { nudger, notify } = setup({ t1: base });
    await nudger.handleEvent({ task_id: 't1', status: 'question', questions: [question] });
    expect(notify.mock.calls[0][0]).toContain('wants permission: Recursive delete: rm -rf build. Ask Kevin out loud');
  });

  it('announces review with checks and file count, not urgent', async () => {
    const { nudger, notify } = setup({
      t1: { ...base, status: 'review', checks_ok: false, review: { changed_files: ['a', 'b', 'c'], flags: ['lockfile changed'], protected_violations: [] } },
    });
    await nudger.handleEvent({ task_id: 't1', status: 'review' });
    await nudger.handleEvent({ task_id: 't1', status: 'review' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('is ready for review: 3 file(s) changed, checks FAILED, flags: lockfile changed');
    expect(notify.mock.calls[0][1]).toEqual({ urgent: false });
  });

  it('announces done with the pull request and failure with the error', async () => {
    const { nudger, notify } = setup({
      t1: { ...base, status: 'done', pr_url: 'https://github.com/a/b/pull/7' },
      t2: { ...base, id: 't2', status: 'failed', error: 'time limit' },
    });
    await nudger.handleEvent({ task_id: 't1', status: 'done' });
    await nudger.handleEvent({ task_id: 't2', status: 'failed' });
    expect(notify.mock.calls[0][0]).toContain('pull request is open: https://github.com/a/b/pull/7');
    expect(notify.mock.calls[1][0]).toContain('Task t2 (aiembodied: Fix X) failed: time limit');
  });

  it('stays quiet for working, cancelled, and the connect message', async () => {
    const { nudger, notify } = setup({ t1: base });
    await nudger.handleEvent({ task_id: null, local_model_needed: false });
    await nudger.handleEvent({ task_id: 't1', status: 'working' });
    await nudger.handleEvent({ task_id: 't1', status: 'cancelled' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not repeat what a tool result already told Echo', async () => {
    const { nudger, notify } = setup({ t1: { ...base, status: 'done', pr_url: 'https://x/pull/1' } });
    nudger.suppress('t1', 'done');
    await nudger.handleEvent({ task_id: 't1', status: 'done' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('passes on approvals settled on the card but not ones Echo already saw', () => {
    const { nudger, notify } = setup({});
    const approval = { id: 'ap1', toolId: 'x', toolName: 'start_coding_task', params: {}, summary: 'start a coding task', createdAt: 0, expiresAt: 1, source: 'voice' as const, cardOnly: false };
    const base: ApprovalOutcome = { approval, decision: 'approved', by: 'card', ok: true, result: 'Started task t9.', delivered: false };
    nudger.handleApproval(base);
    nudger.handleApproval({ ...base, delivered: true });
    nudger.handleApproval({ ...base, decision: 'declined' });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0][0]).toContain('Kevin approved: start a coding task. Done. Result: Started task t9.');
    expect(notify.mock.calls[1][0]).toContain('Kevin declined: start a coding task.');
  });
});
