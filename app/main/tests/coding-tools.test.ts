import { describe, expect, it, vi } from 'vitest';
import { CODING_TOOL_IDS, createCodingTools } from '../src/coding/tools.js';
import type { RunnerTask } from '../src/coding/runner-client.js';
import type { CodingWorkspace } from '../src/coding/types.js';

const workspaces: CodingWorkspace[] = [
  { id: 'aiembodied', name: 'aiembodied', path: '/src/a', kind: 'self', baseBranch: 'main' },
  { id: 'notes', name: 'Notes', path: '/src/n', kind: 'project', baseBranch: 'main' },
];

function task(overrides: Partial<RunnerTask> = {}): RunnerTask {
  return { id: '20261108-1a2b', status: 'working', workspace_id: 'aiembodied', goal: 'Fix the retry', files_touched: [], questions: [], ...overrides };
}

function setup(tasks: RunnerTask[] = [task()]) {
  const client = {
    capabilities: vi.fn(async () => ({
      backend: { models: [{}, {}] },
      workspaces: [],
      track_record: [{ workspace_id: 'aiembodied', started: 3, done: 2, failed: 1, with_pr: 1 }],
    })),
    getSettings: vi.fn(async () => ({ local_llm_url: '', local_model: '', default_model: { provider: 'local' as const, id: 'qwen3-coder-next' } })),
    getWorkspaces: vi.fn(async () => []),
    listTasks: vi.fn(async () => tasks),
    createTask: vi.fn(async (request: { workspace_id: string }) => task({ id: 'new1', status: 'queued', workspace_id: request.workspace_id })),
    steer: vi.fn(async () => task()),
    followUp: vi.fn(async () => task()),
    answer: vi.fn(async () => task()),
    apply: vi.fn(async () => task({ status: 'done', pr_url: 'https://github.com/a/b/pull/7' })),
    discard: vi.fn(async () => task({ status: 'discarded' })),
  };
  const suppressNudge = vi.fn();
  const tools = createCodingTools({ client: () => client, workspaces: () => workspaces, suppressNudge });
  const byId = (id: string) => tools.find((tool) => tool.id === id)!;
  return { client, tools, byId, suppressNudge };
}

describe('coding tools', () => {
  it('registers the nine tools with the right levels', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.id).sort()).toEqual(Object.values(CODING_TOOL_IDS).sort());
    const levels = Object.fromEntries(tools.map((t) => [t.toolName, t.confirmationLevel]));
    expect(levels).toMatchObject({
      coding_capabilities: 'none',
      list_coding_tasks: 'none',
      coding_task_status: 'none',
      review_coding_task: 'none',
      start_coding_task: 'confirm',
      apply_coding_task: 'confirm',
      steer_coding_task: 'notify',
      answer_coding_question: 'notify',
      discard_coding_task: 'notify',
    });
    expect(tools.every((t) => t.serverId === 'coding' && typeof t.describeCall === 'function')).toBe(true);
  });

  it('summarizes capabilities in a few lines', async () => {
    const { byId } = setup();
    const text = (await byId(CODING_TOOL_IDS.capabilities).execute({})) as string;
    expect(text).toContain('- aiembodied (your own code): 3 started, 2 done, 1 failed, 1 with a pull request');
    expect(text).toContain('- Notes: no tasks yet');
    expect(text).toContain('Model: qwen3-coder-next (local).');
    expect(text.split('\n').length).toBeLessThan(8);
  });

  it('lists tasks one per line', async () => {
    const { byId } = setup([task({ pr_url: 'https://x/pull/1', status: 'done' }), task({ id: 'b', goal: 'Other' })]);
    const text = (await byId(CODING_TOOL_IDS.list).execute({})) as string;
    expect(text.split('\n')).toEqual([
      '20261108-1a2b [aiembodied] Fix the retry - done https://x/pull/1',
      'b [aiembodied] Other - working',
    ]);
  });

  it('reports one task, with at most ten files and the waiting questions', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    const { byId } = setup([
      task({
        status: 'question',
        files_touched: files,
        current_tool: 'write',
        questions: [{ id: 'a1', kind: 'ask_echo', method: 'input', message: 'Which port?' }],
        error: null,
      }),
    ]);
    const text = (await byId(CODING_TOOL_IDS.status).execute({})) as string;
    expect(text).toContain('Status: question');
    expect(text).toContain('Files touched (12): f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts, f8.ts, f9.ts, and more');
    expect(text).not.toContain('f10.ts');
    expect(text).toContain('Waiting for an answer [a1] Which port?');
  });

  it('accepts the end of a task id and rejects unknown ones', async () => {
    const { byId } = setup();
    expect(await byId(CODING_TOOL_IDS.status).execute({ task_id: '1a2b' })).toContain('Task 20261108-1a2b');
    await expect(byId(CODING_TOOL_IDS.status).execute({ task_id: 'zzzz' })).rejects.toThrow('There is no coding task zzzz');
  });

  it('starts a task by workspace name or id', async () => {
    const { byId, client } = setup();
    const result = await byId(CODING_TOOL_IDS.start).execute({ workspace: 'notes', goal: 'Add a README', acceptance: ['it exists', ' '], scope: 'docs/\nREADME.md' });
    expect(client.createTask).toHaveBeenCalledWith({ workspace_id: 'notes', goal: 'Add a README', acceptance: ['it exists'], scope: ['docs/', 'README.md'] });
    expect(result).toContain('Started task new1 in Notes (waiting in the queue)');
    await expect(byId(CODING_TOOL_IDS.start).execute({ workspace: 'nope', goal: 'x' })).rejects.toThrow('Choose one of: aiembodied, Notes');
    await expect(byId(CODING_TOOL_IDS.start).execute({ workspace: 'notes' })).rejects.toThrow('needs a goal');
  });

  it('steers a working task and follows up a task in review', async () => {
    const working = setup([task({ status: 'working' })]);
    await working.byId(CODING_TOOL_IDS.steer).execute({ message: 'use the helper' });
    expect(working.client.steer).toHaveBeenCalledWith('20261108-1a2b', 'use the helper');
    const review = setup([task({ status: 'review' })]);
    await review.byId(CODING_TOOL_IDS.steer).execute({ message: 'add a test' });
    expect(review.client.followUp).toHaveBeenCalledWith('20261108-1a2b', 'add a test');
  });

  it('answers the first question, or the one named; a permission question needs yes or no', async () => {
    const questions = [
      { id: 'c1', kind: 'confirm' as const, method: 'confirm', title: 'Recursive delete' },
      { id: 'a1', kind: 'ask_echo' as const, method: 'input', message: 'Which port?' },
    ];
    const { byId, client } = setup([task({ status: 'question', questions })]);
    await byId(CODING_TOOL_IDS.answer).execute({ answer: '8080', dialog_id: 'a1' });
    expect(client.answer).toHaveBeenCalledWith('20261108-1a2b', { value: '8080', dialog_id: 'a1' });
    await expect(byId(CODING_TOOL_IDS.answer).execute({ answer: '8080' })).rejects.toThrow('yes or no');
    await byId(CODING_TOOL_IDS.answer).execute({ answer: 'No, do not.' });
    expect(client.answer).toHaveBeenLastCalledWith('20261108-1a2b', { confirmed: false, dialog_id: 'c1' });
  });

  it('reviews with checks, a diff stat and a verdict hint', async () => {
    const review = { summary: '2 file(s) changed, +10 -3', files: [{ path: 'a.ts', added: 8, deleted: 1 }, { path: 'b.ts', added: 2, deleted: 2 }], flags: ['lockfile changed: pnpm-lock.yaml'], protected_violations: [] };
    const { byId } = setup([task({ status: 'review', review, checks_ok: false, checks_output: 'a\nb\nFAIL test x', last_text: 'Done.' })]);
    const text = (await byId(CODING_TOOL_IDS.review).execute({})) as string;
    expect(text).toContain('Checks: FAILED');
    expect(text).toContain('FAIL test x');
    expect(text).toContain('  a.ts +8 -1');
    expect(text).toContain('Verdict hint: be careful. checks failed; lockfile changed: pnpm-lock.yaml.');
    const clean = setup([task({ status: 'review', review: { summary: '1 file(s) changed', files: [], flags: [] }, checks_ok: true })]);
    expect(await clean.byId(CODING_TOOL_IDS.review).execute({})).toContain('Verdict hint: looks fine');
  });

  it('opens the pull request, and only the card may approve it for a self workspace', async () => {
    const { byId, client, suppressNudge } = setup([task({ status: 'review', workspace_id: 'aiembodied' })]);
    const apply = byId(CODING_TOOL_IDS.apply);
    expect(await apply.cardOnly?.({})).toBe(true);
    const result = await apply.execute({});
    expect(suppressNudge).toHaveBeenCalledWith('20261108-1a2b', 'done');
    expect(client.apply).toHaveBeenCalledWith('20261108-1a2b');
    expect(result).toBe('Pull request opened: https://github.com/a/b/pull/7');
    const project = setup([task({ status: 'review', workspace_id: 'notes' })]);
    expect(await project.byId(CODING_TOOL_IDS.apply).cardOnly?.({})).toBe(false);
  });

  it('asks which task when several are in review and none is named', async () => {
    const { byId } = setup([task({ id: 'a', status: 'review' }), task({ id: 'b', status: 'review' })]);
    await expect(byId(CODING_TOOL_IDS.apply).execute({})).rejects.toThrow('Say which one with task_id');
    await expect(byId(CODING_TOOL_IDS.apply).execute({ task_id: 'a' })).resolves.toContain('Pull request opened');
  });

  it('discards a task', async () => {
    const { byId, client } = setup([task({ status: 'review' })]);
    expect(await byId(CODING_TOOL_IDS.discard).execute({})).toBe('Discarded task 20261108-1a2b.');
    expect(client.discard).toHaveBeenCalledWith('20261108-1a2b');
  });

  it('fails clearly when the runner is not connected', async () => {
    const tools = createCodingTools({ client: () => null, workspaces: () => workspaces });
    await expect(tools[1].execute({})).rejects.toThrow('The coding runner is not running.');
  });
});
