/**
 * The floor manager decides who speaks in a scene. It is pure: no Electron, no I/O, time comes in
 * with each utterance (`at`, from the caller's injected clock) and bids from an injected function.
 *
 * Rules first, then a model for the lines the rules are unsure of, then bids. Kevin (the person) always wins: his speech cancels avatar speech and
 * clears the queue (`bargeIn`). For Kevin's words, in this order: a request to converse WITH a named
 * avatar ("talk to Sage": Sage is the target, someone else starts), "talk to each other", "you two" /
 * "everyone", a question to relay ("ask Echo ..."), the avatars he names, the avatar he last talked
 * with if that was recent, the host. For an avatar's words (chatter): only the other avatars of the
 * scene may answer; in a chat Kevin asked for, the other one of the pair; else the one addressed by
 * name, else the one that bids highest above the threshold, else nobody. A chat Kevin asked for has
 * no limit and runs until he speaks; spontaneous chatter stops after a time since Kevin last spoke.
 * One avatar speaks at a time: a speaking slot and a FIFO queue.
 */

import { classifyPersonLine, namedIn, type PersonClass } from './person-rules.js';

export const PARTNER_WINDOW_MS = 5 * 60_000;
export const BID_THRESHOLD = 0.5;
/** Spontaneous chatter (nobody asked for it) stops this long after it started. A chat Kevin asked for has no limit. */
export const CHATTER_MAX_MS = 5 * 60_000;
export const BID_TIMEOUT_MS = 6_000;
/** The addressee check is a quick decision; past this the old rules go on without it. */
export const ADDRESSEE_TIMEOUT_MS = 1_500;
/** How sure the check must be before its answer is used. */
export const ADDRESSEE_THRESHOLD = 0.6;
/** The intent model is asked only about lines the rules are not sure of; past this the rules decide. */
export const INTENT_TIMEOUT_MS = 2_500;
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
  /** For Kevin's lines: the rules were sure, the intent model decided, or the model failed and the rules decided. */
  decidedBy?: 'rules' | 'model' | 'rules-fallback';
}

/** What the intent check is asked about one of Kevin's lines. */
export interface IntentInput {
  text: string;
  /** The lines said before this one, oldest first. */
  recent: FloorLine[];
  /** The avatars in the scene, in scene order. */
  candidates: BidCandidate[];
  hostId: string;
  /** The avatar Kevin last talked with, when that was within the partner window. */
  partnerId: string | null;
}

/** What the intent check says Kevin means. */
export interface IntentResult {
  /** The avatar Kevin speaks TO, 'everyone', or 'unclear' when the line names no listener. */
  addressed: string | 'everyone' | 'unclear';
  wants: 'answer' | 'converse' | 'relay';
  /** The other avatar when `wants` is converse or relay. */
  other: string | null;
}

/** Reads one of Kevin's lines and says who should act on it and what he wants. Rejecting means no answer. */
export type IntentFunction = (input: IntentInput, signal: AbortSignal) => Promise<IntentResult>;

/** What a routing step decided, before it is committed to the manager's state. */
interface PersonPlan {
  speakers: FloorDecision['speakers'];
  trace: string[];
  converse?: { starter: string; target: string };
  relay?: { from: string; to: string };
  /** Set to start (or, with null, clear) a chat Kevin asked for. */
  talk?: { pair: [string, string] | null } | null;
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
  /** Reads Kevin's lines the rules are not sure about (several names, a name inside a longer sentence). */
  intent?: IntentFunction;
  /** True when avatar-to-avatar talk should be out loud. */
  hearChatter?: () => boolean;
  partnerWindowMs?: number;
  bidThreshold?: number;
  chatterMaxMs?: number;
  bidTimeoutMs?: number;
  addresseeTimeoutMs?: number;
  addresseeThreshold?: number;
  intentTimeoutMs?: number;
}

export { converseTarget, findName, relayTargets } from './person-rules.js';

export class FloorManager {
  private readonly options: FloorManagerOptions;
  private readonly partnerWindowMs: number;
  private readonly bidThreshold: number;
  private readonly chatterMaxMs: number;
  private readonly bidTimeoutMs: number;
  private readonly addresseeTimeoutMs: number;
  private readonly addresseeThreshold: number;
  private readonly intentTimeoutMs: number;

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
  /** Counts Kevin's lines; an intent answer for an older one is dropped. */
  private personSeq = 0;
  private pendingIntent: AbortController | null = null;

  constructor(options: FloorManagerOptions) {
    this.options = options;
    this.partnerWindowMs = options.partnerWindowMs ?? PARTNER_WINDOW_MS;
    this.bidThreshold = options.bidThreshold ?? BID_THRESHOLD;
    this.chatterMaxMs = options.chatterMaxMs ?? CHATTER_MAX_MS;
    this.bidTimeoutMs = options.bidTimeoutMs ?? BID_TIMEOUT_MS;
    this.addresseeTimeoutMs = options.addresseeTimeoutMs ?? ADDRESSEE_TIMEOUT_MS;
    this.addresseeThreshold = options.addresseeThreshold ?? ADDRESSEE_THRESHOLD;
    this.intentTimeoutMs = options.intentTimeoutMs ?? INTENT_TIMEOUT_MS;
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
    // Kevin spoke: the chatter time limit starts over, any chat he asked for ends, and an intent call still pending for an earlier line is dropped.
    this.chatterStartedAt = null;
    this.talk = null;
    this.relay = null;
    this.pendingIntent?.abort();
    this.pendingIntent = null;
    const seq = ++this.personSeq;
    const finish = (plan: PersonPlan, decidedBy: NonNullable<FloorDecision['decidedBy']>): FloorDecision => {
      trace.push(...plan.trace);
      if (plan.talk !== undefined) this.talk = plan.talk;
      if (plan.relay) this.relay = { ...plan.relay };
      if (plan.speakers[0]) this.partner = { avatarId: plan.speakers[0].avatarId, at: utterance.at };
      return {
        speakers: plan.speakers,
        channel: 'aloud',
        trace,
        decidedBy,
        ...(plan.converse ? { converse: plan.converse } : {}),
        ...(plan.relay ? { relay: { ...plan.relay } } : {}),
      };
    };
    if (scene.avatarIds.length === 0) {
      trace.push('person: no avatars in scene');
      return { speakers: [], channel: 'aloud', trace };
    }
    if (scene.avatarIds.length === 1) {
      return finish({ speakers: [{ avatarId: scene.avatarIds[0], reason: 'host' }], trace: [`person: one avatar in scene -> ${scene.avatarIds[0]}`] }, 'rules');
    }
    const rule = classifyPersonLine(utterance.text, scene.avatarIds, this.options.nameOf);
    const byRules = this.planByRules(rule, utterance, scene);
    if (rule.clear) {
      trace.push(`person: clear rule (${rule.label})`);
      return finish(byRules, 'rules');
    }
    const intent = this.options.intent;
    if (!intent) {
      trace.push(`person: not clear (${rule.label}) and no intent model -> rules`);
      return finish(byRules, 'rules');
    }
    trace.push(`person: not clear (${rule.label}) -> asking the intent model`);
    const started = Date.now();
    try {
      const result = await this.askIntent(intent, utterance, scene);
      if (seq !== this.personSeq) return this.superseded(trace);
      const ms = Date.now() - started;
      trace.push(`person: intent model -> ${result.addressed} ${result.wants}${result.other ? ` ${result.other}` : ''} (${ms} ms)`);
      return finish(this.planFromIntent(result, utterance, scene), 'model');
    } catch (error) {
      if (seq !== this.personSeq) return this.superseded(trace);
      trace.push(`person: intent model failed (${error instanceof Error ? error.message : String(error)}) -> rules`);
      return finish(byRules, 'rules-fallback');
    }
  }

  private superseded(trace: string[]): FloorDecision {
    trace.push('person: Kevin spoke again before the intent model answered; dropped');
    return { speakers: [], channel: 'aloud', trace };
  }

  /** One call to the intent function, bounded by `intentTimeoutMs` and dropped when Kevin speaks again. */
  private async askIntent(intent: IntentFunction, utterance: FloorUtterance, scene: Scene): Promise<IntentResult> {
    const controller = new AbortController();
    this.pendingIntent = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.intentTimeoutMs)]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Intent model timed out')), this.intentTimeoutMs);
        timer.unref?.();
      });
      const run = intent(
        {
          text: utterance.text,
          recent: this.recentBefore(),
          candidates: this.candidatesOf(scene.avatarIds),
          hostId: scene.hostId,
          partnerId: this.freshPartner(scene, utterance.at),
        },
        signal,
      );
      run.catch(() => undefined);
      const result = await Promise.race([run, timeout]);
      const valid =
        result &&
        (result.addressed === 'everyone' || result.addressed === 'unclear' || scene.avatarIds.includes(result.addressed)) &&
        (result.wants === 'answer' || result.wants === 'converse' || result.wants === 'relay') &&
        (result.other === null || scene.avatarIds.includes(result.other));
      if (!valid) throw new Error('The intent answer was not usable');
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.pendingIntent === controller) this.pendingIntent = null;
    }
  }

  /** The last partner when it is in the scene and spoke with Kevin within the window, else null. */
  private freshPartner(scene: Scene, at: number): string | null {
    const partner = this.partner;
    return partner && scene.avatarIds.includes(partner.avatarId) && at - partner.at <= this.partnerWindowMs ? partner.avatarId : null;
  }

  /** Who speaks when the line says nobody: the last partner, else the host, else the first avatar; never `exclude`. */
  private fallbackSpeaker(scene: Scene, at: number, exclude: string | null): { avatarId: string; reason: SpeakerReason } | null {
    const partner = this.freshPartner(scene, at);
    if (partner && partner !== exclude) return { avatarId: partner, reason: 'last-partner' };
    if (scene.avatarIds.includes(scene.hostId) && scene.hostId !== exclude) return { avatarId: scene.hostId, reason: 'host' };
    const other = scene.avatarIds.find((id) => id !== exclude);
    return other ? { avatarId: other, reason: 'host' } : null;
  }

  /** Someone to start a conversation with `target`: `preferred` (the avatar Kevin spoke to) if it is not the target, else the fallback. */
  private starterFor(target: string, preferred: string | null, scene: Scene, at: number): { starter: string; reason: SpeakerReason } {
    if (preferred && preferred !== target && scene.avatarIds.includes(preferred)) return { starter: preferred, reason: 'addressed' };
    const fallback = this.fallbackSpeaker(scene, at, target);
    return { starter: fallback?.avatarId ?? scene.hostId, reason: fallback?.reason ?? 'host' };
  }

  private conversePlan(target: string, preferred: string | null, scene: Scene, at: number): PersonPlan {
    const { starter, reason } = this.starterFor(target, preferred, scene, at);
    return {
      speakers: [{ avatarId: starter, reason }],
      converse: { starter, target },
      talk: { pair: [starter, target] },
      trace: [`person: asked ${starter} to have a conversation with ${target} (${reason}) -> ${starter} starts, ${starter} and ${target} alternate, out loud`],
    };
  }

  private relayPlan(from: string, to: string, reason: SpeakerReason): PersonPlan {
    return {
      speakers: [{ avatarId: from, reason }],
      relay: { from, to },
      trace: [`person: ${from} is asked to pass a question to ${to} -> ${from} answers`],
    };
  }

  /** What the rules decide for a line (the fallback when the model cannot be asked). Reads state, changes none. */
  private planByRules(rule: PersonClass, utterance: FloorUtterance, scene: Scene): PersonPlan {
    const at = utterance.at;
    const { named, relayed } = rule;
    if (rule.converse && rule.kind === 'converse') {
      // "Talk to Sage": Sage is who the conversation is with, so someone else starts it.
      const target = rule.converse;
      const preferred = [...relayed.filter((id) => id !== target), ...named.filter((id) => id !== target)][0] ?? null;
      return this.conversePlan(target, preferred, scene, at);
    }
    if (rule.kind === 'talk-each-other') {
      const partner = this.partner && scene.avatarIds.includes(this.partner.avatarId) ? this.partner.avatarId : scene.hostId;
      const first = named[0] ?? partner;
      const second = scene.avatarIds.length === 2 ? scene.avatarIds.find((id) => id !== first) : undefined;
      return {
        speakers: [{ avatarId: first, reason: named.length > 0 ? 'addressed' : 'host' }],
        ...(second ? { converse: { starter: first, target: second } } : {}),
        talk: { pair: second ? [first, second] : null },
        trace: [`person: asked them to talk to each other -> ${first} starts, out loud${second ? `, ${first} and ${second} alternate` : ', in scene order'}`],
      };
    }
    if (rule.kind === 'group') {
      return { speakers: scene.avatarIds.map((avatarId) => ({ avatarId, reason: 'all' as const })), trace: ['person: addressed everyone -> all avatars in scene order'] };
    }
    if (relayed.length > 0) {
      // "Sage, ask Echo ...": Sage answers Kevin and passes the question on; Echo is not a speaker yet.
      let answerers = rule.vocative && !relayed.includes(rule.vocative) ? [rule.vocative] : named.filter((id) => !relayed.includes(id));
      if (answerers.length === 0) {
        const partnerId = this.freshPartner(scene, at);
        const pick = partnerId && !relayed.includes(partnerId) ? partnerId : !relayed.includes(scene.hostId) ? scene.hostId : scene.avatarIds.find((id) => !relayed.includes(id));
        answerers = pick ? [pick] : [];
      }
      if (answerers.length > 0) {
        const plan = this.relayPlan(answerers[0], relayed[0], named.includes(answerers[0]) ? 'addressed' : 'host');
        return { ...plan, speakers: answerers.map((id) => ({ avatarId: id, reason: named.includes(id) ? ('addressed' as const) : ('host' as const) })) };
      }
    }
    if (rule.kind === 'kevin-talks-to' && rule.kevinWants) {
      return { speakers: [{ avatarId: rule.kevinWants, reason: 'addressed' }], trace: [`person: Kevin wants to talk to ${rule.kevinWants} himself -> ${rule.kevinWants} answers Kevin`] };
    }
    if (named.length > 0) {
      return { speakers: named.map((avatarId) => ({ avatarId, reason: 'addressed' as const })), trace: [`person: addressed by name -> ${named.join(', ')}`] };
    }
    const trace = ['person: no name'];
    if (this.partner && scene.avatarIds.includes(this.partner.avatarId)) {
      const age = at - this.partner.at;
      if (age <= this.partnerWindowMs) {
        trace.push(`person: last partner ${this.partner.avatarId} ${Math.round(age / 1000)} s ago -> ${this.partner.avatarId}`);
        return { speakers: [{ avatarId: this.partner.avatarId, reason: 'last-partner' }], trace };
      }
      trace.push(`person: last partner ${this.partner.avatarId} too long ago (${Math.round(age / 1000)} s)`);
    }
    trace.push(`person: host -> ${scene.hostId}`);
    return { speakers: [{ avatarId: scene.hostId, reason: 'host' }], trace };
  }

  /** The decision the intent model's answer stands for. Answers that do not hang together count as a plain answer by the addressed avatar. */
  private planFromIntent(result: IntentResult, utterance: FloorUtterance, scene: Scene): PersonPlan {
    const at = utterance.at;
    const other = result.other && scene.avatarIds.includes(result.other) ? result.other : null;
    const concrete = result.addressed !== 'everyone' && result.addressed !== 'unclear' ? result.addressed : null;
    const consistent = result.wants === 'answer' || (other !== null && other !== concrete);
    if (result.wants === 'converse' && other && consistent) return this.conversePlan(other, concrete, scene, at);
    if (result.wants === 'relay' && other && consistent) {
      const from = concrete ?? this.fallbackSpeaker(scene, at, other)?.avatarId;
      if (from) return this.relayPlan(from, other, concrete ? 'addressed' : (this.fallbackSpeaker(scene, at, other)?.reason ?? 'host'));
    }
    if (result.addressed === 'everyone' && (result.wants === 'answer' || !consistent)) {
      return { speakers: scene.avatarIds.map((avatarId) => ({ avatarId, reason: 'all' as const })), trace: ['person: addressed everyone -> all avatars in scene order'] };
    }
    if (concrete) return { speakers: [{ avatarId: concrete, reason: 'addressed' }], trace: [`person: addressed by the intent model -> ${concrete}`] };
    const fallback = this.fallbackSpeaker(scene, at, result.wants === 'answer' ? other : null) ?? { avatarId: scene.hostId, reason: 'host' as const };
    return { speakers: [{ avatarId: fallback.avatarId, reason: fallback.reason }], trace: [`person: the intent model named no one -> ${fallback.avatarId} (${fallback.reason})`] };
  }

  private namedIn(text: string, candidates: string[]): string[] {
    return namedIn(text, candidates, this.options.nameOf);
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
    this.personSeq += 1;
    this.pendingIntent?.abort();
    this.pendingIntent = null;
    return cancel;
  }
}
