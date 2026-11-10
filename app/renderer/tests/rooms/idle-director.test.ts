import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_SETTINGS, type IdleSettings } from '../../../main/src/rooms/idle-settings.js';
import type { IdlePickContext, IdlePickResult } from '../../../main/src/rooms/types.js';
import {
  FIRST_ACTION_DELAY_MS,
  IdleDirector,
  LOG_SIZE,
  SUMMARY_WINDOW_MS,
  TALK_SETTLE_MS,
  type IdleDirectorDeps,
  type IdleExecutor,
} from '../../src/rooms/idle-director.js';
import { INITIAL_STATE, type AvatarState, type PlanWorld } from '../../src/rooms/scene-actions.js';
import type { PlanBuilder } from '../../src/rooms/scene-executor.js';
import { builtInRoom } from './fixtures.js';

const reading = builtInRoom('reading-room');
const studio = builtInRoom('studio-flat');

class Clock {
  time = 1_000_000;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private next = 1;
  now = () => this.time;
  setTimer = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.push({ id, at: this.time + ms, fn });
    return id;
  };
  clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };
  get pending() {
    return this.timers.length;
  }
  /** Moves time forward, firing timers in order and letting promises settle after each. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

class FakeExecutor implements IdleExecutor {
  busy = false;
  state: AvatarState = INITIAL_STATE;
  position = { x: 0, z: -0.3, yaw: 0 };
  plans: Array<{ label: string; build: PlanBuilder }> = [];
  private listeners = new Set<() => void>();
  getState() {
    return this.state;
  }
  world(): PlanWorld {
    return {
      room: reading,
      hasNavigation: true,
      findPath: () => null,
      closestWalkable: (p) => p,
      objectPosition: () => null,
      frame: { origin: { ...this.position }, scale: 1 },
      restHipsHeight: 0.95,
      cameraAspect: 21 / 9,
    };
  }
  submitPlan(label: string, build: PlanBuilder) {
    this.plans.push({ label, build });
  }
  onInterrupt(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  interrupt() {
    for (const listener of this.listeners) listener();
  }
}

interface Setup {
  clock: Clock;
  executor: FakeExecutor;
  director: IdleDirector;
  runs: string[];
  picks: IdlePickContext[];
  settings: IdleSettings;
  room: { current: typeof reading | null };
  motion: { ready: boolean };
  reply: { current: (() => Promise<IdlePickResult | null>) | null };
  random: { values: number[] };
}

function setup(overrides: Partial<IdleDirectorDeps> = {}): Setup {
  const clock = new Clock();
  const executor = new FakeExecutor();
  const runs: string[] = [];
  const picks: IdlePickContext[] = [];
  const settings: IdleSettings = { ...DEFAULT_IDLE_SETTINGS };
  const room: Setup['room'] = { current: reading };
  const motion = { ready: true };
  const reply: Setup['reply'] = { current: async () => ({ text: '{go:bookshelf}{move:browses the books}' }) };
  const random = { values: [0.5] };
  let i = 0;
  const director = new IdleDirector({
    executor,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => random.values[i++ % random.values.length] ?? 0,
    settings: () => settings,
    room: () => room.current,
    motionReady: () => motion.ready,
    persona: () => ({ name: 'Mei', personality: 'Gentle.', habits: 'Likes books.' }),
    pick: async (context) => {
      picks.push(context);
      return reply.current ? reply.current() : null;
    },
    run: (text) => runs.push(text),
    ...overrides,
  });
  return { clock, executor, director, runs, picks, settings, room, motion, reply, random };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('IdleDirector timing', () => {
  it('does nothing for 45 s, then asks the model and runs its tags', async () => {
    const s = setup();
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS - 1);
    expect(s.picks).toHaveLength(0);
    await s.clock.advance(1);
    expect(s.picks).toHaveLength(1);
    expect(s.picks[0]?.system).toContain('Reply with only 1 to 3 action tags');
    expect(s.picks[0]?.user).toContain('Idle habits: Likes books.');
    // At 21:9 the whole room is in view, so the bookshelf is a valid target.
    expect(s.runs).toEqual(['{go:bookshelf}{move:browses the books}']);
  });

  it('measures the next wait from the end of the action, drawn from 60 to 140 % of the mean', async () => {
    for (const [roll, expected] of [
      [0, 54_000],
      [1, 126_000],
      [0.5, 90_000],
    ] as const) {
      const s = setup();
      s.random.values = [roll];
      s.director.start();
      await s.clock.advance(FIRST_ACTION_DELAY_MS);
      expect(s.runs).toHaveLength(1);
      s.executor.busy = true;
      await s.clock.advance(5_000); // the action takes a while
      s.executor.busy = false;
      await s.clock.advance(1_000);
      const finishedAt = s.clock.now();
      await s.clock.advance(expected - 1_500);
      expect(s.runs).toHaveLength(1);
      await s.clock.advance(1_500 + 1_000);
      expect(s.runs.length).toBe(2);
      expect(s.clock.now() - finishedAt).toBeGreaterThanOrEqual(expected - 1_100);
    }
  });

  it('uses the restlessness setting for the mean wait', async () => {
    const calm = setup();
    calm.settings.restlessness = 'calm';
    calm.director.start();
    await calm.clock.advance(FIRST_ACTION_DELAY_MS + 2_000);
    await calm.clock.advance(180_000 - 5_000);
    expect(calm.runs).toHaveLength(1);
    await calm.clock.advance(10_000);
    expect(calm.runs).toHaveLength(2);

    const restless = setup();
    restless.settings.restlessness = 'restless';
    restless.director.start();
    await restless.clock.advance(FIRST_ACTION_DELAY_MS + 2_000);
    await restless.clock.advance(45_000);
    expect(restless.runs).toHaveLength(2);
  });

  it('waits while scene actions are queued or running, and while the assistant is working on a turn', async () => {
    const s = setup();
    s.executor.busy = true;
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS + 20_000);
    expect(s.picks).toHaveLength(0);
    s.executor.busy = false;
    await s.clock.advance(4_000);
    expect(s.picks).toHaveLength(1);

    const t = setup();
    t.director.start();
    await t.clock.advance(30_000);
    t.director.setConversationPhase('responding');
    await t.clock.advance(60_000);
    t.director.setConversationPhase('waiting');
    await t.clock.advance(FIRST_ACTION_DELAY_MS - 1_000);
    expect(t.picks).toHaveLength(0); // 45 s from the end of the turn
    await t.clock.advance(1_000);
    expect(t.picks).toHaveLength(1);
  });

  it('is active only with a room, the motion service and the wander setting', async () => {
    const s = setup();
    s.motion.ready = false;
    s.director.start();
    expect(s.director.isActive).toBe(false);
    await s.clock.advance(FIRST_ACTION_DELAY_MS * 3);
    expect(s.picks).toHaveLength(0);
    expect(s.clock.pending).toBe(0);

    s.motion.ready = true;
    s.director.update();
    expect(s.director.isActive).toBe(true);
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.picks).toHaveLength(1);

    s.settings.enabled = false;
    s.director.update();
    expect(s.director.isActive).toBe(false);
    expect(s.clock.pending).toBe(0);

    s.settings.enabled = true;
    s.room.current = null;
    s.director.update();
    expect(s.director.isActive).toBe(false);
  });

  it('starts the 45 s again when it becomes active', async () => {
    const s = setup();
    s.settings.enabled = false;
    s.director.start();
    await s.clock.advance(100_000);
    s.settings.enabled = true;
    s.director.update();
    await s.clock.advance(FIRST_ACTION_DELAY_MS - 1);
    expect(s.picks).toHaveLength(0);
    await s.clock.advance(1);
    expect(s.picks).toHaveLength(1);
  });
});

describe('IdleDirector choosing', () => {
  it('keeps only valid tags and falls back to the random picker when none are left', async () => {
    const s = setup();
    s.reply.current = async () => ({ text: '{go:piano}{sit:coffee table}' });
    s.random.values = [0.01];
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.runs).toEqual(['{sit:sofa}']);
  });

  it('falls back when the model fails or returns null', async () => {
    for (const reply of [async () => null, async () => Promise.reject(new Error('down'))]) {
      const s = setup();
      s.reply.current = reply;
      s.random.values = [0.01];
      s.director.start();
      await s.clock.advance(FIRST_ACTION_DELAY_MS);
      expect(s.runs).toEqual(['{sit:sofa}']);
    }
  });

  it('does nothing this time when the model says {wait}, and asks again after the interval', async () => {
    const s = setup();
    s.reply.current = async () => ({ text: '{wait}' });
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.runs).toEqual([]);
    expect(s.director.recent()).toHaveLength(0);
    await s.clock.advance(60_000);
    expect(s.picks).toHaveLength(1);
    await s.clock.advance(60_000);
    expect(s.picks).toHaveLength(2);
  });

  it('avoids the last targets when picking at random', async () => {
    const s = setup();
    s.reply.current = async () => null;
    s.random.values = [0.01, 0.5];
    s.director.start();
    const seen: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      await s.clock.advance(FIRST_ACTION_DELAY_MS * 4);
      seen.push(s.runs[n] ?? '');
    }
    expect(s.runs.length).toBeGreaterThanOrEqual(4);
    expect(s.runs[1]).not.toBe(s.runs[0]);
  });

  it('throws away an answer that arrives after talking started', async () => {
    const s = setup();
    let release!: (value: IdlePickResult) => void;
    s.reply.current = () => new Promise((resolve) => (release = resolve));
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.picks).toHaveLength(1);
    s.executor.interrupt(); // the user wakes the avatar
    release({ text: '{go:bookshelf}' });
    await flush();
    expect(s.runs).toEqual([]);
    // And the wait starts again from 45 s.
    s.reply.current = async () => ({ text: '{sit:sofa}' });
    await s.clock.advance(FIRST_ACTION_DELAY_MS - 1);
    expect(s.picks).toHaveLength(1);
    await s.clock.advance(1);
    expect(s.runs).toEqual(['{sit:sofa}']);
  });

  it('goes back to 45 s after any conversation activity, even in the middle of the interval', async () => {
    const s = setup();
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS + 2_000);
    expect(s.runs).toHaveLength(1);
    await s.clock.advance(30_000);
    s.executor.interrupt();
    await s.clock.advance(FIRST_ACTION_DELAY_MS - 2_000);
    expect(s.runs).toHaveLength(1);
    await s.clock.advance(3_000);
    expect(s.runs).toHaveLength(2);
  });

  it('forgets its log when the room changes', async () => {
    const s = setup();
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.director.recent()).toHaveLength(1);
    s.room.current = studio;
    s.director.update();
    expect(s.director.recent()).toHaveLength(0);
    expect(s.director.recentSummary()).toBe('');
  });
});

describe('IdleDirector log', () => {
  it('keeps the last 8 actions with their time and summarises the last ten minutes', async () => {
    const s = setup();
    s.reply.current = async () => ({ text: '{go:bookshelf}{move:browses the books}' });
    s.settings.restlessness = 'restless';
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.director.recent()).toEqual([{ at: s.clock.now(), text: 'walked to the bookshelf (browses the books)' }]);
    expect(s.director.recentSummary()).toBe('walked to the bookshelf (browses the books)');

    s.reply.current = async () => ({ text: '{sit:armchair}' });
    for (let n = 0; n < 12; n += 1) await s.clock.advance(60_000);
    expect(s.director.recent().length).toBe(LOG_SIZE);
    expect(s.director.recent().at(-1)?.text).toBe('sat down on the armchair');
    expect(s.director.recentSummary().split('; ').length).toBeLessThanOrEqual(LOG_SIZE);

    s.settings.enabled = false;
    s.director.update();
    await s.clock.advance(SUMMARY_WINDOW_MS + 1_000);
    expect(s.director.recentSummary()).toBe('');
    expect(s.director.recent().length).toBe(LOG_SIZE); // still logged, just too old to mention
  });
});

describe('IdleDirector conversation note', () => {
  it('publishes the summary when it changes, but never while the assistant is working on a turn', async () => {
    const notes: string[] = [];
    const s = setup({ onNoteChange: (note) => notes.push(note) });
    s.settings.restlessness = 'restless';
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(notes).toEqual(['walked to the bookshelf (browses the books)']);

    // A turn begins and ends; a new idle action cannot happen meanwhile, and nothing is published during it.
    s.director.setConversationPhase('thinking');
    s.reply.current = async () => ({ text: '{sit:armchair}' });
    await s.clock.advance(30_000);
    expect(notes).toHaveLength(1);
    s.director.setConversationPhase('waiting');
    expect(notes).toHaveLength(1); // unchanged, so not published again

    await s.clock.advance(FIRST_ACTION_DELAY_MS + 5_000);
    expect(notes.at(-1)).toBe('walked to the bookshelf (browses the books); sat down on the armchair');

    // After ten minutes with no new action it is empty again, published at the next quiet moment.
    s.settings.enabled = false;
    s.director.update();
    await s.clock.advance(SUMMARY_WINDOW_MS + 1_000);
    s.director.setConversationPhase('listening');
    expect(notes.at(-1)).toBe('');

    s.room.current = null;
    s.director.update();
    expect(s.director.recentSummary()).toBe('');
  });
});

describe('IdleDirector when talking starts', () => {
  async function wander(s: Setup) {
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.runs).toHaveLength(1);
  }

  it('queues the setting’s reaction once, after the last interrupt has settled', async () => {
    const s = setup();
    s.settings.onTalk = 'come-back';
    await wander(s);
    s.executor.position = { x: -2, z: -1.5, yaw: 0 };
    s.executor.interrupt();
    await s.clock.advance(TALK_SETTLE_MS - 100);
    s.executor.interrupt(); // speech starts a moment after the wake word
    await s.clock.advance(TALK_SETTLE_MS - 100);
    expect(s.executor.plans).toHaveLength(0);
    await s.clock.advance(200);
    expect(s.executor.plans).toHaveLength(1);
    expect(s.executor.plans[0]?.build(s.executor.world(), s.executor.state)).toEqual([{ kind: 'come' }]);
    // Once handled, talking again does not queue it again until the avatar has wandered again.
    s.executor.interrupt();
    await s.clock.advance(TALK_SETTLE_MS + 100);
    expect(s.executor.plans).toHaveLength(1);
  });

  it('uses "turn to me" by default and does nothing if the avatar never wandered', async () => {
    const s = setup();
    s.director.start();
    s.executor.interrupt();
    await s.clock.advance(TALK_SETTLE_MS + 100);
    expect(s.executor.plans).toHaveLength(0);

    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    s.executor.interrupt();
    await s.clock.advance(TALK_SETTLE_MS + 100);
    expect(s.executor.plans).toHaveLength(1);
    s.executor.position = { x: -2, z: -1, yaw: Math.PI };
    expect(s.executor.plans[0]?.build(s.executor.world(), s.executor.state)).toMatchObject([{ kind: 'lookAtPoint' }]);
  });
});
