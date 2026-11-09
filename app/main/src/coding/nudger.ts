/**
 * Turns what the coding runner reports (its event stream) and what happens to approvals into
 * short updates for Echo. The updates go to LocalVoiceService.notify(), which batches them and
 * runs a turn when the conversation is idle. A task needing an answer is urgent; the rest wait
 * their turn. Events for things Echo already saw in a tool result are not repeated.
 */
import { describeOutcome, type ApprovalOutcome } from '../tools/approvals.js';
import type { RunnerEvent, RunnerQuestion, RunnerTask } from './runner-client.js';

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

export interface CodingNudgerOptions {
  notify: (text: string, options: { urgent: boolean }) => void;
  getTask: (id: string) => Promise<RunnerTask | null>;
  workspaceName: (id: string | undefined) => string;
  logger?: Logger;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

export class CodingNudger {
  private readonly lastStatus = new Map<string, string>();
  private readonly seenQuestions = new Set<string>();
  private readonly suppressed = new Set<string>();

  constructor(private readonly options: CodingNudgerOptions) {}

  /** Echo is about to see the result of a call that moves `taskId` to `status`; do not announce it again. */
  suppress(taskId: string, status: string): void {
    this.suppressed.add(`${taskId}:${status}`);
  }

  /** A message from the runner's event stream. */
  async handleEvent(event: RunnerEvent): Promise<void> {
    const id = event.task_id;
    if (!id) return;
    try {
      for (const question of event.questions ?? []) {
        const key = `${id}:${question.id}`;
        if (this.seenQuestions.has(key)) continue;
        this.seenQuestions.add(key);
        const task = await this.options.getTask(id);
        this.send(this.questionText(id, task, question), true);
      }
      const status = event.status ?? undefined;
      if (!status || this.lastStatus.get(id) === status) return;
      this.lastStatus.set(id, status);
      if (status === 'paused') {
        // Once per pause: lastStatus only changes when the task leaves "paused" and comes back.
        this.send('The coding task is paused while you talk to Kevin; it resumes when things are quiet.', false);
        return;
      }
      if (!['review', 'done', 'failed'].includes(status)) return;
      if (this.suppressed.delete(`${id}:${status}`)) return;
      const task = await this.options.getTask(id);
      if (!task || task.status !== status) return;
      this.send(this.statusText(task), false);
    } catch (error) {
      this.options.logger?.warn('Coding update for Echo failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** An approval was settled somewhere other than in Echo's own turn (the card, or a time-out). */
  handleApproval(outcome: ApprovalOutcome): void {
    if (outcome.delivered) return;
    const tail =
      outcome.decision === 'approved' && outcome.ok
        ? ' Tell Kevin briefly what happened.'
        : outcome.decision === 'approved'
          ? ' Tell Kevin it did not work.'
          : ' Do not do it unless Kevin asks again.';
    this.send(`${describeOutcome(outcome)}${tail}`, false);
  }

  private label(task: RunnerTask | null, id: string): string {
    return task ? `Task ${id} (${this.options.workspaceName(task.workspace_id)}: ${clip(task.goal ?? '', 70)})` : `Task ${id}`;
  }

  private questionText(id: string, task: RunnerTask | null, q: RunnerQuestion): string {
    const who = this.label(task, id);
    if (q.kind === 'confirm') {
      return (
        `${who} wants permission: ${clip(q.title ?? 'a risky step', 80)}${q.message ? `: ${clip(q.message, 200)}` : ''}. ` +
        `Ask Kevin out loud. After he answers, call answer_coding_question with yes or no (dialog_id ${q.id}).`
      );
    }
    return (
      `${who} asks: "${clip(q.message ?? q.title ?? '', 300)}". ` +
      `If the brief or what you remember answers it, answer with answer_coding_question (dialog_id ${q.id}) and tell Kevin in one sentence what you answered. Otherwise ask Kevin briefly.`
    );
  }

  private statusText(task: RunnerTask): string {
    const who = this.label(task, task.id);
    if (task.status === 'review') {
      const files = task.review?.changed_files?.length ?? task.review?.files?.length ?? task.files_touched?.length ?? 0;
      const checks = task.checks_ok === null || task.checks_ok === undefined ? 'no checks configured' : task.checks_ok ? 'checks passed' : 'checks FAILED';
      const care = [...(task.review?.protected_violations ?? []).map((v) => `protected: ${v}`), ...(task.review?.flags ?? [])];
      return `${who} is ready for review: ${files} file(s) changed, ${checks}${care.length ? `, flags: ${care.join('; ')}` : ''}. Tell Kevin briefly. You can use review_coding_task for details, and ask whether to open a pull request.`;
    }
    if (task.status === 'done') {
      return task.pr_url
        ? `${who} is finished and the pull request is open: ${task.pr_url}. Tell Kevin briefly; do not read out the link.`
        : `${who} is finished. ${clip(task.phase_detail ?? 'No changes were needed.', 160)} Tell Kevin briefly.`;
    }
    return `${who} failed: ${clip(task.error ?? 'unknown reason', 200)}. Tell Kevin briefly and offer to try again.`;
  }

  private send(text: string, urgent: boolean): void {
    this.options.logger?.info('Update for Echo queued', { urgent, text: clip(text, 200) });
    this.options.notify(text, { urgent });
  }
}
