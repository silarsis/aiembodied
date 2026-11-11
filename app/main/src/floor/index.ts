/**
 * Wires the floor manager into the app: who answers Kevin when several avatars share a scene,
 * the back channel between avatars, the "Hear avatar chatter" setting, and the journal on the
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
import type { LocalVoiceEvent, LocalVoiceRespondRequest, LocalVoiceRespondResult } from '../local-voice/types.js';
import type { SwitchboardBus } from '../switchboard/bus.js';
import type { SwitchboardEventInput } from '../switchboard/types.js';
import {
  FloorManager,
  PERSON_SPEAKER,
  type BidFunction,
  type FloorChannel,
  type FloorDecision,
  type FloorSpeaker,
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
  now?: () => number;
  logger?: Pick<Console, 'warn' | 'debug'>;
}

type Job =
  | { kind: 'kevin'; requestId: string; payload: LocalVoiceRespondRequest; txn: string }
  | { kind: 'chatter'; from: string; text: string; channel: FloorChannel; txn: string };

/** The note an avatar's line reaches another avatar as, in the same style as system notes. */
export function chatterNote(fromName: string, text: string): string {
  return `[${fromName} said to you, not Kevin: "${text.replace(/\s+/g, ' ').trim()}"]`;
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
    for (const speaker of rest) {
      if (this.manager.request(speaker.avatarId) === 'queued') {
        this.jobs.set(speaker.avatarId, { kind: 'kevin', requestId: `${payload.requestId}:${speaker.avatarId}`, payload, txn });
      }
    }
    let result: LocalVoiceRespondResult;
    try {
      result = await this.options.runPersonTurn(first.avatarId, { ...payload, avatarId: first.avatarId });
    } catch (error) {
      this.continueFrom(first.avatarId, { requestId: payload.requestId, text: '', cancelled: true }, epoch, txn);
      throw error;
    }
    this.continueFrom(first.avatarId, result, epoch, txn);
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

  private continueFrom(avatarId: string, result: LocalVoiceRespondResult, epoch: number, txn: string): void {
    void this.advance(avatarId, result, epoch, txn).catch((error) => {
      this.options.logger?.warn('Floor: continuing after a turn failed', { message: error instanceof Error ? error.message : String(error) });
    });
  }

  /** After `avatarId` finished: route its words to the other avatars, free the slot, run whoever is next. */
  private async advance(avatarId: string, result: LocalVoiceRespondResult, epoch: number, txn: string): Promise<void> {
    let current = { avatarId, result, txn };
    while (epoch === this.epoch) {
      if (current.result.text.trim() && !current.result.cancelled) {
        await this.queueChatter(current.avatarId, current.result.text, epoch);
        if (epoch !== this.epoch) return;
      }
      const next = this.manager.release(current.avatarId);
      this.journal('floor.release', current.avatarId, { avatar: current.avatarId, next }, current.txn, current.txn.startsWith('turn:') ? undefined : 'done');
      if (!next) return;
      const job = this.jobs.get(next);
      this.jobs.delete(next);
      if (!job) {
        // Nothing to run for this avatar (it was dropped); hand the slot on.
        current = { avatarId: next, result: { requestId: '', text: '', cancelled: true }, txn: current.txn };
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
      current = { avatarId: next, result: outcome, txn: job.txn };
    }
  }

  private async queueChatter(fromId: string, text: string, epoch: number): Promise<void> {
    const decision = await this.manager.route({ from: `avatar:${fromId}`, text, at: this.now() });
    if (epoch !== this.epoch) return;
    const txn = `chatter:${this.now()}:${++this.serial}`;
    this.journalDecision(`avatar:${fromId}`, text, decision, { id: txn, title: clip(text) });
    if (decision.budget) {
      this.journal('floor.budget', fromId, { kind: decision.budget.kind, turns: decision.budget.turns, ms: decision.budget.ms }, txn, 'done');
    }
    const speaker = decision.speakers[0];
    if (!speaker) return;
    const status = this.manager.request(speaker.avatarId);
    if (status === 'queued') {
      this.jobs.set(speaker.avatarId, { kind: 'chatter', from: fromId, text, channel: decision.channel, txn });
    } else if (status === 'granted') {
      // The sender still holds the slot, so this cannot happen; do not strand a slot if it does.
      this.manager.release(speaker.avatarId);
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
        text: chatterNote(fromName, job.text),
        instructions: this.options.instructionsFor?.(avatarId),
        silent: !aloud,
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
      { from, text: clip(text), speakers: decision.speakers, channel: decision.channel, trace: decision.trace },
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
