import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodingTasksBridge, RunnerEvent, RunnerTask } from '../../../main/src/coding/bridge-types.js';
import type { ApprovalView, ApprovalsBridge } from '../../../main/src/tools/approvals-ipc.js';
import { ApprovalsCard } from '../../src/status/approvals-card.js';
import { CodingTasksPanel, sortTasks } from '../../src/status/coding-tasks.js';

afterEach(cleanup);

const view = (overrides: Partial<ApprovalView> = {}): ApprovalView => ({
  id: 'ap1',
  toolName: 'start_coding_task',
  summary: 'start a coding task in aiembodied: Fix X',
  createdAt: 0,
  expiresAt: 1,
  cardOnly: false,
  source: 'voice',
  ...overrides,
});

describe('ApprovalsCard', () => {
  it('shows nothing when nothing waits', async () => {
    const api: ApprovalsBridge = { list: vi.fn(async () => []), approve: vi.fn(), decline: vi.fn(), onChanged: vi.fn(() => () => undefined) };
    const { container } = render(<ApprovalsCard api={api} />);
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('lists pending approvals with Approve and Decline, and follows pushes', async () => {
    let push: (list: ApprovalView[]) => void = () => undefined;
    const api: ApprovalsBridge = {
      list: vi.fn(async () => [view()]),
      approve: vi.fn(async () => ({ decision: 'approved', ok: true })),
      decline: vi.fn(async () => ({ decision: 'declined' })),
      onChanged: vi.fn((listener) => {
        push = listener;
        return () => undefined;
      }),
    };
    render(<ApprovalsCard api={api} />);
    const item = await screen.findByTestId('approval');
    expect(within(item).getByText('start a coding task in aiembodied: Fix X')).toBeTruthy();
    expect(within(item).getByText('You can also say yes or no.')).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('ap1'));
    push([view({ id: 'ap2', cardOnly: true })]);
    const next = await screen.findByText('This one can only be approved here, not by voice.');
    expect(next).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(api.decline).toHaveBeenCalledWith('ap2'));
  });

  it('says so when an approved tool failed', async () => {
    const api: ApprovalsBridge = {
      list: vi.fn(async () => [view()]),
      approve: vi.fn(async () => ({ decision: 'approved', ok: false, result: 'runner down' })),
      decline: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
    };
    render(<ApprovalsCard api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toContain('runner down');
  });
});

const task = (overrides: Partial<RunnerTask> = {}): RunnerTask => ({
  id: 't1',
  status: 'working',
  workspace_id: 'aiembodied',
  goal: 'Fix the retry',
  files_touched: ['a.ts', 'b.ts'],
  current_tool: 'write',
  phase_detail: 'pi started',
  questions: [],
  ...overrides,
});

function tasksApi(tasks: RunnerTask[]) {
  let push: (event: RunnerEvent) => void = () => undefined;
  const api: CodingTasksBridge = {
    list: vi.fn(async () => tasks),
    get: vi.fn(),
    diff: vi.fn(async () => 'diff --git a/a.ts b/a.ts\n+hello'),
    start: vi.fn(async () => task({ id: 'new' })),
    answer: vi.fn(async () => task()),
    followUp: vi.fn(async () => task()),
    cancel: vi.fn(async () => task()),
    discard: vi.fn(async () => task()),
    apply: vi.fn(async () => task()),
    onEvent: vi.fn((listener) => {
      push = listener;
      return () => undefined;
    }),
  };
  return { api, push: (e: RunnerEvent) => push(e) };
}

const codingApi = {
  get: vi.fn(async () => ({
    coding: { runner: 'r', workspaces: [{ id: 'aiembodied', name: 'aiembodied', path: '/a', kind: 'self' as const, baseBranch: 'main' }, { id: 'notes', name: 'Notes', path: '/n', kind: 'project' as const, baseBranch: 'main' }] },
    runnerId: 'r',
    status: {} as never,
  })),
};

describe('CodingTasksPanel', () => {
  it('sorts active tasks first and limits the finished ones', () => {
    const list = [task({ id: 'd1', status: 'done' }), task({ id: 'w', status: 'working' }), ...Array.from({ length: 6 }, (_, i) => task({ id: `d${i + 2}`, status: 'failed' }))];
    expect(sortTasks(list).map((t) => t.id)).toEqual(['w', 'd1', 'd2', 'd3', 'd4']);
  });

  it('shows a working task with its tool, files and a cancel button', async () => {
    const { api } = tasksApi([task()]);
    render(<CodingTasksPanel api={api} codingApi={codingApi} active />);
    const card = await screen.findByTestId('coding-task');
    expect(card.textContent).toContain('Fix the retry');
    expect(card.textContent).toContain('working - using write - pi started');
    expect(card.textContent).toContain('2 file(s) touched');
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('t1'));
  });

  it('answers a question from pi', async () => {
    const { api } = tasksApi([task({ status: 'question', questions: [{ id: 'a1', kind: 'ask_echo', method: 'input', message: 'Which port?' }] })]);
    render(<CodingTasksPanel api={api} codingApi={codingApi} active />);
    const q = await screen.findByTestId('coding-question');
    expect(q.textContent).toContain('Which port?');
    fireEvent.change(within(q).getByLabelText('Your answer'), { target: { value: '8080' } });
    fireEvent.click(within(q).getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { value: '8080', dialog_id: 'a1' }));
  });

  it('allows or denies a permission question', async () => {
    const { api } = tasksApi([task({ status: 'question', questions: [{ id: 'c1', kind: 'confirm', method: 'confirm', title: 'Recursive delete', message: 'rm -rf build' }] })]);
    render(<CodingTasksPanel api={api} codingApi={codingApi} active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { confirmed: false, dialog_id: 'c1' }));
  });

  it('shows a review with flags and checks, the diff, follow-up, apply and discard', async () => {
    const { api } = tasksApi([
      task({
        status: 'review',
        checks_ok: false,
        checks_output: 'FAIL test x',
        review: { summary: '2 file(s) changed, +10 -3', flags: ['lockfile changed: pnpm-lock.yaml'], protected_violations: [] },
      }),
    ]);
    render(<CodingTasksPanel api={api} codingApi={codingApi} active />);
    const review = await screen.findByTestId('coding-review');
    expect(review.textContent).toContain('2 file(s) changed, +10 -3');
    expect(review.textContent).toContain('Flag: lockfile changed: pnpm-lock.yaml');
    expect(review.textContent).toContain('Checks failed');
    expect(review.textContent).toContain('FAIL test x');

    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    expect((await screen.findByTestId('coding-diff')).textContent).toContain('+hello');

    fireEvent.change(screen.getByLabelText('Follow-up'), { target: { value: 'add a test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Follow-up' }));
    await waitFor(() => expect(api.followUp).toHaveBeenCalledWith('t1', 'add a test'));

    fireEvent.click(screen.getByRole('button', { name: 'Approve and open pull request' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith('t1'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.discard).toHaveBeenCalledWith('t1'));
  });

  it('does not offer Apply when a protected path changed', async () => {
    const { api } = tasksApi([task({ status: 'review', review: { summary: 's', protected_violations: ['services/coder/x.py'] } })]);
    render(<CodingTasksPanel api={api} codingApi={codingApi} active />);
    const button = await screen.findByRole('button', { name: /Approve and open pull request/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts a task by hand', async () => {
    const { api } = tasksApi([]);
    render(<CodingTasksPanel api={api} codingApi={codingApi} active />);
    const form = await screen.findByRole('form', { name: 'Start a task' });
    await waitFor(() => expect(within(form).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(within(form).getByLabelText('Workspace'), { target: { value: 'notes' } });
    fireEvent.change(within(form).getByLabelText('Goal'), { target: { value: 'Add a README' } });
    fireEvent.change(within(form).getByLabelText(/Acceptance/), { target: { value: 'it exists\n\nit has a title' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith({ workspace_id: 'notes', goal: 'Add a README', acceptance: ['it exists', 'it has a title'] }));
  });

  it('refreshes when the runner reports a change, and shows waiting updates', async () => {
    const { api, push } = tasksApi([task()]);
    const localVoice = { systemStatus: vi.fn(async () => ({ pending: 2, ready: false, texts: [] })) };
    render(<CodingTasksPanel api={api} codingApi={codingApi} localVoice={localVoice} active />);
    await screen.findByTestId('coding-task');
    expect((await screen.findByTestId('coding-waiting')).textContent).toContain('2 updates waiting');
    const calls = (api.list as ReturnType<typeof vi.fn>).mock.calls.length;
    push({ task_id: 't1', status: 'review' });
    await waitFor(() => expect((api.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls));
  });
});
