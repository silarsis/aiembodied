/**
 * The real bid step: one small chat completion on the `idle` model route (like the inbox's
 * decision step) that sees the recent lines and the avatars that could answer, and returns how
 * much each wants to. Any failure rejects, which the floor manager reads as no bids (silence).
 */
import type { ModelRouting } from '../config/model-routing.js';
import type { ChatClient, ServerKeyLookup } from '../local-voice/voice-engines.js';
import { FailoverChatClient } from '../local-voice/voice-engines.js';
import { idleClients } from '../rooms/idle-thoughts.js';
import type { BidCandidate, BidFunction, FloorBid, FloorLine } from './floor-manager.js';

export const BID_MAX_TOKENS = 200;
export const BID_TEMPERATURE = 0.2;
const MAX_LINE_CHARS = 400;

export const BID_SYSTEM_PROMPT = [
  'Several AI characters share a room with Kevin. One of them just spoke to the room, not to Kevin.',
  'For each candidate, say how much they want to reply right now, from 0 (nothing to add, stay quiet) to 1 (must answer).',
  'Reply only when there is a real reason: a question, a disagreement, something that concerns them. Small talk that has run its course is 0.',
  'Answer with one JSON object {"bids": [{"avatar": "<id>", "want": 0.0, "reason": "..."}]} with one entry per candidate and nothing else.',
].join(' ');

export function buildBidUser(candidates: BidCandidate[], recentLines: FloorLine[], nameOfSpeaker: (from: string) => string): string {
  return [
    'Recent lines (oldest first):',
    ...recentLines.map((line) => `${nameOfSpeaker(line.from)}: ${line.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS)}`),
    '',
    'Candidates:',
    ...candidates.map((candidate) => `- ${candidate.avatarId} (${candidate.name})`),
  ].join('\n');
}

/** Reads the bids out of a model answer (think blocks and code fences tolerated). Null when there is no usable JSON. */
export function parseBids(raw: string, candidates: BidCandidate[]): FloorBid[] | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    let value: unknown;
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    const list = (value as { bids?: unknown })?.bids;
    if (!Array.isArray(list)) return null;
    const known = new Map<string, string>();
    for (const candidate of candidates) {
      known.set(candidate.avatarId.toLowerCase(), candidate.avatarId);
      known.set(candidate.name.toLowerCase(), candidate.avatarId);
    }
    const bids: FloorBid[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const { avatar, want, reason } = item as Record<string, unknown>;
      const avatarId = typeof avatar === 'string' ? known.get(avatar.trim().toLowerCase()) : undefined;
      const number = typeof want === 'number' ? want : typeof want === 'string' ? Number.parseFloat(want) : Number.NaN;
      if (!avatarId || !Number.isFinite(number)) continue;
      bids.push({ avatarId, want: Math.min(1, Math.max(0, number)), reason: typeof reason === 'string' ? reason.trim().slice(0, 200) : '' });
    }
    return bids;
  }
  return null;
}

export interface ModelBidOptions {
  routing?: () => ModelRouting;
  keyFor?: ServerKeyLookup;
  fetchFn?: typeof fetch;
  /** Replaces the clients built from the routing (tests). */
  clients?: () => ChatClient[];
  /** The name a line's speaker is shown as. */
  nameOfSpeaker?: (from: string) => string;
  logger?: Pick<Console, 'warn'>;
}

export function createModelBid(options: ModelBidOptions): BidFunction {
  return async (candidates, recentLines, signal) => {
    const clients =
      options.clients?.() ??
      (options.routing && options.keyFor
        ? idleClients({ routing: options.routing(), keyFor: options.keyFor, fetchFn: options.fetchFn }, { temperature: BID_TEMPERATURE, maxTokens: BID_MAX_TOKENS })
        : []);
    if (clients.length === 0) throw new Error('No idle model is configured.');
    const chat = clients.length > 1 ? new FailoverChatClient(clients, options.logger) : clients[0];
    let text = '';
    for await (const part of chat.streamChat(
      [
        { role: 'system', content: BID_SYSTEM_PROMPT },
        { role: 'user', content: buildBidUser(candidates, recentLines, options.nameOfSpeaker ?? ((from) => from)) },
      ],
      { signal },
    )) {
      if (part.type === 'text') text += part.text;
    }
    const bids = parseBids(text, candidates);
    if (!bids) throw new Error('The bid answer made no sense.');
    return bids;
  };
}
