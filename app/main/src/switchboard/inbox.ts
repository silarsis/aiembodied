/**
 * An avatar's inbox: what Echo does with events addressed to `avatar:<id>`. Each event type has a
 * policy (this table is the one place to change it); speaking goes through LocalVoiceService.notify,
 * which batches updates and waits for the conversation to be idle. Works the same with the
 * switchboard up or down, because the bus delivers locally when it is not connected.
 */
import type { SwitchboardBus } from './bus.js';
import type { SwitchboardEvent } from './types.js';

type Logger = {
  debug?: (message: string, data?: Record<string, unknown>) => void;
  info?: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

export type InboxAction = 'speak-urgent' | 'speak-idle' | 'remember' | 'ignore';

export interface InboxRule {
  action: InboxAction | ((event: SwitchboardEvent) => InboxAction);
  /** Put in front of the text before it is spoken. */
  prefix?: string;
  /** Who the update is from; LocalVoiceService names it in the note's marker. */
  source?: string;
}

/** Exact types and families (`home.*`); `*` is the fallback. The longest match wins. */
export const DEFAULT_INBOX_POLICY: Record<string, InboxRule> = {
  'avatar.inbox': { action: (event) => (event.priority === 'high' || event.priority === 'urgent' ? 'speak-urgent' : 'speak-idle') },
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

export interface AvatarInboxOptions {
  avatarId: string;
  bus: SwitchboardBus;
  notify: (text: string, options: { urgent: boolean; source?: string }) => void;
  logger?: Logger;
  policy?: Record<string, InboxRule>;
  now?: () => number;
}

export class AvatarInbox {
  private readonly options: AvatarInboxOptions;
  private unsubscribe: (() => void) | null = null;

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
    if (action === 'ignore' || action === 'remember') {
      logger?.debug?.(`Inbox: ${action}`, { type: event.type, id: event.id });
      return;
    }
    const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : '';
    if (!text) {
      logger?.warn('Inbox: event has no text to speak', { type: event.type, id: event.id });
      return;
    }
    const payloadSource = typeof event.payload.source === 'string' && event.payload.source !== 'coding' ? event.payload.source : undefined;
    try {
      this.options.notify(`${rule?.prefix ?? ''}${text}`, { urgent: action === 'speak-urgent', source: rule?.source ?? payloadSource });
    } catch (error) {
      logger?.warn('Inbox: notify failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}
