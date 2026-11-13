/**
 * The floor's quick decisions on the System 1 model (Laya): who a line is aimed at, and how much
 * each avatar wants to reply. Each is one small call that sees only a few clipped lines. Both
 * reject on any failure, so the caller falls back to the Idle thoughts model or the old rules.
 */
import type { SystemOneClient } from '../decide/system-one.js';
import type { AddresseeFunction, BidCandidate, BidFunction, FloorLine, IntentInput, QuickIntentFunction, QuickIntentResult } from './floor-manager.js';

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
export function optionKeys(candidates: BidCandidate[], taken: string[]): Map<string, BidCandidate> {
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

/** The prompt the floor model was trained on (services/laya/training/floor_prompt.py). Keep the strings identical. */
const TRAINED_RECENT_LINES = 4;
const TRAINED_LINE_CHARS = 200;

const trainedClip = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, TRAINED_LINE_CHARS);

const displayName = (candidate: BidCandidate): string => candidate.name.trim() || candidate.avatarId;

/** Mirrors `build_state`: a plain string, one fact per line, ending with Kevin's line. */
export function buildFloorState(input: IntentInput, speakerName: (from: string) => string): string {
  const nameById = new Map(input.candidates.map((candidate) => [candidate.avatarId, displayName(candidate)] as const));
  const room = input.candidates.map((candidate) => (candidate.avatarId === input.hostId ? `${displayName(candidate)} (host)` : displayName(candidate)));
  const partner = input.partnerId ? nameById.get(input.partnerId) : undefined;
  return [
    `Avatars in the room: ${room.join(', ')}.`,
    `Kevin last spoke with: ${partner ?? 'nobody'}.`,
    ...input.recent.slice(-TRAINED_RECENT_LINES).map((line) => `${speakerName(line.from)}: ${trainedClip(line.text)}`),
    `Kevin: ${input.text}`,
  ].join('\n');
}

type ChoiceQuestions = Record<'addressed' | 'wants' | 'other', { type: 'choice'; instructions: string; criteria: Record<string, string> }>;

/** Mirrors `build_questions`. Returns the option keys too, to map the answers back to avatars. */
export function buildFloorQuestions(candidates: BidCandidate[]): { questions: ChoiceQuestions; keys: Map<string, BidCandidate> } {
  const keys = optionKeys(candidates, [ALL_KEY, 'unclear', 'none']);
  const addressed: Record<string, string> = {};
  const other: Record<string, string> = {};
  for (const [key, candidate] of keys) {
    addressed[key] = `Kevin is speaking to ${displayName(candidate)}`;
    other[key] = displayName(candidate);
  }
  addressed[ALL_KEY] = 'Kevin is speaking to all the avatars';
  addressed.unclear = 'The line does not say which avatar he is speaking to';
  other.none = 'no other avatar is involved';
  return {
    keys,
    questions: {
      addressed: { type: 'choice', instructions: 'Which avatar is Kevin speaking to in his last line, the one who should act on it?', criteria: addressed },
      wants: {
        type: 'choice',
        instructions: 'What does Kevin want that avatar to do?',
        criteria: {
          answer: 'reply to Kevin or do what he asks',
          converse: 'go and have a conversation with another avatar',
          relay: 'ask or tell another avatar something for Kevin',
        },
      },
      other: { type: 'choice', instructions: 'Which other avatar should they talk to or pass the message to?', criteria: other },
    },
  };
}

const topOf = (probabilities: Record<string, number>): { key: string; p: number } | null => {
  let best: { key: string; p: number } | null = null;
  for (const [key, p] of Object.entries(probabilities)) if (!best || p > best.p) best = { key, p };
  return best;
};

/**
 * Kevin's line on the fine-tuned floor model, in exactly the format it was trained on. The confidence is the
 * lowest top probability of the questions that matter (`other` only counts for converse and relay).
 * Rejects on any failure, so the floor manager asks the chat model instead.
 */
export function createSystemOneIntent(client: SystemOneClient, nameOf: (avatarId: string) => string): QuickIntentFunction {
  const speakerName = (from: string): string => (from.startsWith('avatar:') ? nameOf(from.slice('avatar:'.length)) : 'Kevin');
  return async (input, signal) => {
    const state = buildFloorState(input, speakerName);
    const { questions, keys } = buildFloorQuestions(input.candidates);
    const answers = await client.ask(state, questions, { signal });
    const addressedTop = topOf(answers.addressed);
    const wantsTop = topOf(answers.wants);
    const otherTop = topOf(answers.other);
    if (!addressedTop || !wantsTop || !otherTop) throw new Error('The quick intent answer was incomplete.');
    const wants = wantsTop.key as QuickIntentResult['wants'];
    if (wants !== 'answer' && wants !== 'converse' && wants !== 'relay') throw new Error('The quick intent answer made no sense.');
    let addressed: string;
    if (addressedTop.key === ALL_KEY || addressedTop.key === 'unclear') addressed = addressedTop.key;
    else {
      const candidate = keys.get(addressedTop.key);
      if (!candidate) throw new Error('The quick intent answer made no sense.');
      addressed = candidate.avatarId;
    }
    let other: string | null = null;
    if (otherTop.key !== 'none') {
      const candidate = keys.get(otherTop.key);
      if (!candidate) throw new Error('The quick intent answer made no sense.');
      other = candidate.avatarId;
    }
    const confidence = Math.min(addressedTop.p, wantsTop.p, wants === 'answer' ? 1 : otherTop.p);
    return { addressed, wants, other, confidence };
  };
}
