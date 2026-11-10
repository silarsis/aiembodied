/**
 * "Idle thoughts": one small chat completion that picks what the avatar does next on its own in a
 * room. It goes to the server the `idle` use of Models and servers names (Thinking's by default),
 * with that use's backups, and gets no history, no memory and no tools. Any failure gives null and
 * the renderer picks at random instead, so the avatar never freezes.
 */
import { routeTargets, type ModelRouting } from '../config/model-routing.js';
import { DEFAULT_OPENAI_MODELS, FailoverChatClient, type ChatClient, type ServerKeyLookup } from '../local-voice/voice-engines.js';
import { LocalLlmClient } from '../local-voice/local-llm-client.js';
import type { IdlePickContext, IdlePickResult } from './types.js';

export const IDLE_PICK_TIMEOUT_MS = 15_000;
export const IDLE_PICK_MAX_TOKENS = 80;
export const IDLE_PICK_TEMPERATURE = 0.9;
const MAX_PROMPT_CHARS = 6000;

export interface IdleThoughtsOptions {
  routing: ModelRouting;
  keyFor: ServerKeyLookup;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
  /** Replaces the clients built from the routing (tests). */
  clients?: ChatClient[];
}

/** The chat clients for the idle route, in failover order. */
export function idleClients(
  { routing, keyFor, fetchFn }: Pick<IdleThoughtsOptions, 'routing' | 'keyFor' | 'fetchFn'>,
  tuning: { temperature?: number; maxTokens?: number } = {},
): ChatClient[] {
  return routeTargets(routing, 'idle').map(
    ({ server, model }): ChatClient =>
      new LocalLlmClient({
        baseUrl: server.url,
        model: model || (server.type === 'openai' ? DEFAULT_OPENAI_MODELS.llm : 'default'),
        apiKey: keyFor(server.id),
        flavor: server.type === 'openai' ? 'openai' : 'llama-server',
        temperature: tuning.temperature ?? IDLE_PICK_TEMPERATURE,
        maxTokens: tuning.maxTokens ?? IDLE_PICK_MAX_TOKENS,
        fetchFn,
      }),
  );
}

function valid(context: unknown): context is IdlePickContext {
  if (typeof context !== 'object' || context === null) return false;
  const { system, user } = context as Record<string, unknown>;
  return typeof system === 'string' && typeof user === 'string' && system.trim() !== '' && user.trim() !== '';
}

/** Takes out `<think>…</think>` blocks some models write despite thinking being off. */
function clean(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}

export async function pickIdleActions(context: IdlePickContext, options: IdleThoughtsOptions): Promise<IdlePickResult | null> {
  if (!valid(context)) return null;
  const clients = options.clients ?? idleClients(options);
  if (clients.length === 0) return null;
  const chat = clients.length > 1 ? new FailoverChatClient(clients, options.logger) : clients[0];
  const signal = AbortSignal.timeout(options.timeoutMs ?? IDLE_PICK_TIMEOUT_MS);
  try {
    let text = '';
    for await (const part of chat.streamChat(
      [
        { role: 'system', content: context.system.slice(0, MAX_PROMPT_CHARS) },
        { role: 'user', content: context.user.slice(0, MAX_PROMPT_CHARS) },
      ],
      { signal },
    )) {
      if (part.type === 'text') text += part.text;
    }
    const reply = clean(text);
    return reply ? { text: reply } : null;
  } catch (error) {
    options.logger?.warn('Idle thoughts failed; the renderer will pick at random.', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
