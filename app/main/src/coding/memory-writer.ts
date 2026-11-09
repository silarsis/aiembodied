/**
 * Makes Echo remember its coding work. When the runner reports a task that has ended (done,
 * failed, cancelled or discarded), or a later change to its pull request, the task is read from
 * the runner and handed to `post`, which writes it to the memory engine (through the outbox, so
 * it survives the engine being down). Each task is posted once per outcome and pull request
 * state; the engine updates the same memory if it is posted again, so a repeat after a restart
 * does no harm.
 */
import type { MemoryEngineCodingTask } from '../memory-engine/client.js';
import type { RunnerEvent, RunnerTask } from './runner-client.js';

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

const OUTCOMES = new Set(['done', 'failed', 'cancelled', 'discarded']);
const MAX_FILES = 200;
const MAX_SUMMARY = 4000;

export interface CodingMemoryWriterOptions {
  getTask: (id: string) => Promise<RunnerTask | null>;
  workspaceName: (id: string | undefined) => string;
  post: (task: MemoryEngineCodingTask) => void;
  /** The character's name, kept with the memory. */
  agentName?: () => string | null;
  logger?: Logger;
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** The files a task changed: the review's list, else what pi touched. */
function changedFiles(task: RunnerTask): string[] {
  const review = task.review;
  const files = review?.changed_files?.length ? review.changed_files : review?.files?.map((f) => f.path) ?? task.files_touched ?? [];
  return files.slice(0, MAX_FILES);
}

/** What pi said at the end, or else why the task ended the way it did. */
function summaryOf(task: RunnerTask): string {
  const text = task.last_text?.trim() || (task.status === 'failed' ? task.error?.trim() : '') || task.phase_detail?.trim() || '';
  return cut(text, MAX_SUMMARY);
}

export class CodingMemoryWriter {
  private readonly posted = new Set<string>();

  constructor(private readonly options: CodingMemoryWriterOptions) {}

  /** A message from the runner's event stream. */
  async handleEvent(event: RunnerEvent): Promise<void> {
    const id = event.task_id;
    if (!id) return;
    const isPr = event.type === 'pr';
    if (!isPr && !(event.status && OUTCOMES.has(event.status))) return;
    try {
      const task = await this.options.getTask(id);
      if (!task || !OUTCOMES.has(task.status)) return;
      const body = this.build(task, isPr ? event.pr_state : undefined);
      const key = `${body.task_id}:${body.outcome}:${body.pr_state ?? ''}`;
      if (this.posted.has(key)) return;
      this.posted.add(key);
      this.options.post(body);
      this.options.logger?.info('Coding task kept in memory', { task: id, outcome: body.outcome });
    } catch (error) {
      this.options.logger?.warn('Could not keep a coding task in memory', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The memory engine's form of a runner task. `prState` comes from a "pr" event, if that is what we heard. */
  build(task: RunnerTask, prState?: string | null): MemoryEngineCodingTask {
    const review = task.review;
    const flags = [...(review?.protected_violations ?? []).map((v) => `protected: ${v}`), ...(review?.flags ?? [])];
    return {
      task_id: task.id,
      workspace_id: task.workspace_id ?? 'unknown',
      workspace_name: this.options.workspaceName(task.workspace_id),
      title: cut((task.goal ?? '').replace(/\s+/g, ' ').trim() || `Task ${task.id}`, 2000),
      outcome: task.status as MemoryEngineCodingTask['outcome'],
      pr_url: task.pr_url ?? null,
      pr_state: prState ?? task.pr_state ?? null,
      branch: task.branch ?? null,
      files_changed: changedFiles(task),
      added: review?.added ?? 0,
      removed: review?.deleted ?? 0,
      review_flags: flags.slice(0, 50),
      summary: summaryOf(task),
      model: task.model ?? null,
      provider: task.provider ?? null,
      agent: this.options.agentName?.() ?? null,
      started_at: task.created_at ?? null,
      finished_at: task.updated_at ?? new Date().toISOString(),
    };
  }
}
