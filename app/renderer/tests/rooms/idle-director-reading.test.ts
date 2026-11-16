import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_SETTINGS } from '../../../main/src/rooms/idle-settings.js';
import { fallbackIdleTags, idleTagsToText, parseIdleReply } from '../../src/rooms/idle-actions.js';
import { FIRST_ACTION_DELAY_MS, IdleDirector, type IdleAvatar, type IdleExecutor } from '../../src/rooms/idle-director.js';
import { buildIdlePrompt } from '../../src/rooms/idle-prompt.js';
import type { IdleInput, IdlePursuit } from '../../src/rooms/idle-types.js';
import { visibleObjects } from '../../src/rooms/room-visibility.js';
import { INITIAL_STATE, type AvatarState, type PlanWorld } from '../../src/rooms/scene-actions.js';
import { builtInRoom } from './fixtures.js';

const room = builtInRoom('reading-room');
const NOW = 5_000_000;
const bookshelf: IdlePursuit = { stationId: 'station-1', objectId: 'bookshelf', objectName: 'bookshelf' };

function input(overrides: Partial<IdleInput> = {}): IdleInput {
  return {
    name: 'Sage',
    personality: '',
    habits: '',
    room,
    visible: visibleObjects(room, 21 / 9),
    state: INITIAL_STATE,
    position: [0, 0, -0.3],
    recent: [],
    now: new Date(2026, 10, 16, 12, 0),
    ...overrides,
  };
}

describe('offering reading in the idle prompt', () => {
  it('names the tag and the shelf only when a station is offered', () => {
    const without = buildIdlePrompt(input());
    expect(without.system).not.toContain('{read:');
    expect(without.user).not.toContain('read something');
    const withIt = buildIdlePrompt(input({ pursuits: [bookshelf] }));
    expect(withIt.system).toContain('{read:<object>}');
    expect(withIt.user).toContain('read something at the bookshelf: {read:bookshelf}');
  });
});

describe('reading the answer', () => {
  it('turns {read:bookshelf} into a read tag for the offered station, and nothing else', () => {
    expect(parseIdleReply('{read:the bookshelf}', input({ pursuits: [bookshelf] }))).toEqual([{ type: 'read', station: 'station-1', object: 'bookshelf' }]);
    expect(parseIdleReply('{go:sofa}{read:Bookshelf}', input({ pursuits: [bookshelf] }))).toEqual([{ type: 'read', station: 'station-1', object: 'bookshelf' }]);
  });

  it('drops a read it was not offered', () => {
    expect(parseIdleReply('{read:bookshelf}', input())).toEqual([]);
    expect(parseIdleReply('{read:armchair}', input({ pursuits: [bookshelf] }))).toEqual([]);
  });

  it('is never run as a scene tag', () => {
    expect(idleTagsToText([{ type: 'read', station: 's', object: 'bookshelf' }])).toBe('');
  });

  it('is a fallback choice when the model gave nothing, so reading stays possible', () => {
    const tags = fallbackIdleTags(input({ pursuits: [bookshelf], visible: [] }), () => 0, []);
    expect(tags).toEqual([{ type: 'read', station: 'station-1', object: 'bookshelf' }]);
  });
});

// -- The director ---------------------------------------------------------------------------------

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
      room,
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

function setup(options: { reply?: string; offers?: Record<string, IdlePursuit[]>; reading?: Set<string>; avatars?: IdleAvatar[]; startOk?: boolean } = {}) {
  const clock = new Clock();
  const runs: Array<[string, string | undefined]> = [];
  const picks: Array<{ system: string; user: string }> = [];
  const started: Array<[string, string]> = [];
  const reading = options.reading ?? new Set<string>();
  const director = new IdleDirector({
    executor: new FakeExecutor(),
    avatars: options.avatars ? () => options.avatars! : undefined,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    settings: () => ({ ...DEFAULT_IDLE_SETTINGS }),
    room: () => room,
    motionReady: () => true,
    persona: () => ({ name: 'Echo', personality: 'Calm.', habits: '' }),
    pick: async (context) => (picks.push(context), { text: options.reply ?? '{read:bookshelf}' }),
    run: (text, avatarId) => runs.push([text, avatarId]),
    pursuitsFor: (avatarId) => options.offers?.[avatarId] ?? [],
    startPursuit: async (avatarId, stationId) => {
      started.push([avatarId, stationId]);
      if (options.startOk !== false) reading.add(avatarId);
      return options.startOk !== false;
    },
    pursuing: (avatarId) => reading.has(avatarId),
  });
  return { clock, director, runs, picks, started, reading };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('IdleDirector and reading', () => {
  it('starts a reading session when the character chooses it, without running any scene tags', async () => {
    const { clock, director, runs, picks, started } = setup({ offers: { echo: [bookshelf] } });
    director.start();
    await clock.advance(FIRST_ACTION_DELAY_MS + 100);
    expect(picks[0].user).toContain('read something at the bookshelf');
    expect(started).toEqual([['echo', 'station-1']]);
    expect(runs).toEqual([]);
    expect(director.recent().map((entry) => entry.text)).toEqual(['went to read at the bookshelf']);
  });

  it('does not offer reading while a session of that avatar is running, and the avatar does not act on its own', async () => {
    const { clock, director, picks, started } = setup({ offers: { echo: [bookshelf] }, reading: new Set(['echo']) });
    director.start();
    await clock.advance(FIRST_ACTION_DELAY_MS + 60_000);
    expect(picks).toEqual([]);
    expect(started).toEqual([]);
  });

  it('offers it per avatar: only the characters the station is for', async () => {
    const sage: IdleAvatar = { id: 'sage', name: 'Sage', executor: new FakeExecutor(), personality: 'Curious.', habits: '' };
    const echo: IdleAvatar = { id: 'echo', name: 'Echo', executor: new FakeExecutor() };
    // Only Sage may use the shelf; whoever the picker chooses, a prompt for Echo never mentions it.
    const { clock, director, picks, started } = setup({ offers: { sage: [bookshelf] }, avatars: [echo, sage], reply: '{read:bookshelf}' });
    director.start();
    await clock.advance(FIRST_ACTION_DELAY_MS + 2_000_000);
    const forSage = picks.filter((p) => p.user.includes('Character: Sage'));
    const forEcho = picks.filter((p) => !p.user.includes('Character: Sage'));
    expect(forEcho.length).toBeGreaterThan(0);
    expect(forEcho.every((p) => !p.user.includes('read something'))).toBe(true);
    expect(forSage.every((p) => p.user.includes('read something at the bookshelf'))).toBe(true);
    expect(started.every(([avatarId]) => avatarId === 'sage')).toBe(true);
  });

  it('stops asking once the avatar has started reading', async () => {
    const { clock, director, picks } = setup({ offers: { echo: [bookshelf] } });
    director.start();
    await clock.advance(FIRST_ACTION_DELAY_MS + 100);
    expect(picks).toHaveLength(1);
    // Echo is now reading: the next interval nobody asks the model.
    await clock.advance(10 * 60_000);
    expect(picks).toHaveLength(1);
  });

  it('carries on when the session could not start', async () => {
    const { clock, director, started } = setup({ offers: { echo: [bookshelf] }, startOk: false });
    director.start();
    await clock.advance(FIRST_ACTION_DELAY_MS + 100);
    expect(started).toHaveLength(1);
    expect(director.isActive).toBe(true);
  });
});
