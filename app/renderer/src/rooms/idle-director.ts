/**
 * The idle director: when nobody has talked for a while, the avatar in a 3D room does something on
 * its own. It waits for quiet (45 s for the first action, then the restlessness interval from the
 * end of the last one), asks the "Idle thoughts" model what to do, checks the answer against what the
 * room camera can see, and hands the tags to the scene executor. A random picker covers a model that
 * fails, so the avatar never freezes. Talking always wins: any conversation activity throws away
 * what is being decided and starts the wait again.
 *
 * Time, timers, randomness, the model and the executor all come in through `IdleDirectorDeps`, so
 * the whole thing runs in tests with fakes.
 */
import type { IdlePickContext, IdlePickResult, RoomFile } from '../../../main/src/rooms/types.js';
import {
  RESTLESSNESS_MEAN_SECONDS,
  type IdleSettings,
} from '../../../main/src/rooms/idle-settings.js';
import {
  describeIdleTags,
  fallbackIdleTags,
  idleTagsToText,
  idleTargets,
  parseIdleReply,
} from './idle-actions.js';
import { buildIdlePrompt } from './idle-prompt.js';
import {
  createIdlePickerState,
  ECHO_ID,
  pickIdleActor,
  type IdleCandidate,
} from './idle-picker.js';
import { describeAvatarWhere } from './scene-instructions.js';
import type { IdleInput, IdleTag } from './idle-types.js';
import { talkStartActions } from './idle-talk.js';
import type { AvatarState, PlanWorld } from './scene-actions.js';
import type { PlanBuilder } from './scene-executor.js';
import { DEFAULT_ASPECT, visibleObjects } from './room-visibility.js';

/** Quiet time before the first idle action after any conversation activity. */
export const FIRST_ACTION_DELAY_MS = 45_000;
/** Each wait is drawn uniformly from this share of the mean. */
export const INTERVAL_SPREAD = { min: 0.6, max: 1.4 };
/** How often to look again when something else (an action, the conversation) was in the way. */
export const RETRY_MS = 3_000;
const WATCH_MS = 1_000;
/** After the last interrupt, how long to wait before reacting to talking (more may follow). */
export const TALK_SETTLE_MS = 1_500;
export const LOG_SIZE = 8;
export const SUMMARY_WINDOW_MS = 10 * 60_000;

/** The parts of the scene executor the director uses. */
export interface IdleExecutor {
  readonly busy: boolean;
  getState(): AvatarState;
  world(): PlanWorld | null;
  submitPlan(label: string, build: PlanBuilder): void;
  onInterrupt(listener: () => void): () => void;
}

export interface IdlePersona {
  name: string;
  personality: string;
  habits: string;
}

/** An avatar standing in the room (Echo included) that may act on its own. */
export interface IdleAvatar {
  id: string;
  name: string;
  /** Its executor; Echo's is always `IdleDirectorDeps.executor`. */
  executor: IdleExecutor;
  /** Its voice is playing right now. */
  speaking?: boolean;
  /** For avatars other than Echo: what the idle prompt says about them. */
  personality?: string;
  habits?: string;
}

export interface IdleDirectorDeps {
  /** Echo's executor. */
  executor: IdleExecutor;
  /**
   * Every avatar in the room, Echo included. Absent, or with fewer than two, the director works for Echo
   * alone, exactly as it did before there were several.
   */
  avatars?(): readonly IdleAvatar[];
  /**
   * Nobody is in this room (every avatar is in another place), so nobody acts. Absent means somebody is.
   */
  nobodyHere?(): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  random(): number;
  settings(): IdleSettings;
  room(): RoomFile | null;
  /** The local motion service is ready. */
  motionReady(): boolean;
  persona(): IdlePersona;
  /** Asks the Idle thoughts model; null on any failure. */
  pick(context: IdlePickContext): Promise<IdlePickResult | null>;
  /** Runs tags like the assistant's own: `{go:bookshelf}{move:browses the books}`. */
  run(text: string, avatarId?: string): void;
  /**
   * The "just before this, while idle, you…" note for the conversation changed. It only changes while
   * the assistant is not working on a turn.
   */
  onNoteChange?(note: string): void;
}

export interface IdleLogEntry {
  at: number;
  text: string;
}

/** Voice phases in which the assistant is still working on a turn. */
const BUSY_PHASES = new Set(['transcribing', 'thinking', 'responding']);

export class IdleDirector {
  private active = false;
  private roomId: string | null = null;
  private timer: unknown = null;
  private talkTimer: unknown = null;
  private watchTimer: unknown = null;
  /** Bumped by conversation activity and by going inactive; an answer from an older one is dropped. */
  private epoch = 0;
  private picking = false;
  private lastActivity = 0;
  private lastIdleEnd = 0;
  /** An idle action has finished since the last conversation activity. */
  private chain = false;
  private nextInterval = 0;
  /** An idle action started since the user last talked, so the avatar may be somewhere else now. */
  private wandered = false;
  private recentTargets: string[] = [];
  /** Log and recent targets of the avatars other than Echo (Echo's are above; the note is hers alone). */
  private readonly otherTracks = new Map<string, { log: IdleLogEntry[]; targets: string[] }>();
  private readonly pickerState = createIdlePickerState();
  private readonly lastActed = new Map<string, number>();
  /** Avatars that did something idle since the user last talked. */
  private readonly wanderers = new Set<string>();
  private readonly log: IdleLogEntry[] = [];
  private conversationBusy = false;
  private publishedNote = '';
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: IdleDirectorDeps) {}

  /** Begin listening for interrupts and decide whether to be active. */
  start(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.deps.executor.onInterrupt(() => this.noteActivity());
    this.update();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deactivate();
  }

  /** The room, the settings, the motion service or the character may have changed. */
  update(): void {
    const room = this.deps.room();
    const shouldBeActive = Boolean(room) && this.deps.motionReady() && this.deps.settings().enabled;
    const roomId = room?.id ?? null;
    if (roomId !== this.roomId) {
      this.roomId = roomId;
      this.log.length = 0;
      this.recentTargets = [];
      this.otherTracks.clear();
      this.lastActed.clear();
      this.wanderers.clear();
      this.wandered = false;
      if (this.active) this.deactivate();
    }
    if (shouldBeActive && !this.active) this.activate();
    else if (!shouldBeActive && this.active) this.deactivate();
    else if (this.active) this.schedule();
    this.publishNote();
  }

  /** The voice pipeline's phase; the assistant working on a turn is conversation activity. */
  setConversationPhase(phase: string): void {
    const busy = BUSY_PHASES.has(phase);
    const was = this.conversationBusy;
    this.conversationBusy = busy;
    if (busy || was) this.touch();
    this.publishNote();
  }

  /** The user spoke, woke the avatar or tapped: forget what was being decided and start the wait again. */
  noteActivity(): void {
    this.touch();
    this.clearTimer('talkTimer');
    if (!this.wandered || !this.active) return;
    // More interrupts usually follow within a moment (wake word, then speech); react to the last one.
    this.talkTimer = this.deps.setTimer(() => {
      this.talkTimer = null;
      this.reactToTalking();
    }, TALK_SETTLE_MS);
  }

  /** What the avatar did on its own in the last ten minutes, for the conversation; empty when nothing. */
  recentSummary(): string {
    if (!this.deps.room()) return '';
    const cutoff = this.deps.now() - SUMMARY_WINDOW_MS;
    const lines = this.log.filter((entry) => entry.at >= cutoff).map((entry) => entry.text);
    return lines.length > 0 ? lines.join('; ') : '';
  }

  /** Passes the summary on to the conversation when it changed and the assistant is not mid-response. */
  private publishNote(): void {
    if (this.conversationBusy) return;
    const next = this.recentSummary();
    if (next === this.publishedNote) return;
    this.publishedNote = next;
    this.deps.onNoteChange?.(next);
  }

  /** The last idle actions with their time, oldest first (at most 8). */
  recent(): readonly IdleLogEntry[] {
    return this.log;
  }

  get isActive(): boolean {
    return this.active;
  }

  // -- Timing ----------------------------------------------------------------------------------

  private activate(): void {
    this.active = true;
    this.touch();
  }

  private deactivate(): void {
    this.active = false;
    this.epoch += 1;
    this.chain = false;
    this.picking = false;
    this.clearTimer('timer');
    this.clearTimer('talkTimer');
    this.clearTimer('watchTimer');
  }

  /** Conversation activity: back to the 45 s rule. */
  private touch(): void {
    this.epoch += 1;
    this.picking = false;
    this.lastActivity = this.deps.now();
    this.chain = false;
    this.clearTimer('watchTimer');
    if (this.active) this.schedule();
  }

  private clearTimer(which: 'timer' | 'talkTimer' | 'watchTimer'): void {
    const handle = this[which];
    if (handle !== null) this.deps.clearTimer(handle);
    this[which] = null;
  }

  private dueAt(): number {
    return this.chain
      ? this.lastIdleEnd + this.nextInterval
      : this.lastActivity + FIRST_ACTION_DELAY_MS;
  }

  private drawInterval(): number {
    const mean = RESTLESSNESS_MEAN_SECONDS[this.deps.settings().restlessness] * 1000;
    const { min, max } = INTERVAL_SPREAD;
    return mean * (min + this.deps.random() * (max - min));
  }

  private schedule(): void {
    this.clearTimer('timer');
    if (!this.active || this.picking || this.watchTimer !== null) return;
    const wait = Math.max(0, this.dueAt() - this.deps.now());
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.tick();
    }, wait);
  }

  private tick(): void {
    if (!this.active || this.picking) return;
    if (this.conversationBusy) {
      this.touch();
      return;
    }
    if (this.deps.now() < this.dueAt()) {
      this.schedule();
      return;
    }
    const actor = this.pickActor();
    if (!actor) {
      this.timer = this.deps.setTimer(() => {
        this.timer = null;
        this.tick();
      }, RETRY_MS);
      return;
    }
    void this.act(actor);
  }

  /**
   * The avatars in the room; just Echo when the app does not say or says there is only one (and that one is
   * Echo). A lone avatar other than Echo (Echo is in another place) still counts as a roster of its own.
   */
  private roster(): readonly IdleAvatar[] {
    const avatars = this.deps.avatars?.() ?? [];
    return avatars.length >= 2 || (avatars.length === 1 && avatars[0]?.id !== ECHO_ID) ? avatars : [];
  }

  /** Who acts now: Echo alone as before, else the picker's choice. Null when nobody can act yet. */
  private pickActor(): IdleAvatar | null {
    if (this.deps.nobodyHere?.()) return null;
    const roster = this.roster();
    if (roster.length === 0) {
      return this.deps.executor.busy
        ? null
        : { id: ECHO_ID, name: '', executor: this.deps.executor };
    }
    const candidates: IdleCandidate[] = roster.map((avatar) => ({
      id: avatar.id,
      busy: this.executorOf(avatar).busy,
      speaking: Boolean(avatar.speaking),
      lastActedAt: this.lastActed.get(avatar.id),
    }));
    const id = pickIdleActor(candidates, this.deps.now(), this.pickerState);
    return roster.find((avatar) => avatar.id === id) ?? null;
  }

  private executorOf(avatar: IdleAvatar): IdleExecutor {
    return avatar.id === ECHO_ID ? this.deps.executor : avatar.executor;
  }

  // -- Choosing and doing ----------------------------------------------------------------------

  private input(actor: IdleAvatar): IdleInput | null {
    const room = this.deps.room();
    const executor = this.executorOf(actor);
    const world = executor.world();
    if (!room || !world) return null;
    const isEcho = actor.id === ECHO_ID;
    const persona = isEcho
      ? this.deps.persona()
      : { name: actor.name, personality: actor.personality ?? '', habits: actor.habits ?? '' };
    const log = isEcho ? this.log : (this.otherTracks.get(actor.id)?.log ?? []);
    const others = this.roster()
      .filter((avatar) => avatar.id !== actor.id)
      .map((avatar) => {
        const other = this.executorOf(avatar);
        const otherWorld = other.world();
        const where = describeAvatarWhere(room, {
          seatedOn: other.getState().seat?.objectId ?? null,
          position: otherWorld
            ? { x: otherWorld.frame.origin.x, z: otherWorld.frame.origin.z }
            : null,
        });
        return { name: avatar.name, where };
      });
    return {
      ...persona,
      room,
      visible: visibleObjects(room, world.cameraAspect ?? DEFAULT_ASPECT),
      state: executor.getState(),
      position: [world.frame.origin.x, 0, world.frame.origin.z],
      recent: log.map((entry) => entry.text),
      now: new Date(this.deps.now()),
      ...(others.length > 0 ? { others } : {}),
    };
  }

  private async act(actor: IdleAvatar): Promise<void> {
    const isEcho = actor.id === ECHO_ID;
    const input = this.input(actor);
    if (!input) {
      this.timer = this.deps.setTimer(() => {
        this.timer = null;
        this.tick();
      }, RETRY_MS);
      return;
    }
    const epoch = this.epoch;
    this.picking = true;
    let reply: IdlePickResult | null = null;
    try {
      reply = await this.deps.pick(buildIdlePrompt(input));
    } catch (error) {
      console.warn('[idle] the idle thoughts request failed', error);
    }
    if (epoch !== this.epoch || !this.active) return; // talking started meanwhile
    this.picking = false;

    // The scene may have moved on while the model thought; judge the answer against it now.
    const now = this.input(actor) ?? input;
    const targets = isEcho ? this.recentTargets : (this.otherTracks.get(actor.id)?.targets ?? []);
    let tags: IdleTag[] = reply ? parseIdleReply(reply.text, now) : [];
    if (tags.length === 0) tags = fallbackIdleTags(now, () => this.deps.random(), targets);
    const first = tags[0];
    if (!first || first.type === 'wait') {
      this.finish();
      return;
    }
    this.record(tags, now.room, actor.id);
    this.wandered = true;
    this.wanderers.add(actor.id);
    this.lastActed.set(actor.id, this.deps.now());
    // Only the action tags run (the reply is parsed into tags); spoken remarks are Echo's alone.
    if (isEcho) this.deps.run(idleTagsToText(tags));
    else this.deps.run(idleTagsToText(tags), actor.id);
    this.watch(actor);
  }

  private record(tags: readonly IdleTag[], room: RoomFile, actorId: string): void {
    const text = describeIdleTags(tags, room);
    if (actorId !== ECHO_ID) {
      // Others' actions never reach Echo's conversation note.
      let track = this.otherTracks.get(actorId);
      if (!track) {
        track = { log: [], targets: [] };
        this.otherTracks.set(actorId, track);
      }
      if (text) {
        track.log.push({ at: this.deps.now(), text });
        while (track.log.length > LOG_SIZE) track.log.shift();
      }
      track.targets = [...track.targets, ...idleTargets(tags)].slice(-4);
      return;
    }
    if (text) {
      this.log.push({ at: this.deps.now(), text });
      while (this.log.length > LOG_SIZE) this.log.shift();
      this.publishNote();
    }
    this.recentTargets = [...this.recentTargets, ...idleTargets(tags)].slice(-4);
  }

  /** Waits for the executor to finish what was handed to it, then starts the next wait. */
  private watch(actor: IdleAvatar): void {
    this.clearTimer('watchTimer');
    const epoch = this.epoch;
    this.watchTimer = this.deps.setTimer(() => {
      this.watchTimer = null;
      if (epoch !== this.epoch || !this.active) return;
      if (this.executorOf(actor).busy) this.watch(actor);
      else this.finish();
    }, WATCH_MS);
  }

  /** An idle action (or a decision to wait) is over: the next one comes after the restlessness interval. */
  private finish(): void {
    this.lastIdleEnd = this.deps.now();
    this.nextInterval = this.drawInterval();
    this.chain = true;
    this.schedule();
  }

  // -- Talking starts --------------------------------------------------------------------------

  private reactToTalking(): void {
    if (!this.wandered || !this.active) return;
    this.wandered = false;
    const mode = this.deps.settings().onTalk;
    const roster = this.roster();
    const wanderers = [...this.wanderers];
    this.wanderers.clear();
    // Echo as before; any other avatar that wandered off turns to the user too.
    this.deps.executor.submitPlan('turn to the user', (world, state) =>
      talkStartActions(mode, world, state),
    );
    for (const id of wanderers) {
      const avatar = roster.find((entry) => entry.id === id);
      if (!avatar || id === ECHO_ID) continue;
      avatar.executor.submitPlan('turn to the user', (world, state) =>
        talkStartActions(mode, world, state),
      );
    }
  }
}

/** What the app keeps current for a director that runs on real time. */
export interface IdleDirectorInputs {
  room: RoomFile | null;
  settings: IdleSettings;
  motionReady: boolean;
  persona: IdlePersona;
  pick(context: IdlePickContext): Promise<IdlePickResult | null>;
  run(text: string, avatarId?: string): void;
  /** The avatars in the room, Echo included; fewer than two means Echo alone (unless the one is not Echo). */
  avatars?(): readonly IdleAvatar[];
  /** Every avatar is in another place. */
  nobodyHere?(): boolean;
}

const NO_INPUTS: IdleDirectorInputs = {
  room: null,
  settings: { enabled: false, restlessness: 'normal', onTalk: 'turn', avatarHeight: 1.6 },
  motionReady: false,
  persona: { name: '', personality: '', habits: '' },
  pick: async () => null,
  run: () => undefined,
};

/**
 * A director on the real clock. The app calls `setInputs` whenever the room, the settings or the
 * persona change; the director reads the latest whenever it needs them.
 */
export function createIdleDirector(
  executor: IdleExecutor,
  onNoteChange?: (note: string) => void,
): { director: IdleDirector; setInputs(inputs: IdleDirectorInputs): void } {
  let latest = NO_INPUTS;
  const director = new IdleDirector({
    executor,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    random: () => Math.random(),
    settings: () => latest.settings,
    room: () => latest.room,
    motionReady: () => latest.motionReady,
    persona: () => latest.persona,
    pick: (context) => latest.pick(context),
    avatars: () => latest.avatars?.() ?? [],
    nobodyHere: () => latest.nobodyHere?.() === true,
    run: (text, avatarId) => (avatarId ? latest.run(text, avatarId) : latest.run(text)),
    onNoteChange,
  });
  return {
    director,
    setInputs: (inputs) => {
      latest = inputs;
    },
  };
}
