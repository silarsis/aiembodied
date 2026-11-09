/**
 * The "Room layout" job: one chat completion that writes a room layout as JSON. It goes to the
 * server the `scenelayout` use of Models and servers names (Thinking's by default), with that use's
 * backups. The request asks for a JSON object reply when the server accepts that and falls back to
 * a plain request when it is rejected. The reply is parsed and checked; if that fails the model
 * gets the problem once and tries again.
 */
import { routeTargets, type ModelRouting } from '../config/model-routing.js';
import { DEFAULT_OPENAI_MODELS, FailoverChatClient, type ChatClient, type ServerKeyLookup } from '../local-voice/voice-engines.js';
import { LocalLlmClient, type ChatMessage } from '../local-voice/local-llm-client.js';
import { LayoutError, validateLayout, type RoomLayout } from './room-layout.js';
import { buildLayoutPrompt, buildRetryNote } from './room-layout-prompt.js';

export const LAYOUT_TEMPERATURE = 0.4;
export const LAYOUT_MAX_TOKENS = 2500;
export const LAYOUT_TIMEOUT_MS = 120_000;

export interface RoomLayoutOptions {
  routing: ModelRouting;
  keyFor: ServerKeyLookup;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
  /** Replaces the clients built from the routing (tests). `jsonObject` says whether to ask for a JSON reply. */
  makeClients?: (jsonObject: boolean) => ChatClient[];
}

function layoutClients({ routing, keyFor, fetchFn }: RoomLayoutOptions, jsonObject: boolean): ChatClient[] {
  return routeTargets(routing, 'scenelayout').map(
    ({ server, model }): ChatClient =>
      new LocalLlmClient({
        baseUrl: server.url,
        model: model || (server.type === 'openai' ? DEFAULT_OPENAI_MODELS.llm : 'default'),
        apiKey: keyFor(server.id),
        flavor: server.type === 'openai' ? 'openai' : 'llama-server',
        temperature: LAYOUT_TEMPERATURE,
        maxTokens: LAYOUT_MAX_TOKENS,
        jsonObject,
        fetchFn,
      }),
  );
}

/** Pulls the JSON object out of a reply that may have think blocks, fences or chatter around it. */
export function extractJson(reply: string): unknown {
  let body = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fenced) body = fenced[1].trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new LayoutError('the reply had no JSON object');
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch (error) {
    throw new LayoutError(`the reply was not valid JSON (${error instanceof Error ? error.message : 'parse error'})`);
  }
}

async function complete(chat: ChatClient, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  let text = '';
  for await (const part of chat.streamChat(messages, { signal })) if (part.type === 'text') text += part.text;
  return text;
}

/** HTTP 4xx from the server: a JSON-mode request it does not understand looks like this. */
function rejectedRequest(error: unknown): boolean {
  return error instanceof Error && /HTTP 4\d\d/.test(error.message);
}

export async function generateRoomLayout(description: string, options: RoomLayoutOptions): Promise<RoomLayout> {
  const make = options.makeClients ?? ((json: boolean) => layoutClients(options, json));
  const build = (json: boolean): ChatClient | null => {
    const clients = make(json);
    if (clients.length === 0) return null;
    return clients.length > 1 ? new FailoverChatClient(clients, options.logger) : clients[0];
  };
  let json = true;
  let chat = build(true);
  if (!chat) throw new Error('No model is set for Room layout. Choose one in Models and servers.');
  const timeout = AbortSignal.timeout(options.timeoutMs ?? LAYOUT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const { system, user } = buildLayoutPrompt(description);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply: string;
    try {
      reply = await complete(chat, messages, signal);
    } catch (error) {
      if (signal.aborted) throw options.signal?.aborted ? new Error('Cancelled.') : new Error('The room layout model took too long to answer.');
      if (json && rejectedRequest(error)) {
        // The server does not take response_format: ask again without it.
        json = false;
        chat = build(false) ?? chat;
        try {
          reply = await complete(chat, messages, signal);
        } catch (second) {
          throw new Error(`The room layout model could not be reached: ${second instanceof Error ? second.message : String(second)}`);
        }
      } else {
        throw new Error(`The room layout model could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      return validateLayout(extractJson(reply));
    } catch (error) {
      if (!(error instanceof LayoutError)) throw error;
      problem = error.message;
      options.logger?.warn('Room layout reply was not usable.', { problem, attempt });
      messages.push({ role: 'assistant', content: reply.slice(0, 6000) }, { role: 'user', content: buildRetryNote(problem) });
    }
  }
  throw new Error(`The room layout model did not return a usable layout (${problem}). Try again, or pick a stronger model for Room layout in Models and servers.`);
}
