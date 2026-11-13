/**
 * Wires the floor manager into the app: who answers Kevin when several avatars share a scene,
 * the back channel between avatars (and the chats Kevin asks them to have), the "Hear avatar chatter" setting, and the journal on the
 * switchboard bus (`floor.decision`, `floor.grant`, `floor.release`, `floor.budget`).
 *
 * With one avatar in the scene none of this runs (`isMulti()` is false) and the app behaves as
 * it did before.
 *
 * Out-loud chatter: the turn runs normally (speech is synthesised and events carry `avatarId`),
 * but the renderer plays only the request it asked for, so it is NOT audible until the renderer
 * plays several voices (phase 3 step 3). The path and the setting are in place for that.
 */
import type { AvatarRegistry } from '../avatars/avatar-registry.js';
import { stripAvatarTags } from '../local-voice/avatar-tags.js';
import type { LocalVoiceEvent, LocalVoiceRespondRequest, LocalVoiceRespondResult } from '../local-voice/types.js';
import type { SwitchboardBus } from '../switchboard/bus.js';
import type { SwitchboardEventInput } from '../switchboard/types.js';
import {
  FloorManager,
  PERSON_SPEAKER,
  type AddresseeFunction,
  type BidFunction,
  type FloorChannel,
  type FloorDecision,
  type FloorSpeaker,
  type IntentFunction,
  type QuickIntentFunction,
} from './floor-manager.js';

export const HEAR_CHATTER_KEY = 'floor.hearChatter';
const TEXT_LIMIT = 300;

export interface FloorStore {
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
}

/** The part of LocalVoiceService the floor uses. */
export interface FloorVoice {
  respond(request: LocalVoiceRespondRequest, emit: (event: LocalVoiceEvent) => void): Promise<LocalVoiceRespondResult>;
  cancel(requestId?: string): void;
  /** Remember a line said in the room; no model call. */
  overhear?(line: { from: string; text: string }): void;
}

export interface FloorControllerOptions {
  registry: Pick<AvatarRegistry, 'list' | 'get'>;
  store: FloorStore;
  voice: (avatarId: string) => FloorVoice | null;
  /** Runs one of Kevin's turns for an avatar (mirror, presence and renderer events included). */
  runPersonTurn: (avatarId: string, payload: LocalVoiceRespondRequest) => Promise<LocalVoiceRespondResult>;
  /** Sends a voice event of an out-loud chatter turn on to the renderer. */
  emitChatter?: (avatarId: string, event: LocalVoiceEvent) => void;
  /** Saves a line in the conversation (role assistant). */
  saveLine: (line: { speaker: string; content: string; ts: number }) => void;
  /** The system prompt for an avatar's chatter turn. */
  instructionsFor?: (avatarId: string) => string | undefined;
  bus?: () => SwitchboardBus | null;
  bid?: BidFunction;
  /** A quick check of who a line is aimed at. */
  addressee?: AddresseeFunction;
  /** Reads the chat-model fallback for Kevin's lines. */
  /** Reads Kevin's lines first (the fine-tuned quick model). */
  quickIntent?: QuickIntentFunction;
  intent?: IntentFunction;
  now?: () => number;
  logger?: Pick<Console, 'warn' | 'debug'>;
}

/** What the avatar that just finished had been given, so the room can overhear it. */
type Input = { kind: 'person'; text: string; participants: string[]; relay?: undefined } | { kind: 'chatter'; from: string; text: string; relay?: boolean };

type Job =
  | { kind: 'kevin'; requestId: string; payload: LocalVoiceRespondRequest; txn: string; participants: string[] }
  | { kind: 'chatter'; from: string; text: string; channel: FloorChannel; txn: string; relay?: boolean; talk?: boolean };

/**
 * The note another avatar's line reaches the receiving avatar as: who said it and to whom, and what to do
 * with it. It is the receiver's whole input for the turn, so it must say plainly that the line is not the
 * receiver's own and should be answered, not repeated. `talk` is a conversation Kevin asked for.
 */
export function chatterNote(fromName: string, text: string, options: { talk?: boolean } = {}): string {
  const line = `${fromName} says to you, not Kevin: "${stripAvatarTags(text).replace(/\s+/g, ' ').trim()}"`;
  const task = options.talk
    ? `You are in a conversation with ${fromName} that Kevin asked for. Reply to ${fromName} in your own words in one or two sentences, do not repeat what was said, and keep the conversation moving.`
    : 'Answer in your own words; do not repeat what was said.';
  return `[${line} ${task}]`;
}

/** Added to Kevin's words for the avatar he asked to start a conversation with another avatar. */
export function converseNote(name: string): string {
  return `[Kevin wants you to have a conversation with ${name}. Speak to ${name} directly now, in a sentence or two, and keep it going; ${name} will answer out loud.]`;
}

/** Added to Kevin's words for the avatar he asked to pass a question on. */
export function relayNote(name: string): string {
  return `[${name} is here in the room and hears you. Say it to ${name} directly, using the name ${name}; ${name} will answer out loud.]`;
}

/** The note the avatar that was asked gets: Kevin wanted this passed on, so it answers out loud. */
export function relayChatterNote(fromName: string, text: string): string {
  return `[${fromName} is asking you this for Kevin: "${stripAvatarTags(text).replace(/\s+/g, ' ').trim()}". Answer out loud; Kevin and ${fromName} both hear you.]`;
}

const clip = (text: string): string => (text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT)}…`);

export class FloorController {
  readonly manager: FloorManager;
  private readonly options: FloorControllerOptions;
  private readonly now: () => number;
  private readonly jobs = new Map<string, Job>();
  /** Bumped when Kevin speaks; work from an older epoch stops quietly. */
  private epoch = 0;
  private serial = 0;

  constructor(options: FloorControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.manager = new FloorManager({
      avatarIds: () => options.registry.list().map((profile) => profile.id),
      nameOf: (avatarId) => options.registry.get(avatarId)?.name ?? avatarId,
      bid: options.bid,
      addressee: options.addressee,
      quickIntent: options.quickIntent,
      intent: options.intent,
      hearChatter: () => this.hearChatter(),
    });
  }

  hearChatter(): boolean {
    try {
      return this.options.store.getValue(HEAR_CHATTER_KEY) === '1';
    } catch {
      return false;
    }
  }

  setHearChatter(enabled: boolean): boolean {
    this.options.store.setValue(HEAR_CHATTER_KEY, enabled ? '1' : '0');
    return this.hearChatter();
  }

  /** The wake word was heard: the host listens next, whoever Kevin spoke with before. */
  wakeWordHeard(): void {
    this.manager.listenTo(this.manager.scene().hostId, this.now());
  }

  isMulti(): boolean {
    return this.manager.isMulti();
  }

  /**
   * Kevin spoke without naming an avatar: stop whatever is being said, decide who answers, run
   * the first answerer now and queue the rest. Resolves with the first answerer's result.
   */
  async respondToPerson(payload: LocalVoiceRespondRequest): Promise<LocalVoiceRespondResult> {
    const epoch = this.interrupt();
    const txn = `turn:${payload.requestId}`;
    const decision = await this.manager.route({ from: PERSON_SPEAKER, text: payload.text, at: this.now() });
    if (epoch !== this.epoch) return { requestId: payload.requestId, text: '', cancelled: true };
    this.journalDecision(PERSON_SPEAKER, payload.text, decision, { id: txn });
    const [first, ...rest] = decision.speakers;
    if (!first) return { requestId: payload.requestId, text: '', cancelled: true };
    this.grant(first.avatarId, first.reason, { id: txn });
    const participants = decision.speakers.map((speaker) => speaker.avatarId);
    const input: Input = { kind: 'person', text: payload.text, participants };
    for (const speaker of rest) {
      if (this.manager.request(speaker.avatarId) === 'queued') {
        this.jobs.set(speaker.avatarId, { kind: 'kevin', requestId: `${payload.requestId}:${speaker.avatarId}`, payload, txn, participants });
      }
    }
    let result: LocalVoiceRespondResult;
    try {
      const nameOf = (id: string) => this.options.registry.get(id)?.name ?? id;
      const note =
        decision.relay && decision.relay.from === first.avatarId
          ? relayNote(nameOf(decision.relay.to))
          : decision.converse && decision.converse.starter === first.avatarId
            ? converseNote(nameOf(decision.converse.target))
            : null;
      const text = note ? `${payload.text}\n\n${note}` : payload.text;
      result = await this.options.runPersonTurn(first.avatarId, { ...payload, text, avatarId: first.avatarId });
    } catch (error) {
      this.continueFrom(first.avatarId, { requestId: payload.requestId, text: '', cancelled: true }, epoch, txn, input);
      throw error;
    }
    this.continueFrom(first.avatarId, result, epoch, txn, input);
    return result;
  }

  /** Kevin's speech wins: cancel what avatars are saying and drop what waits. */
  interrupt(): number {
    this.epoch += 1;
    this.jobs.clear();
    for (const avatarId of this.manager.bargeIn()) {
      try {
        this.options.voice(avatarId)?.cancel();
      } catch (error) {
        this.options.logger?.warn('Floor: cancelling an avatar failed', { avatarId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return this.epoch;
  }

  private continueFrom(avatarId: string, result: LocalVoiceRespondResult, epoch: number, txn: string, input: Input): void {
    void this.advance(avatarId, result, epoch, txn, input).catch((error) => {
      this.options.logger?.warn('Floor: continuing after a turn failed', { message: error instanceof Error ? error.message : String(error) });
    });
  }

  /** After `avatarId` finished: route its words to the other avatars, free the slot, run whoever is next. */
  private async advance(avatarId: string, result: LocalVoiceRespondResult, epoch: number, txn: string, input: Input): Promise<void> {
    let current: { avatarId: string; result: LocalVoiceRespondResult; txn: string; input: Input } = { avatarId, result, txn, input };
    while (epoch === this.epoch) {
      // Action tags ({move:...}) are for the body: other avatars never see them.
      const said = stripAvatarTags(current.result.text).replace(/\s+/g, ' ').trim();
      if (said && !current.result.cancelled) {
        // An avatar's answer to Kevin does not open chatter by itself; its other lines may. In a chat Kevin asked for, the manager overrides that.
        const next = await this.queueChatter(current.avatarId, said, epoch, current.input.kind === 'person' || current.input.relay === true);
        if (epoch !== this.epoch) return;
        this.shareWithRoom(current.avatarId, said, current.input, next);
      }
      const next = this.manager.release(current.avatarId);
      this.journal('floor.release', current.avatarId, { avatar: current.avatarId, next }, current.txn, current.txn.startsWith('turn:') ? undefined : 'done');
      if (!next) return;
      const job = this.jobs.get(next);
      this.jobs.delete(next);
      if (!job) {
        // Nothing to run for this avatar (it was dropped); hand the slot on.
        current = { avatarId: next, result: { requestId: '', text: '', cancelled: true }, txn: current.txn, input: current.input };
        continue;
      }
      this.journal('floor.grant', next, { avatar: next, reason: job.kind === 'kevin' ? 'queued' : 'bid' }, job.txn);
      let outcome: LocalVoiceRespondResult;
      try {
        outcome = await this.execute(next, job);
      } catch (error) {
        this.options.logger?.warn('Floor: a queued turn failed', { avatarId: next, message: error instanceof Error ? error.message : String(error) });
        outcome = { requestId: '', text: '', cancelled: true };
      }
      // A chatter turn's reply is saved in execute(); a turn answering Kevin is saved by the renderer.
      current = {
        avatarId: next,
        result: outcome,
        txn: job.txn,
        input: job.kind === 'kevin' ? { kind: 'person', text: job.payload.text, participants: job.participants } : { kind: 'chatter', from: job.from, text: job.text, ...(job.relay ? { relay: true } : {}) },
      };
    }
  }

  /** Returns the avatar queued to answer, if any. */
  private async queueChatter(fromId: string, text: string, epoch: number, toPerson: boolean): Promise<string | null> {
    const decision = await this.manager.route({ from: `avatar:${fromId}`, text, at: this.now(), ...(toPerson ? { toPerson: true } : {}) });
    if (epoch !== this.epoch) return null;
    const txn = `chatter:${this.now()}:${++this.serial}`;
    this.journalDecision(`avatar:${fromId}`, text, decision, { id: txn, title: clip(text) });
    if (decision.budget) {
      this.journal('floor.budget', fromId, { kind: decision.budget.kind, ms: decision.budget.ms }, txn, 'done');
    }
    const speaker = decision.speakers[0];
    if (!speaker) return null;
    const status = this.manager.request(speaker.avatarId);
    if (status === 'queued') {
      this.jobs.set(speaker.avatarId, { kind: 'chatter', from: fromId, text, channel: decision.channel, txn, ...(decision.relay ? { relay: true } : {}), ...(decision.talk ? { talk: true } : {}) });
      return speaker.avatarId;
    }
    if (status === 'granted') {
      // The sender still holds the slot, so this cannot happen; do not strand a slot if it does.
      this.manager.release(speaker.avatarId);
    }
    return null;
  }

  /** After `avatarId` answered `input`: let the avatars that did not get these lines as their own input overhear them. */
  private shareWithRoom(avatarId: string, reply: string, input: Input, next: string | null): void {
    if (input.kind === 'person') {
      this.heard('person', input.text, avatarId, input.participants);
    } else {
      this.heard(input.from, input.text, avatarId, [input.from]);
    }
    this.heard(avatarId, reply, undefined, next ? [next] : []);
  }

  /**
   * A line said in the room: every other avatar in the scene overhears it (a buffered note, no model
   * call). `addressedTo` is named in the line and skipped as a listener (it got the line as its own
   * input); so are the speaker and anyone in `exclude`.
   */
  heard(speakerId: string | 'person', text: string, addressedTo?: string, exclude: string[] = []): void {
    const clean = stripAvatarTags(text).replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const nameOf = (id: string) => this.options.registry.get(id)?.name ?? id;
    const from = speakerId === 'person' ? 'Kevin' : nameOf(speakerId);
    const label = addressedTo ? `${from} (to ${nameOf(addressedTo)})` : from;
    const skip = new Set([speakerId, ...(addressedTo ? [addressedTo] : []), ...exclude]);
    for (const id of this.manager.scene().avatarIds) {
      if (skip.has(id)) continue;
      try {
        this.options.voice(id)?.overhear?.({ from: label, text: clean });
      } catch (error) {
        this.options.logger?.warn('Floor: an avatar could not overhear', { avatarId: id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async execute(avatarId: string, job: Job): Promise<LocalVoiceRespondResult> {
    if (job.kind === 'kevin') {
      return this.options.runPersonTurn(avatarId, { ...job.payload, requestId: job.requestId, avatarId });
    }
    const voice = this.options.voice(avatarId);
    if (!voice) return { requestId: '', text: '', cancelled: true };
    const aloud = job.channel === 'aloud';
    const requestId = `chatter-${++this.serial}-${avatarId}`;
    const fromName = this.options.registry.get(job.from)?.name ?? job.from;
    const result = await voice.respond(
      {
        requestId,
        avatarId,
        text: job.relay ? relayChatterNote(fromName, job.text) : chatterNote(fromName, job.text, { talk: job.talk }),
        instructions: this.options.instructionsFor?.(avatarId),
        silent: !aloud,
        noTools: true,
      },
      (event) => {
        if (aloud) this.options.emitChatter?.(avatarId, { ...event, avatarId });
      },
    );
    if (result.text.trim() && !result.cancelled) {
      this.options.saveLine({ speaker: avatarId, content: result.text.trim(), ts: this.now() });
    }
    return result;
  }

  private grant(avatarId: string, reason: string, txn: { id: string }): void {
    this.manager.request(avatarId);
    this.journal('floor.grant', avatarId, { avatar: avatarId, reason }, txn.id);
  }

  private journalDecision(from: FloorSpeaker | string, text: string, decision: FloorDecision, txn: { id: string; title?: string }): void {
    this.journal(
      'floor.decision',
      from.startsWith('avatar:') ? from.slice('avatar:'.length) : null,
      { from, text: clip(text), speakers: decision.speakers, channel: decision.channel, trace: decision.trace, ...(decision.decidedBy ? { decidedBy: decision.decidedBy } : {}), ...(decision.relay ? { relay: decision.relay } : {}) },
      txn.id,
      undefined,
      txn.title,
    );
  }

  /** Fire-and-forget, private; never throws. `txn` is the incoming event's txn where one exists. */
  private journal(type: string, avatarId: string | null, payload: Record<string, unknown>, txn: string, state?: 'done', title?: string): void {
    try {
      const bus = this.options.bus?.();
      if (!bus) return;
      const event: SwitchboardEventInput = {
        type,
        producer: avatarId ? { kind: 'avatar', id: avatarId } : { kind: 'service', id: 'floor' },
        to: [],
        audience: 'private',
        txn: { id: txn, ...(state ? { state } : {}), ...(title ? { title } : {}) },
        payload,
      };
      bus.publish(event);
    } catch {
      // Journaling must never disturb a turn.
    }
  }
}
