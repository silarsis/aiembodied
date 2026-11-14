import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_SETTINGS } from '../../../main/src/rooms/idle-settings.js';
import type { PlacesSnapshot } from '../../../main/src/places/place-manager.js';
import { WANDER_COOLDOWN_MS } from '../../../main/src/places/wander.js';
import { FIRST_ACTION_DELAY_MS, IdleDirector, type IdleExecutor, type IdlePlacesView } from '../../src/rooms/idle-director.js';
import { INITIAL_STATE, type AvatarState, type PlanWorld } from '../../src/rooms/scene-actions.js';
import { builtInRoom } from './fixtures.js';

const reading = builtInRoom('reading-room');
const NOW = 5_000_000;

class Clock {
  time = NOW;
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
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

class FakeExecutor implements IdleExecutor {
  busy = false;
  getState(): AvatarState {
    return INITIAL_STATE;
  }
  world(): PlanWorld {
    return {
      room: reading,
      hasNavigation: true,
      findPath: () => null,
      closestWalkable: (p) => p,
      objectPosition: () => null,
      frame: { origin: { x: 0, z: -0.3, yaw: 0 }, scale: 1 },
      restHipsHeight: 0.95,
      cameraAspect: 21 / 9,
    };
  }
  submitPlan() {}
  onInterrupt() {
    return () => undefined;
  }
}

function snapshot(patch: Partial<PlacesSnapshot> = {}): PlacesSnapshot {
  return {
    places: [
      { id: 'home', name: 'the lounge', node: 'local' },
      { id: 'next-door', name: 'next door', node: 'offscreen' },
      { id: 'study', name: 'the study', node: 'room-1', online: true },
    ],
    locations: { echo: 'home', sage: 'study' },
    transit: [],
    localPlaceId: 'home',
    now: NOW,
    movedAt: {},
    activeAt: { study: NOW - 120_000 },
    ...patch,
  };
}

function setup(view: IdlePlacesView | null, answer: boolean | Error, reply = '{room:the study}') {
  const clock = new Clock();
  const runs: string[] = [];
  const picks: Array<{ system: string; user: string }> = [];
  const asked: Array<[string, string, boolean]> = [];
  const director = new IdleDirector({
    executor: new FakeExecutor(),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    settings: () => ({ ...DEFAULT_IDLE_SETTINGS }),
    room: () => reading,
    motionReady: () => true,
    persona: () => ({ name: 'Mei', personality: 'Gentle.', habits: '' }),
    pick: async (context) => {
      picks.push(context);
      return { text: reply };
    },
    run: (text) => runs.push(text),
    places: () => (view ? Promise.resolve(view) : null),
    canWander: async (avatarId, place, speaking) => {
      asked.push([avatarId, place, speaking]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { clock, director, runs, picks, asked };
}

const view = (patch: Partial<PlacesSnapshot> = {}): IdlePlacesView => ({ snapshot: snapshot(patch), nameOf: (id) => (id === 'sage' ? 'Sage' : id) });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('IdleDirector wandering between places', () => {
  it('tells the model about the other places, who is there and whether the PC was used lately, and offers {room:}', async () => {
    const s = setup(view(), true);
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.picks[0]?.system).toContain('{room:<place>}');
    expect(s.picks[0]?.user).toContain('- the study: Sage is there; someone used that PC in the last 10 minutes');
    // Next door: nobody there and no PC, so it is not offered.
    expect(s.picks[0]?.user).not.toContain('next door');
  });

  it('runs the {room:} tag when bija allows it, passing whether the avatar is speaking', async () => {
    const s = setup(view(), true);
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.asked).toEqual([['echo', 'the study', false]]);
    expect(s.runs).toEqual(['{room:the study}']);
  });

  it('drops the {room:} tag in code when bija refuses, and falls back to something else to do', async () => {
    const s = setup(view(), false, '{go:bookshelf}{room:the study}');
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.asked).toHaveLength(1);
    expect(s.runs).toEqual(['{go:bookshelf}']);
    const alone = setup(view(), false, '{room:the study}');
    alone.director.start();
    await alone.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(alone.runs.join('')).not.toContain('{room:');
  });

  it('drops the tag when asking bija fails', async () => {
    const s = setup(view(), new Error('no link'));
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.runs.join('')).not.toContain('{room:');
  });

  it('ignores a {room:} for a place the prompt did not offer, without even asking', async () => {
    const s = setup(view(), true, '{room:next door}');
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.asked).toEqual([]);
    expect(s.runs.join('')).not.toContain('{room:');
  });

  it('offers no place to an avatar that moved in the last 10 minutes', async () => {
    const s = setup(view({ movedAt: { echo: NOW - WANDER_COOLDOWN_MS + 1000 } }), true);
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.picks[0]?.system).not.toContain('{room:<place>}');
    expect(s.picks[0]?.user).not.toContain('Other places');
    expect(s.asked).toEqual([]);
  });

  it('is exactly what it was without places: no extra question, no place text', async () => {
    const s = setup(null, true, '{go:bookshelf}');
    s.director.start();
    await s.clock.advance(FIRST_ACTION_DELAY_MS);
    expect(s.picks[0]?.system).not.toContain('{room:');
    expect(s.picks[0]?.user).not.toContain('Other places');
    expect(s.runs).toEqual(['{go:bookshelf}']);
    expect(s.asked).toEqual([]);
  });
});
