/**
 * The decision step for inbox events whose rule says `deliberate`: one small chat completion that
 * sees a presence bundle plus the event and answers ignore / remember / say. It uses the same
 * route as idle thoughts (the `idle` model use, with its backups), gets no tools, and any failure
 * (timeout, bad answer, no server) gives null so the caller can fall back to the old behaviour.
 */
import type { ModelRouting } from '../config/model-routing.js';
import type { ChatClient, ServerKeyLookup } from '../local-voice/voice-engines.js';
import { FailoverChatClient } from '../local-voice/voice-engines.js';
import { idleClients } from '../rooms/idle-thoughts.js';
import type { PresenceTracker } from '../presence/presence.js';
import type { SwitchboardEvent } from './types.js';

export type DeliberateAction = 'ignore' | 'remember' | 'say';
export interface Decision {
  action: DeliberateAction;
  reason: string;
  urgent: boolean;
}

export const DELIBERATE_TIMEOUT_MS = 6_000;
export const DELIBERATE_MAX_TOKENS = 120;
export const DELIBERATE_TEMPERATURE = 0.2;
const MAX_TEXT_CHARS = 1500;

export const deliberateSystemPrompt = (name = 'Echo'): string => [
  `You are ${name}, a friendly embodied assistant who lives in a room with Kevin and sees what is going on around him.`,
  'You get a message that arrived while Kevin may or may not be around.',
  'Decide: ignore (noise), remember (worth knowing later, not worth interrupting), say (Kevin would want to hear it now).',
  'Consider whether Kevin is talking, absent, or asleep.',
  'Answer with one JSON object {"action": "ignore|remember|say", "reason": "..."} and nothing else.',
].join(' ');

/** The decision prompt for the default avatar. */
export const DELIBERATE_SYSTEM_PROMPT = deliberateSystemPrompt();

export interface DeliberateOptions {
  /** The avatar deciding (its name goes in the prompt). Default 'Echo'. */
  avatarName?: string;
  routing?: ModelRouting;
  keyFor?: ServerKeyLookup;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
  /** Replaces the clients built from the routing (tests). */
  clients?: ChatClient[];
  now?: () => number;
}

/** Takes out `<think>` blocks, finds the first {...} and reads the action. Null when it makes no sense. */
export function parseDecision(raw: string): Omit<Decision, 'urgent'> | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  // Try each closing brace after the first opening one, shortest object first.
  for (let end = text.indexOf('}', start); end >= 0; end = text.indexOf('}', end + 1)) {
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (typeof value !== 'object' || value === null) continue;
      const { action, reason } = value as Record<string, unknown>;
      const a = typeof action === 'string' ? action.trim().toLowerCase() : '';
      if (a !== 'ignore' && a !== 'remember' && a !== 'say') return null;
      return { action: a, reason: typeof reason === 'string' ? reason.trim().slice(0, 300) : '' };
    } catch {
      // keep looking
    }
  }
  return null;
}

export function buildDeliberateUser(event: SwitchboardEvent, presence: PresenceTracker, now: number): string {
  const text = typeof event.payload.text === 'string' ? event.payload.text.trim().slice(0, MAX_TEXT_CHARS) : '';
  const source = typeof event.payload.source === 'string' ? event.payload.source : `${event.producer.kind}:${event.producer.id}`;
  return [
    'Presence:',
    presence.describe(now),
    '',
    'Message:',
    `type: ${event.type}`,
    `from: ${source}`,
    `priority: ${event.priority ?? 'normal'}`,
    `text: ${text}`,
  ].join('\n');
}

export async function deliberate(event: SwitchboardEvent, presence: PresenceTracker, options: DeliberateOptions = {}): Promise<Decision | null> {
  const clients =
    options.clients ??
    (options.routing && options.keyFor
      ? idleClients({ routing: options.routing, keyFor: options.keyFor, fetchFn: options.fetchFn }, { temperature: DELIBERATE_TEMPERATURE, maxTokens: DELIBERATE_MAX_TOKENS })
      : []);
  if (clients.length === 0) return null;
  const chat = clients.length > 1 ? new FailoverChatClient(clients, options.logger) : clients[0];
  const signal = AbortSignal.timeout(options.timeoutMs ?? DELIBERATE_TIMEOUT_MS);
  const now = (options.now ?? Date.now)();
  try {
    let text = '';
    const run = (async () => {
      for await (const part of chat.streamChat(
        [
          { role: 'system', content: deliberateSystemPrompt(options.avatarName) },
          { role: 'user', content: buildDeliberateUser(event, presence, now) },
        ],
        { signal },
      )) {
        if (part.type === 'text') text += part.text;
      }
    })();
    // A client that ignores the abort signal must still not hold the inbox.
    const timeout = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error('Deliberation timed out'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    run.catch(() => undefined);
    await Promise.race([run, timeout]);
    const parsed = parseDecision(text);
    if (!parsed) {
      options.logger?.warn('Deliberation gave no usable answer.');
      return null;
    }
    return { ...parsed, urgent: event.priority === 'urgent' };
  } catch (error) {
    options.logger?.warn('Deliberation failed.', { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
