/**
 * Approvals for tools that need Kevin's go-ahead (confirmationLevel 'confirm'). A call from the
 * voice model is not executed: the broker records it as a pending approval and the model is told
 * to ask Kevin. Kevin approves or declines on the approval card, or by saying a clear yes or no.
 * On approval the broker runs the tool through the registry. A call flagged `cardOnly` (for
 * example opening a pull request on Echo's own code) is never approved by voice.
 * Every request and outcome is logged.
 */
import { EventEmitter } from 'node:events';
import type { RegisteredTool, ToolRegistry } from './tool-registry.js';

type Logger = { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };

export const APPROVAL_TTL_MS = 30 * 60_000;
/** Only approvals asked for this recently can be settled by voice, so a stray "yes" later can't approve an old one. */
export const SPOKEN_WINDOW_MS = 5 * 60_000;

/** A spoken answer longer than this is not treated as a yes or no. */
export const MAX_SPOKEN_WORDS = 6;

export interface PendingApproval {
  id: string;
  toolId: string;
  toolName: string;
  params: unknown;
  /** One line for the card and for Echo, such as "start a coding task in aiembodied: Fix the retry". */
  summary: string;
  createdAt: number;
  expiresAt: number;
  source: 'voice';
  /** Only the card can approve this one. */
  cardOnly: boolean;
}

export type ApprovalDecision = 'approved' | 'declined' | 'expired';

export interface ApprovalOutcome {
  approval: PendingApproval;
  decision: ApprovalDecision;
  by: 'card' | 'voice' | 'timeout';
  /** What the tool returned (approved and ok), or why it failed. */
  result?: string;
  ok?: boolean;
  /** Echo already saw this outcome in the turn that resolved it, so it is not sent again as an update. */
  delivered: boolean;
}

export interface ApprovalBrokerOptions {
  registry: Pick<ToolRegistry, 'execute' | 'get'>;
  logger?: Logger;
  ttlMs?: number;
  now?: () => number;
  makeId?: () => string;
}

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|approve|approved|go ahead|go|do it|please do|yes please|ok go|okay go|go for it|sounds good|that's fine|that is fine|confirmed|confirm)$/;
const NO = /^(no|nope|nah|don'?t|do not|cancel|stop|not now|decline|never mind|nevermind|no thanks|no thank you|don'?t do it|do not do it|abort)$/;

/** 'yes' or 'no' for a short, clear answer; null for anything else. */
export function parseSpokenDecision(text: string): 'yes' | 'no' | null {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words || words.split(' ').length > MAX_SPOKEN_WORDS) return null;
  const withoutEcho = words.replace(/^(echo|hey echo)\s+/, '');
  if (YES.test(withoutEcho)) return 'yes';
  if (NO.test(withoutEcho)) return 'no';
  // "yes go ahead", "no don't", "ok go ahead": a yes or no word first, then a phrase of the same kind.
  const [first, ...rest] = withoutEcho.split(' ');
  const tail = rest.join(' ');
  if (rest.length > 0 && /^(yes|yeah|yep|ok|okay|sure)$/.test(first) && (YES.test(tail) || /^(please|now|thanks|thank you)$/.test(tail))) return 'yes';
  if (rest.length > 0 && first === 'no' && (NO.test(tail) || /^(thanks|thank you|please)$/.test(tail))) return 'no';
  return null;
}

export class ApprovalBroker extends EventEmitter {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private counter = 0;

  constructor(private readonly options: ApprovalBrokerOptions) {
    super();
    this.ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? (() => `ap-${this.now().toString(36)}-${(this.counter += 1)}`);
  }

  /** Pending approvals, oldest first. */
  list(): PendingApproval[] {
    this.expireOld();
    return [...this.pending.values()];
  }

  /** Record a call that needs approval. The same tool with the same arguments, still pending, is not added twice. */
  async request(tool: RegisteredTool, params: unknown): Promise<PendingApproval> {
    this.expireOld();
    const key = JSON.stringify(params ?? null);
    for (const existing of this.pending.values()) {
      if (existing.toolId === tool.id && JSON.stringify(existing.params ?? null) === key) return existing;
    }
    let cardOnly = false;
    try {
      cardOnly = (await tool.cardOnly?.(params)) === true;
    } catch (error) {
      // When in doubt, keep it off the voice path.
      cardOnly = true;
      this.options.logger?.warn('Approval: could not tell whether the card is required; requiring it', {
        tool: tool.toolName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const createdAt = this.now();
    const approval: PendingApproval = {
      id: this.makeId(),
      toolId: tool.id,
      toolName: tool.toolName,
      params,
      summary: summarize(tool, params),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      source: 'voice',
      cardOnly,
    };
    this.pending.set(approval.id, approval);
    const timer = setTimeout(() => this.expireOld(), this.ttlMs + 50);
    timer.unref?.();
    this.timers.set(approval.id, timer);
    this.options.logger?.info('Approval requested', { id: approval.id, tool: approval.toolName, summary: approval.summary, cardOnly, source: approval.source });
    this.changed();
    return approval;
  }

  /** What the voice model is told when it calls a tool that needs approval. */
  waitingMessage(approval: PendingApproval): string {
    return approval.cardOnly
      ? `Waiting for Kevin to approve on the screen: ${approval.summary}. This one can only be approved by tapping Approve on the card. Tell Kevin that, and do not ask for a spoken yes.`
      : `Waiting for Kevin to approve: ${approval.summary}. Ask him out loud whether to go ahead.`;
  }

  async approve(id: string, by: 'card' | 'voice' = 'card', delivered = false): Promise<ApprovalOutcome | null> {
    const approval = this.take(id);
    if (!approval) return null;
    if (by === 'voice' && approval.cardOnly) {
      // Never reached from resolveSpoken; guards other callers.
      this.pending.set(id, approval);
      return null;
    }
    this.options.logger?.info('Approval granted', { id, tool: approval.toolName, summary: approval.summary, by });
    let result = '';
    let ok = false;
    try {
      const executed = await this.options.registry.execute(approval.toolId, approval.params);
      ok = executed.success;
      result = executed.success
        ? typeof executed.data === 'string'
          ? executed.data
          : JSON.stringify(executed.data ?? null)
        : (executed.error ?? 'The tool failed.');
    } catch (error) {
      result = error instanceof Error ? error.message : String(error);
    }
    this.options.logger?.info('Approved tool finished', { id, tool: approval.toolName, ok });
    return this.finish({ approval, decision: 'approved', by, result, ok, delivered });
  }

  decline(id: string, by: 'card' | 'voice' = 'card', delivered = false): ApprovalOutcome | null {
    const approval = this.take(id);
    if (!approval) return null;
    this.options.logger?.info('Approval declined', { id, tool: approval.toolName, summary: approval.summary, by });
    return this.finish({ approval, decision: 'declined', by, delivered });
  }

  /**
   * Kevin's next words while something is pending. A clear yes or no (six words at most) settles
   * the newest pending approval asked for in the last five minutes; a yes never settles a card-only one. Anything else returns null
   * and the approval stays pending. The outcome is marked delivered: the caller tells the model.
   */
  async resolveSpoken(text: string): Promise<ApprovalOutcome | null> {
    const recent = this.now() - SPOKEN_WINDOW_MS;
    const pending = this.list().filter((entry) => entry.createdAt >= recent);
    if (pending.length === 0) return null;
    const decision = parseSpokenDecision(text);
    if (!decision) return null;
    if (decision === 'no') {
      return this.decline(pending[pending.length - 1].id, 'voice', true);
    }
    const target = [...pending].reverse().find((entry) => !entry.cardOnly);
    if (!target) return null;
    return this.approve(target.id, 'voice', true);
  }

  /** True when some pending approval can be settled by voice. */
  hasPending(): boolean {
    return this.list().length > 0;
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.removeAllListeners();
  }

  private take(id: string): PendingApproval | undefined {
    this.expireOld();
    const approval = this.pending.get(id);
    if (!approval) return undefined;
    this.pending.delete(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    return approval;
  }

  private finish(outcome: ApprovalOutcome): ApprovalOutcome {
    this.changed();
    this.emit('outcome', outcome);
    return outcome;
  }

  private expireOld(): void {
    const now = this.now();
    for (const approval of [...this.pending.values()]) {
      if (approval.expiresAt > now) continue;
      this.pending.delete(approval.id);
      const timer = this.timers.get(approval.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(approval.id);
      this.options.logger?.info('Approval expired (declined)', { id: approval.id, tool: approval.toolName, summary: approval.summary });
      this.changed();
      this.emit('outcome', { approval, decision: 'expired', by: 'timeout', delivered: false } satisfies ApprovalOutcome);
    }
  }

  private changed(): void {
    this.emit('changed', [...this.pending.values()]);
  }
}

function summarize(tool: RegisteredTool, params: unknown): string {
  try {
    const described = tool.describeCall?.(params);
    if (described) return described;
  } catch {
    // Fall through to the generic summary.
  }
  const args = JSON.stringify(params ?? {});
  return `${tool.toolName.replace(/_/g, ' ')} ${args.length > 120 ? `${args.slice(0, 120)}…` : args}`;
}

/** The sentence Echo sees when an approval is settled, for the turn that settled it or a later update. */
export function describeOutcome(outcome: ApprovalOutcome, maxResultChars = 800): string {
  const { approval } = outcome;
  if (outcome.decision === 'declined') return `Kevin declined: ${approval.summary}.`;
  if (outcome.decision === 'expired') return `Nobody answered in time, so this was declined: ${approval.summary}.`;
  const result = (outcome.result ?? '').length > maxResultChars ? `${outcome.result?.slice(0, maxResultChars)}…` : (outcome.result ?? '');
  return outcome.ok
    ? `Kevin approved: ${approval.summary}. Done. Result: ${result}`
    : `Kevin approved: ${approval.summary}, but it failed: ${result}`;
}
