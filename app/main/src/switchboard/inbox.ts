/**
 * An avatar's inbox: what Echo does with events addressed to `avatar:<id>`. Each event type has a
 * policy (this table is the one place to change it); speaking goes through LocalVoiceService.notify,
 * which batches updates and waits for the conversation to be idle. Works the same with the
 * switchboard up or down, because the bus delivers locally when it is not connected.
 */
import type { SwitchboardBus } from './bus.js';
import type { Decision } from './deliberate.js';
import type { DecisionRecord } from './decisions.js';
import type { SwitchboardEvent } from './types.js';

type Logger = {
  debug?: (message: string, data?: Record<string, unknown>) => void;
  info?: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

/** `deliberate` hands the event to a small model (with presence) that picks ignore, remember or say. */
export type InboxAction = 'speak-urgent' | 'speak-idle' | 'remember' | 'ignore' | 'deliberate';

export interface InboxRule {
  action: InboxAction | ((event: SwitchboardEvent) => InboxAction);
  /** Put in front of the text before it is spoken. */
  prefix?: string;
  /** Who the update is from; LocalVoiceService names it in the note's marker. */
  source?: string;
}

/** Exact types and families (`home.*`); `*` is the fallback. The longest match wins. */
export const DEFAULT_INBOX_POLICY: Record<string, InboxRule> = {
  'avatar.inbox': { action: (event) => (event.priority === 'high' || event.priority === 'urgent' ? 'speak-urgent' : 'deliberate') },
  'home.alert': { action: 'speak-urgent', source: 'Home Assistant' },
  'home.change': { action: 'remember' },
  '*': { action: 'ignore' },
};

export function lookupRule(policy: Record<string, InboxRule>, type: string): InboxRule | undefined {
  if (policy[type]) return policy[type];
  let best: string | null = null;
  for (const key of Object.keys(policy)) {
    if (key.endsWith('.*') && type.startsWith(key.slice(0, -1)) && (best === null || key.length > best.length)) best = key;
  }
  return best ? policy[best] : policy['*'];
}

/** A rule-based save of the same text within this time is skipped (sensor floods). */
const REMEMBER_REPEAT_MS = 60_000;

export interface AvatarInboxOptions {
  avatarId: string;
  bus: SwitchboardBus;
  notify: (text: string, options: { urgent: boolean; source?: string }) => void;
  logger?: Logger;
  policy?: Record<string, InboxRule>;
  now?: () => number;
  /** The decision step; null means it failed and the inbox falls back to speaking when idle. */
  deliberate?: (event: SwitchboardEvent) => Promise<Decision | null>;
  /** Saves an update quietly (a system message in the recent session). */
  remember?: (event: SwitchboardEvent, text: string) => void;
  /** Told of the text of every quiet save (rule or decision), for things like the proactive tick. */
  onRemembered?: (text: string) => void;
  /** True while do-not-disturb is on. */
  doNotDisturb?: () => boolean;
  /** Told of every decision that is journalled, whether or not the bus reaches the switchboard. */
  onDecision?: (decision: DecisionRecord) => void;
}

export class AvatarInbox {
  private readonly options: AvatarInboxOptions;
  private unsubscribe: (() => void) | null = null;
  private lastSaved: { text: string; at: number } | null = null;

  constructor(options: AvatarInboxOptions) {
    this.options = options;
  }

  start(): void {
    if (this.unsubscribe) return;
    const address = `avatar:${this.options.avatarId}` as const;
    this.unsubscribe = this.options.bus.subscribe({ actor: address, to: [address], types: ['*'], onEvent: (event) => this.handle(event) });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  handle(event: SwitchboardEvent): void {
    const { logger } = this.options;
    const now = (this.options.now ?? Date.now)();
    if (event.expires && Date.parse(event.expires) < now) {
      logger?.debug?.('Inbox: expired event dropped', { type: event.type, id: event.id });
      return;
    }
    const rule = lookupRule(this.options.policy ?? DEFAULT_INBOX_POLICY, event.type);
    const action = typeof rule?.action === 'function' ? rule.action(event) : (rule?.action ?? 'ignore');
    if (action === 'deliberate') {
      void this.deliberating(event, rule, now).catch((error) => {
        logger?.warn('Inbox: deliberation failed', { message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (action === 'ignore') {
      logger?.debug?.('Inbox: ignore', { type: event.type, id: event.id });
      return;
    }
    if (action === 'remember') {
      this.rememberByRule(event, rule, now);
      return;
    }
    this.speak(event, rule, action === 'speak-urgent');
  }

  /** A static `remember` rule: save the text quietly and journal it, unless the same text was just saved. */
  private rememberByRule(event: SwitchboardEvent, rule: InboxRule | undefined, now: number): void {
    const text = this.textOf(event);
    if (!text) {
      this.options.logger?.debug?.('Inbox: remember skipped, no text', { type: event.type, id: event.id });
      return;
    }
    if (this.lastSaved && this.lastSaved.text === text && now - this.lastSaved.at < REMEMBER_REPEAT_MS) {
      this.options.logger?.debug?.('Inbox: remember skipped, same text just saved', { type: event.type, id: event.id });
      return;
    }
    this.lastSaved = { text, at: now };
    this.options.logger?.debug?.('Inbox: remember', { type: event.type, id: event.id });
    this.save(event, rule);
    this.journal(event, 'remember', 'rule', 0, false, false);
    this.noteRemembered(text);
  }

  private textOf(event: SwitchboardEvent): string {
    return typeof event.payload.text === 'string' ? event.payload.text.trim() : '';
  }

  private speak(event: SwitchboardEvent, rule: InboxRule | undefined, urgent: boolean): void {
    const { logger } = this.options;
    const text = this.textOf(event);
    if (!text) {
      logger?.warn('Inbox: event has no text to speak', { type: event.type, id: event.id });
      return;
    }
    const payloadSource = typeof event.payload.source === 'string' && event.payload.source !== 'coding' ? event.payload.source : undefined;
    try {
      this.options.notify(`${rule?.prefix ?? ''}${text}`, { urgent, source: rule?.source ?? payloadSource });
    } catch (error) {
      logger?.warn('Inbox: notify failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private save(event: SwitchboardEvent, rule: InboxRule | undefined): void {
    const { logger } = this.options;
    const text = this.textOf(event);
    if (!text) return;
    const source = rule?.source ?? (typeof event.payload.source === 'string' ? event.payload.source : `${event.producer.kind}:${event.producer.id}`);
    try {
      this.options.remember?.(event, text);
    } catch (error) {
      logger?.warn('Inbox: remember failed', { source, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async deliberating(event: SwitchboardEvent, rule: InboxRule | undefined, startedAt: number): Promise<void> {
    const { logger } = this.options;
    const nowFn = this.options.now ?? Date.now;
    const dnd = this.options.doNotDisturb?.() === true;
    let action: 'ignore' | 'remember' | 'say' | 'speak-urgent' | 'speak-idle';
    let reason = '';
    let fallback = false;
    let engine: string | undefined;
    if (dnd) {
      action = event.priority === 'urgent' ? 'speak-urgent' : 'remember';
      reason = 'do not disturb';
    } else {
      let decision: Decision | null = null;
      try {
        decision = (await this.options.deliberate?.(event)) ?? null;
      } catch (error) {
        logger?.warn('Inbox: deliberate threw', { message: error instanceof Error ? error.message : String(error) });
      }
      if (decision) {
        action = decision.action;
        reason = decision.reason;
        engine = decision.engine;
      } else {
        action = 'speak-idle';
        reason = 'deliberation failed; speaking when idle';
        fallback = true;
      }
    }
    const ms = Math.max(0, nowFn() - startedAt);
    this.journal(event, action, reason, ms, fallback, dnd, engine);
    if (event.expires && Date.parse(event.expires) < nowFn()) {
      logger?.debug?.('Inbox: event expired while deliberating', { type: event.type, id: event.id });
      return;
    }
    logger?.debug?.(`Inbox: deliberated ${action}`, { type: event.type, id: event.id, reason });
    if (action === 'ignore') return;
    if (action === 'remember') {
      this.save(event, rule);
      this.noteRemembered(this.textOf(event));
    } else if (action === 'say') this.speak(event, rule, true);
    else this.speak(event, rule, action === 'speak-urgent');
  }

  /** Fire-and-forget record of a decision on the bus (private, nobody addressed). Never throws. */
  private noteRemembered(text: string): void {
    if (!text) return;
    try {
      this.options.onRemembered?.(text);
    } catch {
      // A listener must never disturb the inbox.
    }
  }

  private journal(event: SwitchboardEvent, action: string, reason: string, ms: number, fallback: boolean, doNotDisturb: boolean, engine?: string): void {
    try {
      this.options.onDecision?.({
        at: new Date((this.options.now ?? Date.now)()).toISOString(),
        avatarId: this.options.avatarId,
        event: event.id,
        type: event.type,
        action,
        reason,
        ms,
        fallback,
        doNotDisturb,
        ...(engine ? { engine } : {}),
      });
    } catch {
      // A listener must never disturb the inbox.
    }
    try {
      const txnId = event.txn?.id ?? `decision:${event.id}`;
      this.options.bus.publish({
        type: 'avatar.decision',
        producer: { kind: 'avatar', id: this.options.avatarId },
        to: [],
        audience: 'private',
        txn: event.txn ? { id: txnId, state: 'done' } : { id: txnId, parent: undefined, cause: event.id, state: 'done', title: `Decision on ${event.type}` },
        payload: { event: event.id, type: event.type, action, reason, ms, fallback, doNotDisturb, ...(engine ? { engine } : {}) },
      });
    } catch {
      // Journaling must never disturb the inbox.
    }
  }
}
