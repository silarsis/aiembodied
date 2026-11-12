/**
 * The quick path of the inbox decision step: Laya (System One) answers ignore / remember / say and
 * "urgent?" in one call. If it is unsure, off or fails, the chat-model `deliberate` runs instead.
 * Laya is overconfident, so a pick needs DELIBERATE_QUICK_THRESHOLD, and it can never make an
 * event urgent while do-not-disturb is on.
 */
import type { SystemOneClient } from '../decide/system-one.js';
import type { PresenceTracker } from '../presence/presence.js';
import type { Decision } from './deliberate.js';
import type { SwitchboardEvent } from './types.js';

/** The top action needs at least this probability, or the chat model decides. */
export const DELIBERATE_QUICK_THRESHOLD = 0.6;
/** The model may make a "say" urgent only at this probability or more. */
export const DELIBERATE_QUICK_URGENT = 0.85;
export const DELIBERATE_QUICK_TIMEOUT_MS = 2_000;
/** The checkpoint reads about 512 tokens, so the message is clipped hard. */
const QUICK_TEXT_CHARS = 600;

type Logger = Pick<Console, 'warn'> & { info?: (message: string, data?: Record<string, unknown>) => void };

export interface DeliberateQuickOptions {
  client: SystemOneClient;
  /** Who is deciding, for the log only. */
  avatarName?: string;
  now?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The small state Laya reads. */
export function quickState(event: SwitchboardEvent, presence: PresenceTracker, now: number): Record<string, unknown> {
  const p = presence.snapshot(now);
  const text = typeof event.payload.text === 'string' ? event.payload.text.replace(/\s+/g, ' ').trim().slice(0, QUICK_TEXT_CHARS) : '';
  const source = typeof event.payload.source === 'string' ? event.payload.source : `${event.producer.kind}:${event.producer.id}`;
  return {
    kevin: {
      doNotDisturb: p.doNotDisturb,
      microphoneOn: p.listening,
      voice: p.voicePhase,
      secondsSinceHeLastSpoke: p.secondsSinceUserSpoke,
      secondsSinceFaceSeen: p.secondsSinceFaceSeen,
      localTime: p.localTime,
    },
    event: { type: event.type, from: source, priority: event.priority ?? 'normal', text },
  };
}

/** One call. Null when the top action is below the threshold; throws when the call fails. */
export async function deliberateQuick(event: SwitchboardEvent, presence: PresenceTracker, options: DeliberateQuickOptions): Promise<Decision | null> {
  const now = (options.now ?? Date.now)();
  const answers = await options.client.ask(
    quickState(event, presence, now),
    {
      action: {
        type: 'choice',
        instructions: 'What should the assistant do with this message?',
        criteria: {
          ignore: 'noise, nothing Kevin needs',
          remember: 'worth knowing later, not worth interrupting',
          say: 'Kevin would want to hear it now',
        },
      },
      urgent: { type: 'noul', instructions: 'Is this urgent enough to interrupt Kevin even mid-conversation?' },
    },
    { signal: options.signal, timeoutMs: options.timeoutMs ?? DELIBERATE_QUICK_TIMEOUT_MS },
  );
  let best: { action: 'ignore' | 'remember' | 'say'; p: number } | null = null;
  for (const action of ['ignore', 'remember', 'say'] as const) {
    const p = answers.action[action] ?? 0;
    if (!best || p > best.p) best = { action, p };
  }
  if (!best || best.p < DELIBERATE_QUICK_THRESHOLD) return null;
  // Do-not-disturb: only the event's own priority can make it urgent.
  const modelUrgent = !presence.doNotDisturb && best.action === 'say' && answers.urgent >= DELIBERATE_QUICK_URGENT;
  return {
    action: best.action,
    reason: `quick decision (${best.action} ${best.p.toFixed(2)})`,
    urgent: event.priority === 'urgent' || modelUrgent,
    engine: 'system-one',
  };
}

export interface DeliberateFastOptions {
  /** A client for the current routing, or null when Quick decisions are off. Built per call. */
  makeClient: () => SystemOneClient | null;
  /** The chat-model decision step, used when the quick one is off, unsure or failing. */
  fallback: (event: SwitchboardEvent) => Promise<Decision | null>;
  avatarName?: string;
  now?: () => number;
  logger?: Logger;
}

/** Laya first, the chat model when it is off, fails or is unsure. */
export async function deliberateFast(event: SwitchboardEvent, presence: PresenceTracker, options: DeliberateFastOptions): Promise<Decision | null> {
  const { logger } = options;
  let client: SystemOneClient | null = null;
  try {
    client = options.makeClient();
  } catch {
    client = null;
  }
  if (client) {
    try {
      const quick = await deliberateQuick(event, presence, { client, avatarName: options.avatarName, now: options.now });
      if (quick) {
        logger?.info?.('Inbox decision made by Quick decisions.', { event: event.id, action: quick.action });
        return quick;
      }
      logger?.info?.('Quick decisions were unsure; asking the chat model.', { event: event.id });
    } catch (error) {
      logger?.warn('Quick decision failed; asking the chat model.', { message: error instanceof Error ? error.message : String(error) });
    }
  }
  const decision = await options.fallback(event);
  if (decision) logger?.info?.('Inbox decision made by the chat model.', { event: event.id, action: decision.action });
  return decision;
}
