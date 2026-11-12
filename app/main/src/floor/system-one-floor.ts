/**
 * The floor's quick decisions on the System 1 model (Laya): who a line is aimed at, and how much
 * each avatar wants to reply. Each is one small call that sees only a few clipped lines. Both
 * reject on any failure, so the caller falls back to the Idle thoughts model or the old rules.
 */
import type { SystemOneClient } from '../decide/system-one.js';
import type { AddresseeFunction, BidCandidate, BidFunction, FloorLine } from './floor-manager.js';

const RECENT_LINES = 4;
const LINE_CHARS = 200;
const PERSON_KEY = 'kevin';
const ALL_KEY = 'everyone';
/** The scale for "wants to reply", lowest first. */
const WANT_LEVELS = ['nothing to add', 'a little to add', 'something to add', 'a lot to add', 'must answer'];

const clipLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= LINE_CHARS ? flat : `${flat.slice(0, LINE_CHARS)}…`;
};

/** The state Laya reads: the last few lines (oldest first) and the line itself. */
function stateFor(recent: FloorLine[], line: { speaker: string; text: string } | null, speakerName: (from: string) => string): Record<string, unknown> {
  return {
    recent: recent.slice(-RECENT_LINES).map((entry) => ({ speaker: speakerName(entry.from), text: clipLine(entry.text) })),
    ...(line ? { line: { speaker: line.speaker, text: clipLine(line.text) } } : {}),
  };
}

/** A key per candidate that the model can read: their name, made unique when two share one. */
function optionKeys(candidates: BidCandidate[], taken: string[]): Map<string, BidCandidate> {
  const used = new Set(taken);
  const keys = new Map<string, BidCandidate>();
  for (const candidate of candidates) {
    const base = (candidate.name.trim() || candidate.avatarId).toLowerCase();
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base} ${n}`;
    used.add(key);
    keys.set(key, candidate);
  }
  return keys;
}

/** `nameOf` is the spoken name of an avatar id. */
export function createSystemOneAddressee(client: SystemOneClient, nameOf: (avatarId: string) => string): AddresseeFunction {
  const speakerName = (from: string): string => (from.startsWith('avatar:') ? nameOf(from.slice('avatar:'.length)) : 'Kevin');
  return async (input, signal) => {
    const speaker = speakerName(input.speaker);
    const options = optionKeys(input.candidates, [PERSON_KEY, ALL_KEY]);
    const criteria: Record<string, string> = {};
    for (const [key, candidate] of options) criteria[key] = `${candidate.name || candidate.avatarId} is the one being spoken to.`;
    if (input.includePerson) criteria[PERSON_KEY] = 'Kevin, the person in the room, is the one being spoken to.';
    criteria[ALL_KEY] = 'Everyone in the room is being spoken to, or no one in particular.';
    const { who } = await client.ask(
      stateFor(input.recent, { speaker, text: input.text }, speakerName),
      { who: { type: 'choice', instructions: `Who is ${speaker} speaking to in their last line?`, criteria } },
      { signal },
    );
    let best: { key: string; p: number } | null = null;
    for (const [key, p] of Object.entries(who)) if (!best || p > best.p) best = { key, p };
    if (!best) return { avatarId: null, confidence: 0 };
    const avatarId = best.key === PERSON_KEY ? 'person' : best.key === ALL_KEY ? 'all' : (options.get(best.key)?.avatarId ?? null);
    return { avatarId, confidence: best.p };
  };
}

/** One call, one score question per candidate. `nameOfSpeaker` shows a line's speaker as a name. */
export function createSystemOneBid(client: SystemOneClient, nameOfSpeaker: (from: string) => string = (from) => from): BidFunction {
  return async (candidates, recentLines, signal) => {
    if (candidates.length === 0) return [];
    const questions: Record<string, { type: 'score'; instructions: string; criteria: string[] }> = {};
    candidates.forEach((candidate, index) => {
      questions[`bid${index}`] = {
        type: 'score',
        instructions: `How much does ${candidate.name || candidate.avatarId} want to reply right now to the last line?`,
        criteria: WANT_LEVELS,
      };
    });
    const answers = await client.ask(stateFor(recentLines, null, nameOfSpeaker), questions, { signal });
    return candidates.map((candidate, index) => ({
      avatarId: candidate.avatarId,
      want: answers[`bid${index}`] ?? 0,
      reason: 'quick decision',
    }));
  };
}
