/**
 * The name and phrase rules for what Kevin says when several avatars are in the scene, and the
 * classifier that says whether those rules are sure about a line ("clear") or whether a model
 * should look at it. Pure and dependency-free: the floor manager uses it, and the tests replay
 * a table of sentences through it.
 *
 * Clear lines are decided by the rules alone: nobody is named (host or last partner), the
 * avatar is called by name as the first words of the line, a short or opening group word,
 * "talk to each other", a question to pass on, a conversation with a named avatar, or Kevin
 * saying he wants to talk to the avatar himself. Anything else (two or more names with no
 * explicit pattern, one name inside a longer sentence, a group word buried in a longer line that
 * names someone) is not clear.
 */

export const GROUP_PATTERN = /\b(?:you two|you both|both of you|both|everyone|everybody|all of you|you all|y'all)\b/i;

/** "Talk to each other", "have a chat", "discuss it between you": Kevin wants the avatars to converse out loud. */
export const TALK_PATTERN =
  /\b(?:talk|chat|speak|converse|discuss|debate|argue)\b[^.?!]{0,40}\b(?:to each other|with each other|among yourselves|between yourselves|together|between you)\b|\b(?:have|hold) a (?:chat|conversation|discussion|debate)\b|\b(?:you two|you both|both of you)\b[^.?!]{0,20}\b(?:talk|chat|discuss|debate)\b/i;

/** A group word is a rule only when it opens the line or the line is this short (in words). */
export const SHORT_LINE_WORDS = 6;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where the name first appears as a whole word (any case, "hey Sage" and "ok Sage" included), or -1. */
export function findName(text: string, name: string): number {
  const trimmed = name.trim();
  if (!trimmed) return -1;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`, 'iu');
  return pattern.exec(text)?.index ?? -1;
}

export const RELAY_PHRASES = '(?:ask|tell|check with|find out from|see if|see whether|let|remind|say to|pass (?:it |this |that )?on to)';

/** Ids of avatars whose name comes right after a relay phrase ("ask Echo", "tell Sage"), in the order named. */
export function relayTargets(text: string, candidates: string[], nameOf: (avatarId: string) => string): string[] {
  return candidates
    .map((avatarId) => {
      const name = nameOf(avatarId).trim();
      if (!name) return { avatarId, at: -1 };
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${RELAY_PHRASES}\\s+${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'iu');
      return { avatarId, at: pattern.exec(text)?.index ?? -1 };
    })
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.avatarId);
}

const NOT_A_NAME = '(?:me|us|myself|each|other|another|one|you|yourselves|everyone|everybody|both|all)';
/** Up to three words between the preposition and the name ("talk to my friend Sage"), none of which may be a pronoun for Kevin or the group. */
const BETWEEN = `(?:(?!${NOT_A_NAME}(?![\\p{L}\\p{N}_]))[\\p{L}\\p{N}'’-]+\\s+){0,3}`;
const CHAT_NOUN = '(?:conversation|chat|discussion|debate|talk)';

/** Ways to ask for a conversation WITH someone; `@NAME@` is the name. `kevin` templates are skipped when Kevin is the one who would talk ("I want to talk to Sage"). */
const CONVERSE_TEMPLATES: Array<{ pattern: string; kevin: boolean }> = [
  { pattern: `(?:talk|chat|speak|converse)\\s+(?:to|with)\\s+${BETWEEN}@NAME@`, kevin: true },
  { pattern: `(?:strike up|start|have|hold|begin|get into)\\s+(?:a|an|the|some)\\s+(?:[\\p{L}-]+\\s+)?${CHAT_NOUN}\\s+(?:with|to)\\s+${BETWEEN}@NAME@`, kevin: true },
  { pattern: `say\\s+(?:hi|hello|hey|howdy)\\s+to\\s+${BETWEEN}@NAME@`, kevin: true },
  { pattern: `get\\s+to\\s+know\\s+@NAME@`, kevin: true },
  { pattern: `introduce\\s+yourself\\s+to\\s+@NAME@`, kevin: true },
  { pattern: `you\\s+and\\s+@NAME@\\s+(?:(?:should|could|can|might|must|will|to|both|need to|ought to)\\s+)?(?:talk|chat|speak|converse)`, kevin: false },
  { pattern: `(?:argue|debate|discuss)\\b[^.?!]{0,40}?\\bwith\\s+${BETWEEN}@NAME@`, kevin: true },
];

/** The words before a match are Kevin's own ("I want to", "can I", "let's"): he is the one who would talk, not an avatar. */
function kevinIsTheSpeaker(prefix: string): boolean {
  const clause = prefix.split(/[.?!,;]/).pop() ?? '';
  return /(?<![\p{L}\p{N}_])(?:i|we|me|us|let[’']s)(?![\p{L}\p{N}_])/iu.test(clause) && !/(?<![\p{L}\p{N}_])you(?![\p{L}\p{N}_])/iu.test(clause);
}

/**
 * Looks for a request for a conversation WITH a named avatar. `target` is the avatar the conversation
 * is with; `kevinWants` is the avatar a request was found for but skipped because Kevin is the one who
 * would talk ("I want to talk to Sage").
 */
export function matchConverse(text: string, candidates: string[], nameOf: (avatarId: string) => string): { target: string | null; kevinWants: string | null } {
  let best: { avatarId: string; end: number } | null = null;
  let skipped: { avatarId: string; end: number } | null = null;
  for (const avatarId of candidates) {
    const name = nameOf(avatarId).trim();
    if (!name) continue;
    for (const template of CONVERSE_TEMPLATES) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${template.pattern.replace('@NAME@', () => `${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`)}`, 'iu');
      const match = pattern.exec(text);
      if (!match) continue;
      const end = match.index + match[0].length;
      if (template.kevin && kevinIsTheSpeaker(text.slice(0, match.index))) {
        if (!skipped || end < skipped.end) skipped = { avatarId, end };
        continue;
      }
      if (!best || end < best.end) best = { avatarId, end };
    }
  }
  return { target: best?.avatarId ?? null, kevinWants: skipped?.avatarId ?? null };
}

/**
 * The avatar Kevin wants a conversation WITH ("talk to Sage", "strike up a conversation with Echo",
 * "you and Sage should chat"), or null. When several are named, the one named first after the phrase.
 */
export function converseTarget(text: string, candidates: string[], nameOf: (avatarId: string) => string): string | null {
  return matchConverse(text, candidates, nameOf).target;
}

/** Ids of scene avatars whose names appear in the text, in the order named. */
export function namedIn(text: string, candidates: string[], nameOf: (avatarId: string) => string): string[] {
  return candidates
    .map((avatarId) => ({ avatarId, at: findName(text, nameOf(avatarId)) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.avatarId);
}

const OPENER_FILLERS = '(?:(?:hey|hi|ok|okay|so|and|um|uh|yo|right|oi)[\\s,]+)*';

/** How many characters of the text the vocative opener ("Hey Echo,") takes up, or -1 when the avatar is not the first words. */
function openerLength(text: string, name: string): number {
  const trimmed = name.trim();
  if (!trimmed) return -1;
  const pattern = new RegExp(`^[\\s"'“]*${OPENER_FILLERS}${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`, 'iu');
  const match = pattern.exec(text);
  return match ? match[0].length : -1;
}

/** The avatar the line starts with as a vocative ("Sage, ...", "Hey Echo, ...", "echo tell me a joke"), or null. */
export function vocativeOpener(text: string, candidates: string[], nameOf: (avatarId: string) => string): string | null {
  for (const avatarId of candidates) if (openerLength(text, nameOf(avatarId)) >= 0) return avatarId;
  return null;
}

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

const GROUP_OPENER = new RegExp(`^[\\s"'“]*${OPENER_FILLERS}(?:you two|you both|both of you|both|everyone|everybody|all of you|you all|y'all)(?![\\p{L}\\p{N}_'])`, 'iu');

export type PersonRuleKind =
  | 'converse'
  | 'talk-each-other'
  | 'group'
  | 'relay'
  | 'kevin-talks-to'
  | 'vocative'
  | 'multi-named'
  | 'named-inside'
  | 'no-name';

export interface PersonClass {
  kind: PersonRuleKind;
  /** The rules are sure; no model is needed. */
  clear: boolean;
  /** Short label for the trace. */
  label: string;
  named: string[];
  relayed: string[];
  /** The avatar a conversation was asked WITH ("talk to Sage"). */
  converse: string | null;
  /** The avatar Kevin himself wants to talk to ("I want to talk to Sage"). */
  kevinWants: string | null;
  /** The avatar the line starts with as a vocative. */
  vocative: string | null;
  /** The group word is a rule here (it opens the line, or the line is short) and no avatar is named. */
  groupClear: boolean;
  groupMatched: boolean;
  talkMatched: boolean;
}

/**
 * Sorts a line of Kevin's into the rule that fits it and says whether that rule is sure. The kind
 * follows the order the rules run in: a conversation with a named avatar, "talk to each other", a
 * group word, a question to pass on, Kevin talking to the avatar himself, then names.
 */
export function classifyPersonLine(text: string, avatarIds: string[], nameOf: (avatarId: string) => string): PersonClass {
  const named = namedIn(text, avatarIds, nameOf);
  const relayed = relayTargets(text, avatarIds, nameOf);
  const { target: converse, kevinWants } = matchConverse(text, avatarIds, nameOf);
  const vocative = vocativeOpener(text, avatarIds, nameOf);
  const talkMatched = TALK_PATTERN.test(text);
  const groupMatched = GROUP_PATTERN.test(text);
  const groupClear = groupMatched && named.length === 0 && (GROUP_OPENER.test(text) || wordCount(text) <= SHORT_LINE_WORDS);
  const base = { named, relayed, converse, kevinWants, vocative, groupClear, groupMatched, talkMatched };
  // "Sage, tell Echo she should talk to Rex": Sage is asked to pass it on, whatever else the line says.
  const vocativeRelay = vocative !== null && relayFromVocative(text, vocative, avatarIds, nameOf);
  if (converse && !vocativeRelay) return { ...base, kind: 'converse', clear: true, label: 'conversation with a named avatar' };
  if (talkMatched) return { ...base, kind: 'talk-each-other', clear: true, label: 'talk to each other' };
  if (groupClear) return { ...base, kind: 'group', clear: true, label: 'everyone' };
  if (relayed.length > 0) return { ...base, kind: 'relay', clear: true, label: 'question to pass on' };
  if (kevinWants && named.length === 1 && named[0] === kevinWants) return { ...base, kind: 'kevin-talks-to', clear: true, label: 'Kevin talks to the avatar himself' };
  if (groupMatched) return { ...base, kind: 'group', clear: false, label: 'group word inside a longer line' };
  if (named.length > 1) return { ...base, kind: 'multi-named', clear: false, label: 'several names' };
  if (named.length === 1) {
    return vocative === named[0]
      ? { ...base, kind: 'vocative', clear: true, label: 'called by name' }
      : { ...base, kind: 'named-inside', clear: false, label: 'a name inside the line' };
  }
  return { ...base, kind: 'no-name', clear: true, label: 'no name' };
}

/** The line starts with the avatar, then a relay phrase naming another one ("Sage, ask Echo ...", "Hey Sage, could you tell Echo ..."). */
function relayFromVocative(text: string, vocative: string, avatarIds: string[], nameOf: (avatarId: string) => string): boolean {
  const length = openerLength(text, nameOf(vocative));
  if (length < 0) return false;
  const rest = text.slice(length).replace(/^[\s,:;-]+/, '');
  const lead = new RegExp(`^(?:please\\s+|(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?${RELAY_PHRASES}\\s`, 'iu');
  return lead.test(rest) && relayTargets(rest, avatarIds, nameOf).some((id) => id !== vocative);
}
