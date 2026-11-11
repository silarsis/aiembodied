/**
 * The floor manager decides who speaks in a scene. It is pure: no Electron, no I/O, time comes in
 * with each utterance (`at`, from the caller's injected clock) and bids from an injected function.
 *
 * Rules first, then bids. Kevin (the person) always wins: his speech cancels avatar speech and
 * clears the queue (`bargeIn`). For Kevin's words: avatars he names (or "you two", "everyone"),
 * else the avatar he last talked with if that was recent, else the host. For an avatar's words
 * (chatter): only the other avatars of the scene may answer; the one addressed by name, else the
 * one that bids highest above the threshold, else nobody. Chatter is capped by turns and time
 * since Kevin last spoke. One avatar speaks at a time: a speaking slot and a FIFO queue.
 */

export const PARTNER_WINDOW_MS = 5 * 60_000;
export const BID_THRESHOLD = 0.5;
export const CHATTER_MAX_TURNS = 4;
export const CHATTER_MAX_MS = 60_000;
/** A chat Kevin asked for ("talk to each other") runs longer than ordinary chatter. */
export const TALK_MAX_TURNS = 8;
export const TALK_MAX_MS = 180_000;
export const BID_TIMEOUT_MS = 6_000;
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
}

export interface FloorDecision {
  /** Ordered: the first speaks now, the others are queued. */
  speakers: Array<{ avatarId: string; reason: SpeakerReason }>;
  channel: FloorChannel;
  /** What ran, in order, for the journal. */
  trace: string[];
  /** Set when chatter was cut off by a budget. */
  budget?: { kind: 'turns' | 'time'; turns: number; ms: number };
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

export interface FloorManagerOptions {
  /** The scene in use. Default: every avatar in `avatarIds()`, the first one hosting. */
  scene?: () => Scene;
  /** All avatar ids in order, used for the default scene. */
  avatarIds?: () => string[];
  /** The spoken name of an avatar (AvatarProfile.name). */
  nameOf: (avatarId: string) => string;
  bid?: BidFunction;
  /** True when avatar-to-avatar talk should be out loud. */
  hearChatter?: () => boolean;
  partnerWindowMs?: number;
  bidThreshold?: number;
  chatterMaxTurns?: number;
  chatterMaxMs?: number;
  bidTimeoutMs?: number;
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

export class FloorManager {
  private readonly options: FloorManagerOptions;
  private readonly partnerWindowMs: number;
  private readonly bidThreshold: number;
  private readonly chatterMaxTurns: number;
  private readonly chatterMaxMs: number;
  private readonly bidTimeoutMs: number;

  private partner: { avatarId: string; at: number } | null = null;
  private chatterTurns = 0;
  private chatterStartedAt: number | null = null;
  private speaking: string | null = null;
  private queue: string[] = [];
  private recent: FloorLine[] = [];
  /** Set while a chat Kevin asked for runs: avatar lines go to the next avatar, out loud, within the longer budget. */
  private talking = false;

  constructor(options: FloorManagerOptions) {
    this.options = options;
    this.partnerWindowMs = options.partnerWindowMs ?? PARTNER_WINDOW_MS;
    this.bidThreshold = options.bidThreshold ?? BID_THRESHOLD;
    this.chatterMaxTurns = options.chatterMaxTurns ?? CHATTER_MAX_TURNS;
    this.chatterMaxMs = options.chatterMaxMs ?? CHATTER_MAX_MS;
    this.bidTimeoutMs = options.bidTimeoutMs ?? BID_TIMEOUT_MS;
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
  state(): { speaking: string | null; queue: string[]; chatterTurns: number; partner: string | null } {
    return { speaking: this.speaking, queue: [...this.queue], chatterTurns: this.chatterTurns, partner: this.partner?.avatarId ?? null };
  }

  async route(utterance: FloorUtterance): Promise<FloorDecision> {
    this.remember(utterance);
    return utterance.from === PERSON_SPEAKER ? this.routePerson(utterance) : this.routeAvatar(utterance);
  }

  private remember(utterance: FloorUtterance): void {
    this.recent.push({ from: utterance.from, text: utterance.text });
    if (this.recent.length > RECENT_LINES_LIMIT) this.recent = this.recent.slice(-RECENT_LINES_LIMIT);
  }

  private routePerson(utterance: FloorUtterance): FloorDecision {
    const scene = this.scene();
    const trace: string[] = [];
    // Kevin spoke: the chatter budget starts over.
    this.chatterTurns = 0;
    this.chatterStartedAt = null;
    this.talking = false;
    const done = (speakers: FloorDecision['speakers']): FloorDecision => {
      if (speakers[0]) this.partner = { avatarId: speakers[0].avatarId, at: utterance.at };
      return { speakers, channel: 'aloud', trace };
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
    if (TALK_PATTERN.test(utterance.text)) {
      this.talking = true;
      const first = named[0] ?? (this.partner && scene.avatarIds.includes(this.partner.avatarId) ? this.partner.avatarId : scene.hostId);
      trace.push(`person: asked them to talk to each other -> ${first} starts, out loud`);
      return done([{ avatarId: first, reason: named.length > 0 ? 'addressed' : 'host' }]);
    }
    if (GROUP_PATTERN.test(utterance.text)) {
      trace.push('person: addressed everyone -> all avatars in scene order');
      return done(scene.avatarIds.map((avatarId) => ({ avatarId, reason: 'all' as const })));
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
    const channel: FloorChannel = this.talking || this.options.hearChatter?.() ? 'aloud' : 'back';
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
    // Budgets: turns and time since Kevin last spoke.
    const maxTurns = this.talking ? TALK_MAX_TURNS : this.chatterMaxTurns;
    const maxMs = this.talking ? TALK_MAX_MS : this.chatterMaxMs;
    const elapsed = this.chatterStartedAt === null ? 0 : utterance.at - this.chatterStartedAt;
    if (this.chatterTurns >= maxTurns) {
      trace.push(`avatar: chatter budget used up (${this.chatterTurns} turns)`);
      return none({ budget: { kind: 'turns', turns: this.chatterTurns, ms: elapsed } });
    }
    if (this.chatterStartedAt !== null && elapsed >= maxMs) {
      trace.push(`avatar: chatter budget used up (${Math.round(elapsed / 1000)} s)`);
      return none({ budget: { kind: 'time', turns: this.chatterTurns, ms: elapsed } });
    }
    const take = (avatarId: string, reason: SpeakerReason): FloorDecision => {
      this.chatterTurns += 1;
      this.chatterStartedAt ??= utterance.at;
      return { speakers: [{ avatarId, reason }], channel, trace };
    };
    const named = this.namedIn(utterance.text, others);
    if (named.length > 0) {
      trace.push(`avatar: ${senderId} addressed ${named[0]} by name`);
      return take(named[0], 'addressed');
    }
    if (this.talking) {
      // Kevin asked them to talk: the next avatar in scene order answers, no bidding.
      const order = scene.avatarIds;
      const next = order[(order.indexOf(senderId) + 1) % order.length];
      trace.push(`avatar: chat Kevin asked for -> ${next} answers`);
      return take(next, 'addressed');
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

  /** Kevin speaks: clear the queue, free the slot, reset the chatter budget. Returns the avatars to cancel. */
  bargeIn(): string[] {
    const cancel = this.speaking === null ? [] : [this.speaking];
    this.speaking = null;
    this.queue = [];
    this.chatterTurns = 0;
    this.chatterStartedAt = null;
    this.talking = false;
    return cancel;
  }
}
