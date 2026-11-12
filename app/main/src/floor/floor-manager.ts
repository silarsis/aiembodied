/**
 * The floor manager decides who speaks in a scene. It is pure: no Electron, no I/O, time comes in
 * with each utterance (`at`, from the caller's injected clock) and bids from an injected function.
 *
 * Rules first, then bids. Kevin (the person) always wins: his speech cancels avatar speech and
 * clears the queue (`bargeIn`). For Kevin's words, in this order: a request to converse WITH a named
 * avatar ("talk to Sage": Sage is the target, someone else starts), "talk to each other", "you two" /
 * "everyone", a question to relay ("ask Echo ..."), the avatars he names, the avatar he last talked
 * with if that was recent, the host. For an avatar's words (chatter): only the other avatars of the
 * scene may answer; in a chat Kevin asked for, the other one of the pair; else the one addressed by
 * name, else the one that bids highest above the threshold, else nobody. A chat Kevin asked for has
 * no limit and runs until he speaks; spontaneous chatter stops after a time since Kevin last spoke.
 * One avatar speaks at a time: a speaking slot and a FIFO queue.
 */

export const PARTNER_WINDOW_MS = 5 * 60_000;
export const BID_THRESHOLD = 0.5;
/** Spontaneous chatter (nobody asked for it) stops this long after it started. A chat Kevin asked for has no limit. */
export const CHATTER_MAX_MS = 5 * 60_000;
export const BID_TIMEOUT_MS = 6_000;
/** The addressee check is a quick decision; past this the old rules go on without it. */
export const ADDRESSEE_TIMEOUT_MS = 1_500;
/** How sure the check must be before its answer is used. */
export const ADDRESSEE_THRESHOLD = 0.6;
export const DEFAULT_SCENE_ID = 'default';
export const PERSON_SPEAKER = 'person:kevin';
const RECENT_LINES_LIMIT = 8;

export interface Scene {
  id: string;
  /** In scene order. */
  avatarIds: string[];
  hostId: string;
}

export type FloorSpeaker = 'person:kevin' | `avatar:${string}`;
export type SpeakerReason = 'addressed' | 'last-partner' | 'host' | 'bid' | 'all';
export type FloorChannel = 'aloud' | 'back';

export interface FloorUtterance {
  from: FloorSpeaker;
  text: string;
  /** ms since epoch. */
  at: number;
  /** An avatar's answer to Kevin: others only overhear it unless it names one of them or Kevin asked them to talk. */
  toPerson?: boolean;
}

export interface FloorDecision {
  /** Ordered: the first speaks now, the others are queued. */
  speakers: Array<{ avatarId: string; reason: SpeakerReason }>;
  channel: FloorChannel;
  /** What ran, in order, for the journal. */
  trace: string[];
  /** Set when spontaneous chatter was cut off by the time limit. */
  budget?: { kind: 'time'; ms: number };
  /** Kevin asked `starter` to have a conversation with `target`; the two alternate until he speaks. */
  converse?: { starter: string; target: string };
  /** This chatter line is part of a chat Kevin asked for (out loud, no limit). */
  talk?: boolean;
  /** Kevin asked `from` to pass a question to `to`; `to` is not a speaker until `from` has spoken. */
  relay?: { from: string; to: string };
}

export interface FloorBid {
  avatarId: string;
  /** 0..1 */
  want: number;
  reason: string;
}

export interface BidCandidate {
  avatarId: string;
  name: string;
}

export interface FloorLine {
  from: FloorSpeaker;
  text: string;
}

/** Asks the avatars how much each wants to answer. Rejecting means no bids. */
export type BidFunction = (candidates: BidCandidate[], recentLines: FloorLine[], signal: AbortSignal) => Promise<FloorBid[]>;

/** What the addressee check is asked: who is this line aimed at? */
export interface AddresseeInput {
  /** The avatar id or 'person:kevin' who spoke. */
  speaker: string;
  text: string;
  recent: FloorLine[];
  candidates: BidCandidate[];
  /** Kevin is a possible addressee too. */
  includePerson: boolean;
}

/** An avatar id, 'person' (Kevin), 'all' (everyone), or null when it cannot tell. */
export interface AddresseeResult {
  avatarId: string | 'person' | 'all' | null;
  /** 0..1 */
  confidence: number;
}

/** Decides who a line is aimed at. Rejecting means no answer. */
export type AddresseeFunction = (input: AddresseeInput, signal: AbortSignal) => Promise<AddresseeResult>;

export interface FloorManagerOptions {
  /** The scene in use. Default: every avatar in `avatarIds()`, the first one hosting. */
  scene?: () => Scene;
  /** All avatar ids in order, used for the default scene. */
  avatarIds?: () => string[];
  /** The spoken name of an avatar (AvatarProfile.name). */
  nameOf: (avatarId: string) => string;
  bid?: BidFunction;
  /** A quick check of who a line is aimed at, used where the name rules find no one clear. */
  addressee?: AddresseeFunction;
  /** True when avatar-to-avatar talk should be out loud. */
  hearChatter?: () => boolean;
  partnerWindowMs?: number;
  bidThreshold?: number;
  chatterMaxMs?: number;
  bidTimeoutMs?: number;
  addresseeTimeoutMs?: number;
  addresseeThreshold?: number;
}

const GROUP_PATTERN = /\b(?:you two|you both|both of you|both|everyone|everybody|all of you|you all|y'all)\b/i;

/** "Talk to each other", "have a chat", "discuss it between you": Kevin wants the avatars to converse out loud. */
const TALK_PATTERN =
  /\b(?:talk|chat|speak|converse|discuss|debate|argue)\b[^.?!]{0,40}\b(?:to each other|with each other|among yourselves|between yourselves|together|between you)\b|\b(?:have|hold) a (?:chat|conversation|discussion|debate)\b|\b(?:you two|you both|both of you)\b[^.?!]{0,20}\b(?:talk|chat|discuss|debate)\b/i;

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

const RELAY_PHRASES = '(?:ask|tell|check with|find out from|see if|see whether|let|remind|say to|pass (?:it |this |that )?on to)';

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
const BETWEEN = `(?:(?!${NOT_A_NAME}(?![\\p{L}\\p{N}_]))[\\p{L}\\p{N}'\u2019-]+\\s+){0,3}`;
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
  return /(?<![\p{L}\p{N}_])(?:i|we|me|us|let[\u2019']s)(?![\p{L}\p{N}_])/iu.test(clause) && !/(?<![\p{L}\p{N}_])you(?![\p{L}\p{N}_])/iu.test(clause);
}

/**
 * The avatar Kevin wants a conversation WITH ("talk to Sage", "strike up a conversation with Echo",
 * "you and Sage should chat"), or null. When several are named, the one named first after the phrase.
 */
export function converseTarget(text: string, candidates: string[], nameOf: (avatarId: string) => string): string | null {
  let best: { avatarId: string; end: number } | null = null;
  for (const avatarId of candidates) {
    const name = nameOf(avatarId).trim();
    if (!name) continue;
    for (const template of CONVERSE_TEMPLATES) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${template.pattern.replace('@NAME@', () => `${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`)}`, 'iu');
      const match = pattern.exec(text);
      if (!match) continue;
      if (template.kevin && kevinIsTheSpeaker(text.slice(0, match.index))) continue;
      const end = match.index + match[0].length;
      if (!best || end < best.end) best = { avatarId, end };
    }
  }
  return best?.avatarId ?? null;
}

export class FloorManager {
  private readonly options: FloorManagerOptions;
  private readonly partnerWindowMs: number;
  private readonly bidThreshold: number;
  private readonly chatterMaxMs: number;
  private readonly bidTimeoutMs: number;
  private readonly addresseeTimeoutMs: number;
  private readonly addresseeThreshold: number;

  private partner: { avatarId: string; at: number } | null = null;
  private chatterStartedAt: number | null = null;
  private speaking: string | null = null;
  private queue: string[] = [];
  private recent: FloorLine[] = [];
  /**
   * Set while a chat Kevin asked for runs: out loud, no limit. With a `pair`, the two alternate whatever
   * the lines say and anyone else only overhears; without one, lines go to the next avatar in scene order.
   */
  private talk: { pair: [string, string] | null } | null = null;
  /** Set while Kevin's "ask Echo ..." waits for the asked avatar to pass it on. */
  private relay: { from: string; to: string } | null = null;

  constructor(options: FloorManagerOptions) {
    this.options = options;
    this.partnerWindowMs = options.partnerWindowMs ?? PARTNER_WINDOW_MS;
    this.bidThreshold = options.bidThreshold ?? BID_THRESHOLD;
    this.chatterMaxMs = options.chatterMaxMs ?? CHATTER_MAX_MS;
    this.bidTimeoutMs = options.bidTimeoutMs ?? BID_TIMEOUT_MS;
    this.addresseeTimeoutMs = options.addresseeTimeoutMs ?? ADDRESSEE_TIMEOUT_MS;
    this.addresseeThreshold = options.addresseeThreshold ?? ADDRESSEE_THRESHOLD;
  }

  scene(): Scene {
    if (this.options.scene) return this.options.scene();
    const avatarIds = this.options.avatarIds?.() ?? [];
    return { id: DEFAULT_SCENE_ID, avatarIds, hostId: avatarIds.includes('echo') ? 'echo' : (avatarIds[0] ?? 'echo') };
  }

  /** More than one avatar is in the scene, so the floor has anything to decide. */
  isMulti(): boolean {
    return this.scene().avatarIds.length > 1;
  }

  /** Who holds the speaking slot and who waits, for tests and the journal. */
  state(): { speaking: string | null; queue: string[]; talking: boolean; partner: string | null } {
    return { speaking: this.speaking, queue: [...this.queue], talking: this.talk !== null, partner: this.partner?.avatarId ?? null };
  }

  async route(utterance: FloorUtterance): Promise<FloorDecision> {
    this.remember(utterance);
    return utterance.from === PERSON_SPEAKER ? this.routePerson(utterance) : this.routeAvatar(utterance);
  }

  private remember(utterance: FloorUtterance): void {
    this.recent.push({ from: utterance.from, text: utterance.text });
    if (this.recent.length > RECENT_LINES_LIMIT) this.recent = this.recent.slice(-RECENT_LINES_LIMIT);
  }

  private async routePerson(utterance: FloorUtterance): Promise<FloorDecision> {
    const scene = this.scene();
    const trace: string[] = [];
    // Kevin spoke: the chatter time limit starts over and any chat he asked for ends.
    this.chatterStartedAt = null;
    this.talk = null;
    this.relay = null;
    const done = (speakers: FloorDecision['speakers'], extra: Partial<FloorDecision> = {}): FloorDecision => {
      if (speakers[0]) this.partner = { avatarId: speakers[0].avatarId, at: utterance.at };
      return { speakers, channel: 'aloud', trace, ...extra };
    };
    if (scene.avatarIds.length === 0) {
      trace.push('person: no avatars in scene');
      return { speakers: [], channel: 'aloud', trace };
    }
    if (scene.avatarIds.length === 1) {
      trace.push(`person: one avatar in scene -> ${scene.avatarIds[0]}`);
      return done([{ avatarId: scene.avatarIds[0], reason: 'host' }]);
    }
    const named = this.namedIn(utterance.text, scene.avatarIds);
    const relayed = relayTargets(utterance.text, scene.avatarIds, this.options.nameOf);
    const converse = converseTarget(utterance.text, scene.avatarIds, this.options.nameOf);
    if (converse) {
      // "Talk to Sage": Sage is who the conversation is with, so someone else starts it.
      const target = converse;
      const starterNamed = [...relayed.filter((id) => id !== target), ...named.filter((id) => id !== target)][0];
      const partnerId = this.partner?.avatarId;
      const partnerOk =
        partnerId !== undefined &&
        partnerId !== target &&
        scene.avatarIds.includes(partnerId) &&
        utterance.at - (this.partner?.at ?? 0) <= this.partnerWindowMs;
      let starter: string;
      let reason: SpeakerReason;
      if (starterNamed) {
        starter = starterNamed;
        reason = 'addressed';
      } else if (partnerOk && partnerId) {
        starter = partnerId;
        reason = 'last-partner';
      } else if (scene.hostId !== target && scene.avatarIds.includes(scene.hostId)) {
        starter = scene.hostId;
        reason = 'host';
      } else {
        starter = scene.avatarIds.find((id) => id !== target) ?? scene.hostId;
        reason = 'host';
      }
      this.talk = { pair: [starter, target] };
      trace.push(`person: asked ${starter} to have a conversation with ${target} (${reason}) -> ${starter} starts, ${starter} and ${target} alternate, out loud`);
      return done([{ avatarId: starter, reason }], { converse: { starter, target } });
    }
    if (TALK_PATTERN.test(utterance.text)) {
      const first = named[0] ?? (this.partner && scene.avatarIds.includes(this.partner.avatarId) ? this.partner.avatarId : scene.hostId);
      const second = scene.avatarIds.length === 2 ? scene.avatarIds.find((id) => id !== first) : undefined;
      this.talk = { pair: second ? [first, second] : null };
      trace.push(`person: asked them to talk to each other -> ${first} starts, out loud${second ? `, ${first} and ${second} alternate` : ', in scene order'}`);
      return done([{ avatarId: first, reason: named.length > 0 ? 'addressed' : 'host' }], second ? { converse: { starter: first, target: second } } : {});
    }
    if (GROUP_PATTERN.test(utterance.text)) {
      trace.push('person: addressed everyone -> all avatars in scene order');
      return done(scene.avatarIds.map((avatarId) => ({ avatarId, reason: 'all' as const })));
    }
    if (relayed.length > 0) {
      // "Sage, ask Echo ...": Sage answers Kevin and passes the question on; Echo is not a speaker yet.
      let answerers = named.filter((id) => !relayed.includes(id));
      if (answerers.length === 0) {
        const partnerId = this.partner?.avatarId;
        const partnerOk =
          partnerId !== undefined && scene.avatarIds.includes(partnerId) && utterance.at - (this.partner?.at ?? 0) <= this.partnerWindowMs && !relayed.includes(partnerId);
        const pick = partnerOk ? partnerId : !relayed.includes(scene.hostId) ? scene.hostId : scene.avatarIds.find((id) => !relayed.includes(id));
        answerers = pick ? [pick] : [];
      }
      if (answerers.length > 0) {
        this.relay = { from: answerers[0], to: relayed[0] };
        trace.push(`person: ${answerers[0]} is asked to pass a question to ${relayed[0]} -> ${answerers[0]} answers`);
        return done(
          answerers.map((id) => ({ avatarId: id, reason: named.includes(id) ? ('addressed' as const) : ('host' as const) })),
          { relay: { ...this.relay } },
        );
      }
    }
    if (named.length > 1) {
      // Two or more names and no rule decided: ask who should answer.
      const picked = await this.askAddressee(
        { speaker: utterance.from, text: utterance.text, recent: this.recentBefore(), candidates: this.candidatesOf(named), includePerson: false },
        trace,
        'person',
      );
      if (picked && picked !== 'person' && picked !== 'all' && named.includes(picked)) {
        trace.push(`person: addressee check -> only ${picked} answers`);
        return done([{ avatarId: picked, reason: 'addressed' }]);
      }
    }
    if (named.length > 0) {
      trace.push(`person: addressed by name -> ${named.join(', ')}`);
      return done(named.map((avatarId) => ({ avatarId, reason: 'addressed' as const })));
    }
    trace.push('person: no name');
    if (this.partner && scene.avatarIds.includes(this.partner.avatarId)) {
      const age = utterance.at - this.partner.at;
      if (age <= this.partnerWindowMs) {
        trace.push(`person: last partner ${this.partner.avatarId} ${Math.round(age / 1000)} s ago -> ${this.partner.avatarId}`);
        return done([{ avatarId: this.partner.avatarId, reason: 'last-partner' }]);
      }
      trace.push(`person: last partner ${this.partner.avatarId} too long ago (${Math.round(age / 1000)} s)`);
    }
    trace.push(`person: host -> ${scene.hostId}`);
    return done([{ avatarId: scene.hostId, reason: 'host' }]);
  }

  /** Ids of scene avatars whose names appear in the text, in the order named. */
  private namedIn(text: string, candidates: string[]): string[] {
    return candidates
      .map((avatarId) => ({ avatarId, at: findName(text, this.options.nameOf(avatarId)) }))
      .filter((entry) => entry.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.avatarId);
  }

  private async routeAvatar(utterance: FloorUtterance): Promise<FloorDecision> {
    const scene = this.scene();
    const senderOf = utterance.from.slice('avatar:'.length);
    // A chat Kevin asked for covers its pair (or everyone, when no pair was fixed); a third avatar only overhears.
    const talk = this.talk && (!this.talk.pair || this.talk.pair.includes(senderOf)) ? this.talk : null;
    const channel: FloorChannel = talk || this.options.hearChatter?.() ? 'aloud' : 'back';
    const trace: string[] = [];
    const none = (extra: Partial<FloorDecision> = {}): FloorDecision => ({ speakers: [], channel, trace, ...extra });
    const senderId = utterance.from.slice('avatar:'.length);
    if (!scene.avatarIds.includes(senderId)) {
      trace.push(`avatar: ${senderId} is not in the scene`);
      return none();
    }
    const others = scene.avatarIds.filter((avatarId) => avatarId !== senderId);
    if (others.length === 0) {
      trace.push('avatar: nobody else in the scene');
      return none();
    }
    // Spontaneous chatter stops after a time limit; a chat Kevin asked for has none.
    const elapsed = this.chatterStartedAt === null ? 0 : utterance.at - this.chatterStartedAt;
    if (!talk && this.chatterStartedAt !== null && elapsed >= this.chatterMaxMs) {
      trace.push(`avatar: chatter time limit reached (${Math.round(elapsed / 1000)} s)`);
      return none({ budget: { kind: 'time', ms: elapsed } });
    }
    const take = (avatarId: string, reason: SpeakerReason, aloud: FloorChannel = channel): FloorDecision => {
      this.chatterStartedAt ??= utterance.at;
      return { speakers: [{ avatarId, reason }], channel: aloud, trace, ...(talk ? { talk: true } : {}) };
    };
    if (this.relay && this.relay.from === senderId && others.includes(this.relay.to)) {
      // Kevin asked for this, so he hears it even when chatter is off.
      const to = this.relay.to;
      this.relay = null;
      trace.push(`avatar: ${senderId} passes Kevin's question to ${to}`);
      return { ...take(to, 'addressed', 'aloud'), relay: { from: senderId, to } };
    }
    if (talk?.pair) {
      // Kevin asked these two to talk: the other one of the pair answers, whatever the line says.
      const next = talk.pair.find((id) => id !== senderId);
      if (next && others.includes(next)) {
        trace.push(`avatar: conversation Kevin asked for -> ${next} answers`);
        return take(next, 'addressed');
      }
    }
    const named = this.namedIn(utterance.text, others);
    if (named.length > 0) {
      trace.push(`avatar: ${senderId} addressed ${named[0]} by name`);
      return take(named[0], 'addressed');
    }
    if (talk) {
      // Kevin asked them to talk: the next avatar in scene order answers, no bidding.
      const order = scene.avatarIds;
      const next = order[(order.indexOf(senderId) + 1) % order.length];
      trace.push(`avatar: chat Kevin asked for -> ${next} answers`);
      return take(next, 'addressed');
    }
    const relayWaiting = this.relay !== null && this.relay.from === senderId;
    if (!relayWaiting) {
      // No name, no relay, no chat Kevin asked for: ask who the line is aimed at ("lenha, what are you up to?").
      const picked = await this.askAddressee(
        { speaker: utterance.from, text: utterance.text, recent: this.recentBefore(), candidates: this.candidatesOf(others), includePerson: true },
        trace,
        'avatar',
      );
      if (picked && picked !== 'person' && picked !== 'all' && others.includes(picked)) {
        trace.push(`avatar: addressee check -> ${picked}`);
        return take(picked, 'addressed');
      }
      if (picked === 'person' && utterance.toPerson) {
        trace.push('avatar: addressee check -> Kevin; others only overhear');
        return none();
      }
    }
    if (utterance.toPerson) {
      trace.push('avatar: answer to Kevin; others only overhear');
      return none();
    }
    trace.push('avatar: no name, asking for bids');
    const bids = await this.collectBids(others, trace);
    const order = new Map(scene.avatarIds.map((avatarId, index) => [avatarId, index] as const));
    const best = bids
      .filter((bid) => order.has(bid.avatarId) && bid.avatarId !== senderId)
      .sort((a, b) => b.want - a.want || (order.get(a.avatarId) ?? 0) - (order.get(b.avatarId) ?? 0))[0];
    if (!best || best.want < this.bidThreshold) {
      trace.push(best ? `avatar: best bid ${best.avatarId} ${best.want.toFixed(2)} is below ${this.bidThreshold}` : 'avatar: no bids -> silence');
      return none();
    }
    trace.push(`avatar: ${best.avatarId} wins with ${best.want.toFixed(2)}${best.reason ? ` (${best.reason})` : ''}`);
    return take(best.avatarId, 'bid');
  }

  private candidatesOf(avatarIds: string[]): BidCandidate[] {
    return avatarIds.map((avatarId) => ({ avatarId, name: this.options.nameOf(avatarId) }));
  }

  /** The lines said before the one being routed. */
  private recentBefore(): FloorLine[] {
    return this.recent.slice(0, -1);
  }

  /**
   * Ask the addressee check, if there is one. Returns the confident answer ('person', 'all' or an
   * avatar id), or null when there is no check, it failed or timed out, or it was not sure enough.
   */
  private async askAddressee(input: AddresseeInput, trace: string[], label: 'person' | 'avatar'): Promise<string | null> {
    const ask = this.options.addressee;
    if (!ask) return null;
    const signal = AbortSignal.timeout(this.addresseeTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Addressee check timed out')), this.addresseeTimeoutMs);
        timer.unref?.();
      });
      const run = ask(input, signal);
      run.catch(() => undefined);
      const result = await Promise.race([run, timeout]);
      const confidence = Number.isFinite(result?.confidence) ? result.confidence : 0;
      if (!result || result.avatarId === null || confidence < this.addresseeThreshold) {
        trace.push(`${label}: addressee check not sure${result?.avatarId ? ` (${result.avatarId} ${confidence.toFixed(2)})` : ''}`);
        return null;
      }
      return result.avatarId;
    } catch (error) {
      trace.push(`${label}: addressee check failed (${error instanceof Error ? error.message : String(error)})`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async collectBids(candidates: string[], trace: string[]): Promise<FloorBid[]> {
    const bid = this.options.bid;
    if (!bid) {
      trace.push('avatar: no bid function');
      return [];
    }
    const signal = AbortSignal.timeout(this.bidTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Bidding timed out')), this.bidTimeoutMs);
        timer.unref?.();
      });
      const run = bid(
        candidates.map((avatarId) => ({ avatarId, name: this.options.nameOf(avatarId) })),
        [...this.recent],
        signal,
      );
      run.catch(() => undefined);
      const raw = await Promise.race([run, timeout]);
      return (Array.isArray(raw) ? raw : []).map((entry) => ({
        avatarId: String(entry.avatarId),
        want: Number.isFinite(entry.want) ? Math.min(1, Math.max(0, entry.want)) : 0,
        reason: typeof entry.reason === 'string' ? entry.reason : '',
      }));
    } catch (error) {
      trace.push(`avatar: bidding failed (${error instanceof Error ? error.message : String(error)})`);
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Ask for the speaking slot. `granted` means speak now; `queued` means wait for `release`;
   * `duplicate` means the avatar already holds the slot or waits.
   */
  request(avatarId: string): 'granted' | 'queued' | 'duplicate' {
    if (this.speaking === avatarId || this.queue.includes(avatarId)) return 'duplicate';
    if (this.speaking === null) {
      this.speaking = avatarId;
      return 'granted';
    }
    this.queue.push(avatarId);
    return 'queued';
  }

  /** The avatar is done (or was cancelled). Returns the next queued speaker, who now holds the slot. */
  release(avatarId: string): string | null {
    if (this.speaking !== avatarId) {
      this.queue = this.queue.filter((id) => id !== avatarId);
      return null;
    }
    this.speaking = this.queue.shift() ?? null;
    return this.speaking;
  }

  /** "Hey Echo" was said: the host is the one listening, whoever Kevin spoke with last. */
  listenTo(avatarId: string, at: number): void {
    if (this.scene().avatarIds.includes(avatarId)) this.partner = { avatarId, at };
  }

  /** Kevin speaks: clear the queue, free the slot, reset the chatter time limit and end any chat. Returns the avatars to cancel. */
  bargeIn(): string[] {
    const cancel = this.speaking === null ? [] : [this.speaking];
    this.speaking = null;
    this.queue = [];
    this.chatterStartedAt = null;
    this.talk = null;
    this.relay = null;
    return cancel;
  }
}
