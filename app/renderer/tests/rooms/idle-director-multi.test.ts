import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_SETTINGS } from '../../../main/src/rooms/idle-settings.js';
import type { IdlePickContext } from '../../../main/src/rooms/types.js';
import { FIRST_ACTION_DELAY_MS, IdleDirector, TALK_SETTLE_MS, type IdleAvatar, type IdleExecutor } from '../../src/rooms/idle-director.js';
import { INITIAL_STATE, type AvatarState, type PlanWorld } from '../../src/rooms/scene-actions.js';
import type { PlanBuilder } from '../../src/rooms/scene-executor.js';
import { builtInRoom } from './fixtures.js';

const room = builtInRoom('reading-room');

class Fake implements IdleExecutor {
  busy = false;
  state: AvatarState = INITIAL_STATE;
  plans: string[] = [];
  private listeners = new Set<() => void>();
  constructor(private readonly at = { x: 0, z: -0.3 }) {}
  getState() {
    return this.state;
  }
  world(): PlanWorld {
    return {
      room,
      hasNavigation: true,
      findPath: () => null,
      closestWalkable: (p) => p,
      objectPosition: () => null,
      frame: { origin: { ...this.at, yaw: 0 }, scale: 1 },
      restHipsHeight: 0.95,
      cameraAspect: 21 / 9,
    };
  }
  submitPlan(label: string, build: PlanBuilder) {
    void build;
    this.plans.push(label);
  }
  onInterrupt(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function setup(replyFor: (context: IdlePickContext) => string = () => '{go:bookshelf}{say:hello there}', solo = false) {
  const notes: string[] = [];
  let time = 1_000_000;
  let timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let next = 1;
  const echo = new Fake();
  const sage = new Fake({ x: 1, z: 1 });
  const runs: Array<[string, string | undefined]> = [];
  const picks: IdlePickContext[] = [];
  const roster: IdleAvatar[] = [
    { id: 'echo', name: 'Echo', executor: echo },
    { id: 'sage', name: 'Sage', executor: sage, personality: 'Dry wit.', habits: 'Reads.' },
  ];
  const director = new IdleDirector({
    executor: echo,
    avatars: () => (solo ? roster.slice(0, 1) : roster),
    now: () => time,
    setTimer: (fn, ms) => {
      timers.push({ id: next, at: time + ms, fn });
      return next++;
    },
    clearTimer: (h) => {
      timers = timers.filter((t) => t.id !== h);
    },
    random: () => 0.5,
    settings: () => ({ ...DEFAULT_IDLE_SETTINGS }),
    room: () => room,
    motionReady: () => true,
    persona: () => ({ name: 'Echo', personality: 'Bright.', habits: 'Likes tea.' }),
    pick: async (context) => {
      picks.push(context);
      return { text: replyFor(context) };
    },
    onNoteChange: (note) => notes.push(note),
    run: (...args) => runs.push([args[0], args[1]]),
  });
  const advance = async (ms: number) => {
    const end = time + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      time = Math.max(time, due.at);
      due.fn();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }
    time = end;
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  return { director, echo, sage, runs, picks, advance, roster, notes };
}

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));

describe('IdleDirector with several avatars', () => {
  it('acts for the picked avatar: Echo first, then Sage, with Sage named and her own habits', async () => {
    const s = setup();
    s.director.start();
    await s.advance(FIRST_ACTION_DELAY_MS);
    expect(s.runs).toEqual([['{go:bookshelf}', undefined]]);
    expect(s.picks[0]?.user).toContain('Character: Echo');
    expect(s.picks[0]?.user).toContain('Others in the room:\n- Sage is');
    await s.advance(3_000);
    await s.advance(130_000);
    expect(s.runs[1]).toEqual(['{go:bookshelf}', 'sage']);
    expect(s.picks[1]?.user).toContain('Character: Sage');
    expect(s.picks[1]?.user).toContain('Idle habits: Reads.');
    expect(s.picks[1]?.user).not.toContain('Likes tea');
    expect(s.picks[1]?.user).toContain('- Echo is');
  });

  it('only runs action tags (no spoken remark) and keeps the idle note about Echo alone', async () => {
    const s = setup();
    s.director.start();
    await s.advance(FIRST_ACTION_DELAY_MS + 3_000);
    await s.advance(130_000);
    expect(s.runs.map(([text]) => text).every((text) => !text.includes('say'))).toBe(true);
    expect(s.runs.some(([, id]) => id === 'sage')).toBe(true);
    // Only Echo's one action is in the summary.
    expect(s.director.recent()).toHaveLength(1);
    expect(s.notes).toEqual(['walked to the bookshelf']);
  });

  it('skips an avatar that is speaking or busy', async () => {
    const s = setup();
    const echoEntry = s.roster[0];
    if (echoEntry) echoEntry.speaking = true;
    s.director.start();
    await s.advance(FIRST_ACTION_DELAY_MS);
    expect(s.runs).toEqual([['{go:bookshelf}', 'sage']]);
    // Everybody busy: nothing happens, it keeps looking.
    const t = setup();
    t.echo.busy = true;
    t.sage.busy = true;
    t.director.start();
    await t.advance(FIRST_ACTION_DELAY_MS + 10_000);
    expect(t.picks).toHaveLength(0);
    t.echo.busy = false;
    await t.advance(4_000);
    expect(t.runs).toEqual([['{go:bookshelf}', undefined]]);
  });

  it('turns every avatar that wandered to the user when talking starts', async () => {
    const s = setup();
    s.director.start();
    await s.advance(FIRST_ACTION_DELAY_MS + 3_000);
    await s.advance(130_000);
    s.director.noteActivity();
    await s.advance(TALK_SETTLE_MS);
    expect(s.echo.plans).toEqual(['turn to the user']);
    expect(s.sage.plans).toEqual(['turn to the user']);
  });

  it('behaves as before with one avatar in the roster', async () => {
    const s = setup(() => '{go:bookshelf}', true);
    s.director.start();
    await s.advance(FIRST_ACTION_DELAY_MS);
    expect(s.runs).toEqual([['{go:bookshelf}', undefined]]);
    expect(s.picks[0]?.user).not.toContain('Others in the room');
    await s.advance(3_000 + 130_000);
    expect(s.runs.every(([, id]) => id === undefined)).toBe(true);
    expect(s.runs).toHaveLength(2);
  });
});
