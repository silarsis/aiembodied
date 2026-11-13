/**
 * The intent step for Kevin's lines the name rules are not sure about ("Not you, Echo. Sage, what
 * do you think?", "Tell me about Sage."): one small chat completion on the `idle` model route (the
 * same route as the bids and the inbox decision) that answers three fields, who Kevin speaks TO,
 * what he wants, and the other avatar involved. The answer is constrained with a JSON schema built
 * from the scene. Any failure or an answer outside the lists rejects, and the floor manager then
 * lets the rules decide.
 *
 * The prompt is variant `d` of scripts/floor-intent-check.mjs (keep them in step): the three
 * fields, six worked examples from another room, then the real room. Options are the avatars'
 * lower-case names made unique, because the model reads names, not ids.
 */
import type { ModelRouting } from '../config/model-routing.js';
import type { ChatClient, ServerKeyLookup } from '../local-voice/voice-engines.js';
import { FailoverChatClient } from '../local-voice/voice-engines.js';
import { idleClients } from '../rooms/idle-thoughts.js';
import type { BidCandidate, FloorLine, IntentFunction, IntentInput, IntentResult } from './floor-manager.js';
import { optionKeys } from './system-one-floor.js';

export const INTENT_MAX_TOKENS = 60;
export const INTENT_TEMPERATURE = 0;
const RECENT_LINES = 4;
const LINE_CHARS = 200;
const EVERYONE = 'everyone';
const UNCLEAR = 'unclear';
const NONE = 'none';
const WANTS = ['answer', 'converse', 'relay'] as const;

const RULES = [
  'Kevin is talking to avatars in a room. Read his last line and fill in three fields.',
  '"addressed": the avatar Kevin is speaking TO in this line, the one who should act on it. It is NOT the avatar he wants them to go and talk to, ask, or talk about. Use "everyone" when he speaks to all of them. Use "unclear" when the line names no one as the listener (then the app picks).',
  '"wants": "answer" = just reply to Kevin; "converse" = go and have a conversation with another avatar; "relay" = ask or tell another avatar something for Kevin.',
  '"other": that other avatar when wants is converse or relay, else "none".',
];

/** Worked examples in a made-up room; none of them is a line from the checks. */
const EXAMPLES: Array<[text: string, addressed: string, wants: string, other: string]> = [
  ['Tobin, did you sleep well?', 'tobin', 'answer', 'none'],
  ['Is it cold out?', 'unclear', 'answer', 'none'],
  ['Mira, go and chat with Tobin for a bit.', 'mira', 'converse', 'tobin'],
  ['Why not have a natter with Tobin?', 'unclear', 'converse', 'tobin'],
  ['Tobin, find out if Mira is hungry.', 'tobin', 'relay', 'mira'],
  ['Mira, is Tobin always this grumpy?', 'mira', 'answer', 'none'],
];

const clipLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= LINE_CHARS ? flat : `${flat.slice(0, LINE_CHARS)}…`;
};

export interface IntentPrompt {
  system: string;
  user: string;
  /** Option key (lower-case name, made unique) to avatar. */
  keys: Map<string, BidCandidate>;
  /** The JSON schema the answer must fit. */
  schema: Record<string, unknown>;
}

const enumOf = (values: string[]) => ({ type: 'string', enum: values });

export function intentSchema(keys: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      addressed: enumOf([...keys, EVERYONE, UNCLEAR]),
      wants: enumOf([...WANTS]),
      other: enumOf([...keys, NONE]),
    },
    required: ['addressed', 'wants', 'other'],
    additionalProperties: false,
  };
}

/** The system and user text for one line, the option keys and the answer schema. `nameOfSpeaker` shows a line's speaker as a name. */
export function buildIntentPrompt(input: IntentInput, nameOfSpeaker: (from: string) => string): IntentPrompt {
  const away = input.away ?? [];
  const keys = optionKeys([...input.candidates, ...away], [EVERYONE, UNCLEAR, NONE]);
  const keyOf = new Map([...keys].map(([key, candidate]) => [candidate.avatarId, key] as const));
  const labelOf = (candidate: BidCandidate): string => {
    const key = keyOf.get(candidate.avatarId) ?? candidate.name;
    return key === (candidate.name.trim() || candidate.avatarId).toLowerCase() ? candidate.name.trim() || candidate.avatarId : key;
  };
  const room = input.candidates.map((candidate) => (candidate.avatarId === input.hostId ? `${labelOf(candidate)} (host)` : labelOf(candidate)));
  const partnerKey = input.partnerId ? keyOf.get(input.partnerId) : undefined;
  const partner = partnerKey ? (keys.get(partnerKey)?.name.trim() || partnerKey) : 'nobody yet';
  const names = [...keys.keys()];
  const system = [
    RULES[0],
    ...RULES.slice(1),
    'Examples from another room (avatars: Mira (host), Tobin):',
    ...EXAMPLES.map(([text, addressed, wants, other]) => `Kevin: "${text}" -> {"addressed": "${addressed}", "wants": "${wants}", "other": "${other}"}`),
    `Now the actual room: ${room.join(', ')}.${away.length > 0 ? ` In another place right now, and Kevin can call them over: ${away.map(labelOf).join(', ')}. When a line is aimed at one of them, they are the one addressed.` : ''} Kevin last spoke with ${partner}.`,
    `Allowed values, lower case: addressed = ${[...names, EVERYONE, UNCLEAR].join(' | ')}; wants = ${WANTS.join(' | ')}; other = ${[...names, NONE].join(' | ')}.`,
    'Reply with only a JSON object: {"addressed": "...", "wants": "...", "other": "..."}',
  ].join('\n');
  const recent: FloorLine[] = input.recent.slice(-RECENT_LINES);
  const user = [...recent.map((line) => `${nameOfSpeaker(line.from)}: ${clipLine(line.text)}`), `Kevin: ${clipLine(input.text)}`].join('\n');
  return { system, user, keys, schema: intentSchema(names) };
}

const clean = (value: unknown): string | undefined => (typeof value === 'string' ? value.trim().toLowerCase() : undefined);

/**
 * Reads the answer (think blocks and code fences tolerated). Null when there is no JSON object or a
 * value is outside the lists: the three fields must be present, `addressed` an option key,
 * 'everyone' or 'unclear', `wants` one of the three, `other` an option key, 'none', null or empty.
 */
export function parseIntentAnswer(raw: string, keys: Map<string, BidCandidate>): IntentResult | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  for (let end = text.indexOf('}', start); end >= 0; end = text.indexOf('}', end + 1)) {
    let value: unknown;
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const addressedKey = clean(record.addressed);
    const wants = clean(record.wants);
    const otherKey = record.other === null || record.other === undefined ? NONE : clean(record.other);
    if (addressedKey === undefined || wants === undefined || otherKey === undefined) return null;
    if (!(WANTS as readonly string[]).includes(wants)) return null;
    let addressed: string;
    if (addressedKey === EVERYONE || addressedKey === UNCLEAR) addressed = addressedKey;
    else {
      const candidate = keys.get(addressedKey);
      if (!candidate) return null;
      addressed = candidate.avatarId;
    }
    let other: string | null = null;
    if (otherKey !== NONE && otherKey !== '') {
      const candidate = keys.get(otherKey);
      if (!candidate) return null;
      other = candidate.avatarId;
    }
    return { addressed, wants: wants as IntentResult['wants'], other };
  }
  return null;
}

export interface IntentRouterOptions {
  routing?: () => ModelRouting;
  keyFor?: ServerKeyLookup;
  fetchFn?: typeof fetch;
  /** The spoken name of an avatar (for the names of the recent lines' speakers). */
  nameOf: (avatarId: string) => string;
  /** Replaces the clients built from the routing (tests). Gets the `response_format` to send, or null for none. */
  clients?: (responseFormat: Record<string, unknown> | null) => ChatClient[];
  logger?: Pick<Console, 'warn'>;
}

/** An HTTP 400 from the server: it does not understand the `response_format` it was sent. */
const rejectedFormat = (error: unknown): boolean => error instanceof Error && /HTTP 400/.test(error.message);

export function createIntentRouter(options: IntentRouterOptions): IntentFunction {
  const nameOfSpeaker = (from: string): string => (from.startsWith('avatar:') ? options.nameOf(from.slice('avatar:'.length)) : 'Kevin');
  const clientsFor = (responseFormat: Record<string, unknown> | null): ChatClient[] =>
    options.clients?.(responseFormat) ??
    (options.routing && options.keyFor
      ? idleClients(
          { routing: options.routing(), keyFor: options.keyFor, fetchFn: options.fetchFn },
          { temperature: INTENT_TEMPERATURE, maxTokens: INTENT_MAX_TOKENS, ...(responseFormat ? { responseFormat } : {}) },
        )
      : []);
  return async (input, signal) => {
    const prompt = buildIntentPrompt(input, nameOfSpeaker);
    const messages = [
      { role: 'system' as const, content: prompt.system },
      { role: 'user' as const, content: prompt.user },
    ];
    // The schema first; a server that answers 400 gets json_object, then no format at all (the answer is parsed leniently either way).
    const formats: Array<Record<string, unknown> | null> = [
      { type: 'json_schema', json_schema: { name: 'floor_intent', strict: true, schema: prompt.schema } },
      { type: 'json_object' },
      null,
    ];
    let lastError: unknown;
    for (const format of formats) {
      const clients = clientsFor(format);
      if (clients.length === 0) throw new Error('No idle model is configured.');
      const chat = clients.length > 1 ? new FailoverChatClient(clients, options.logger) : clients[0];
      try {
        let text = '';
        for await (const part of chat.streamChat(messages, { signal })) if (part.type === 'text') text += part.text;
        const parsed = parseIntentAnswer(text, prompt.keys);
        if (!parsed) throw new Error('The intent answer made no sense.');
        return parsed;
      } catch (error) {
        lastError = error;
        if (signal.aborted || !rejectedFormat(error)) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
