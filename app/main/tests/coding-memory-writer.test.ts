import { describe, expect, it, vi } from 'vitest';
import { CodingMemoryWriter } from '../src/coding/memory-writer.js';
import type { RunnerTask } from '../src/coding/runner-client.js';

const done: RunnerTask = {
  id: 't1',
  status: 'done',
  workspace_id: 'aiembodied',
  goal: 'Fix the retry',
  branch: 'echo/t1-fix-the-retry',
  pr_url: 'https://github.com/x/y/pull/7',
  last_text: 'Added a retry with backoff.',
  review: { changed_files: ['a.ts', 'b.ts'], added: 10, deleted: 3, flags: ['lockfile changed: pnpm-lock.yaml'], protected_violations: [] },
  provider: 'local',
  model: 'qwen3-coder-next',
  created_at: '2026-11-08T10:00:00Z',
  updated_at: '2026-11-08T10:30:00Z',
};

function setup(tasks: Record<string, RunnerTask>) {
  const post = vi.fn();
  const writer = new CodingMemoryWriter({
    getTask: async (id) => tasks[id] ?? null,
    workspaceName: (id) => (id === 'aiembodied' ? 'aiembodied' : (id ?? '?')),
    post,
    agentName: () => 'Echo',
  });
  return { writer, post };
}

describe('CodingMemoryWriter', () => {
  it('posts a finished task with its review numbers, once', async () => {
    const { writer, post } = setup({ t1: done });
    await writer.handleEvent({ task_id: 't1', status: 'done' });
    await writer.handleEvent({ task_id: 't1', status: 'done' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({
      task_id: 't1',
      workspace_name: 'aiembodied',
      title: 'Fix the retry',
      outcome: 'done',
      pr_url: 'https://github.com/x/y/pull/7',
      files_changed: ['a.ts', 'b.ts'],
      added: 10,
      removed: 3,
      review_flags: ['lockfile changed: pnpm-lock.yaml'],
      summary: 'Added a retry with backoff.',
      agent: 'Echo',
      finished_at: '2026-11-08T10:30:00Z',
    });
  });

  it('ignores tasks that are still going', async () => {
    const { writer, post } = setup({ t1: { ...done, status: 'working' } });
    await writer.handleEvent({ task_id: 't1', status: 'working' });
    await writer.handleEvent({ task_id: 't1', status: 'review' });
    expect(post).not.toHaveBeenCalled();
  });

  it('uses the error as the summary of a failed task and handles missing review', async () => {
    const { writer, post } = setup({ t1: { id: 't1', status: 'failed', workspace_id: 'aiembodied', goal: 'X', error: 'checks failed', files_touched: ['z.ts'] } });
    await writer.handleEvent({ task_id: 't1', status: 'failed' });
    expect(post.mock.calls[0][0]).toMatchObject({ outcome: 'failed', summary: 'checks failed', files_changed: ['z.ts'], added: 0 });
  });

  it('posts again when the pull request changes state, but not for the same state twice', async () => {
    const { writer, post } = setup({ t1: done });
    await writer.handleEvent({ task_id: 't1', status: 'done' });
    await writer.handleEvent({ type: 'pr', task_id: 't1', pr_state: 'merged', ci_state: 'success' });
    await writer.handleEvent({ type: 'pr', task_id: 't1', pr_state: 'merged' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0].pr_state).toBe('merged');
  });

  it('caps the file list and summary', () => {
    const { writer } = setup({});
    const body = writer.build({ ...done, last_text: 'x'.repeat(5000), review: { changed_files: Array.from({ length: 300 }, (_, i) => `f${i}`) } });
    expect(body.files_changed).toHaveLength(200);
    expect(body.summary.length).toBe(4000);
  });
});
