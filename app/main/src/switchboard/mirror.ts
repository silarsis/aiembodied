/**
 * Phase 1 of the switchboard: copies what already happens in the app (voice turns, tool results,
 * approvals, coding runner events, queued updates) onto the bus as events. Nothing here changes
 * what the app does; every method only builds an envelope and hands it to the client, which
 * queues it. Preview turns are never mirrored.
 */
import os from 'node:os';
import type { RunnerEvent } from '../coding/runner-client.js';
import type { LocalVoiceToolRecord } from '../local-voice/local-voice-service.js';
import type { ApprovalOutcome, PendingApproval } from '../tools/approvals.js';
import type { SwitchboardEventInput, SwitchboardProducer, TxnState } from './types.js';

export const DEFAULT_AVATAR_ID = 'echo';
export const DEFAULT_PERSON_ID = 'kevin';

const TEXT_LIMIT = 2000;
const TITLE_LIMIT = 120;

export interface SwitchboardPublisher {
  publish(event: SwitchboardEventInput): unknown;
}

export interface SwitchboardMirrorOptions {
  client: SwitchboardPublisher;
  avatarId?: string;
  personId?: string;
  node?: string;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** Strings longer than the limit are cut, at any depth; the result is plain JSON-safe data. */
function clipDeep(value: unknown, limit: number, depth = 0): unknown {
  if (typeof value === 'string') return value.length <= limit ? value : `${value.slice(0, limit)}…`;
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clipDeep(item, limit, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = clipDeep(item, limit, depth + 1);
  return out;
}

function taskState(status: string | null | undefined, seen: boolean): TxnState {
  switch (status) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'review':
    case 'paused':
    case 'question':
      return 'waiting';
    default:
      return seen ? 'progress' : 'open';
  }
}

export class SwitchboardMirror {
  private readonly client: SwitchboardPublisher;
  private readonly avatarId: string;
  private readonly personId: string;
  private readonly node: string;
  private readonly seenTasks = new Set<string>();
  private readonly seenQuestions = new Set<string>();
  private readonly toolCounts = new Map<string, number>();
  private toolSerial = 0;

  constructor(options: SwitchboardMirrorOptions) {
    this.client = options.client;
    this.avatarId = options.avatarId ?? DEFAULT_AVATAR_ID;
    this.personId = options.personId ?? DEFAULT_PERSON_ID;
    this.node = options.node ?? os.hostname();
  }

  private avatar(): SwitchboardProducer {
    return { kind: 'avatar', id: this.avatarId, node: this.node };
  }
  private person(): SwitchboardProducer {
    return { kind: 'person', id: this.personId, node: this.node };
  }
  private service(): SwitchboardProducer {
    return { kind: 'service', id: 'app', node: this.node };
  }
  private toAvatar(): `avatar:${string}` {
    return `avatar:${this.avatarId}`;
  }
  private toPerson(): `person:${string}` {
    return `person:${this.personId}`;
  }

  private send(event: SwitchboardEventInput): void {
    try {
      this.client.publish(event);
    } catch {
      // The mirror must never disturb the app.
    }
  }

  /** A turn begins: Kevin spoke or typed, or the app is running a system turn. Previews are skipped. */
  turnStarted(requestId: string, turn: { text: string; system?: boolean; preview?: boolean }): void {
    if (turn.preview) return;
    const txn = { id: `turn:${requestId}`, state: 'open' as const, title: clip(turn.text, TITLE_LIMIT) || undefined };
    if (turn.system) {
      this.send({ type: 'avatar.note', producer: this.service(), to: [this.toAvatar()], txn, audience: 'household', payload: { system: true } });
      return;
    }
    this.send({ type: 'speech.heard', producer: this.person(), to: [this.toAvatar()], txn, audience: 'household', payload: { text: clip(turn.text, TEXT_LIMIT) } });
  }

  /** The turn ended with a reply, a cancel or an error. */
  turnFinished(requestId: string, outcome: { text: string; cancelled?: boolean; error?: string }): void {
    const state: TxnState = outcome.cancelled ? 'cancelled' : outcome.error ? 'failed' : 'done';
    const payload: Record<string, unknown> = { text: clip(outcome.text, TEXT_LIMIT) };
    if (outcome.error) payload.error = clip(outcome.error, 500);
    this.send({ type: 'avatar.utterance', producer: this.avatar(), to: [this.toPerson()], txn: { id: `turn:${requestId}`, state }, audience: 'household', payload });
  }

  /** A tool call finished. requestId is the turn it belongs to, if known. */
  toolResult(record: LocalVoiceToolRecord, requestId?: string): void {
    let txnId: string;
    let parent: string | undefined;
    if (requestId) {
      const n = (this.toolCounts.get(requestId) ?? 0) + 1;
      this.toolCounts.set(requestId, n);
      if (this.toolCounts.size > 200) this.toolCounts.delete(this.toolCounts.keys().next().value as string);
      txnId = `tool:${requestId}:${n}`;
      parent = `turn:${requestId}`;
    } else {
      this.toolSerial += 1;
      txnId = `tool:${record.at}:${record.name}:${this.toolSerial}`;
    }
    this.send({
      type: 'tool.result',
      producer: { kind: 'tool', id: record.name, node: this.node },
      to: [this.toAvatar()],
      txn: { id: txnId, parent, state: record.ok ? 'done' : 'failed', title: record.name },
      audience: record.name.startsWith('home_') ? 'private' : 'household',
      payload: { arguments: clipDeep(record.arguments, TEXT_LIMIT), result: clip(record.result, TEXT_LIMIT), ok: record.ok },
    });
  }

  approvalRequested(approval: PendingApproval): void {
    this.send({
      type: 'approval.requested',
      producer: this.avatar(),
      to: [this.toPerson()],
      txn: { id: `approval:${approval.id}`, state: 'waiting', title: clip(approval.summary, TITLE_LIMIT), deadline: new Date(approval.expiresAt).toISOString() },
      audience: 'household',
      payload: { tool: approval.toolName, summary: clip(approval.summary, TEXT_LIMIT), cardOnly: approval.cardOnly },
    });
  }

  approvalOutcome(outcome: ApprovalOutcome): void {
    let state: TxnState;
    if (outcome.decision === 'approved') state = outcome.ok === false ? 'failed' : 'done';
    else if (outcome.decision === 'declined') state = 'cancelled';
    else state = 'expired';
    const payload: Record<string, unknown> = { decision: outcome.decision, by: outcome.by };
    if (outcome.ok !== undefined) payload.ok = outcome.ok;
    if (outcome.result) payload.result = clip(outcome.result, TEXT_LIMIT);
    this.send({
      type: 'approval.decided',
      producer: outcome.by === 'timeout' ? this.service() : this.person(),
      to: [this.toAvatar()],
      txn: { id: `approval:${outcome.approval.id}`, state },
      audience: 'household',
      payload,
    });
  }

  /** A message from the coding runner's event stream. */
  runnerEvent(event: RunnerEvent): void {
    const taskId = event.task_id;
    if (!taskId) return;
    const txnId = `task:${taskId}`;
    const seen = this.seenTasks.has(taskId);
    const hasQuestions = (event.questions ?? []).length > 0;
    // Events with no status (pull request changes, current tool) keep the task in progress.
    const state = taskState(event.status ?? (hasQuestions ? 'question' : null), seen);
    this.seenTasks.add(taskId);
    const rest: Record<string, unknown> = { ...event };
    delete rest.questions;
    delete rest.question;
    this.send({
      type: 'task.status',
      producer: { kind: 'tool', id: 'coding', node: this.node },
      to: [this.toAvatar()],
      txn: { id: txnId, state },
      audience: 'household',
      payload: clipDeep(rest, TEXT_LIMIT) as Record<string, unknown>,
    });
    for (const q of event.questions ?? []) {
      const key = `${taskId}:${q.id}`;
      if (this.seenQuestions.has(key)) continue;
      this.seenQuestions.add(key);
      this.send({
        type: 'tool.question',
        producer: { kind: 'tool', id: 'coding', node: this.node },
        to: [this.toAvatar()],
        txn: { id: `question:${taskId}:${q.id}`, parent: txnId, state: 'waiting', title: clip(q.title ?? q.message ?? q.method, TITLE_LIMIT) },
        audience: 'household',
        priority: 'high',
        payload: clipDeep({ kind: q.kind, method: q.method, title: q.title, message: q.message, options: q.options }, TEXT_LIMIT) as Record<string, unknown>,
      });
    }
  }

  /** An update was queued for Echo (LocalVoiceService.notify). */
  noteQueued(text: string, urgent: boolean): void {
    this.send({
      type: 'avatar.inbox',
      producer: this.service(),
      to: [this.toAvatar()],
      priority: urgent ? 'high' : 'normal',
      audience: 'household',
      payload: { text: clip(text, TEXT_LIMIT) },
    });
  }
}
