import { describe, expect, it } from 'vitest';
import {
  describeIdleTags,
  fallbackIdleTags,
  idleTagsToText,
  idleTargets,
  parseIdleReply,
  startsWithWait,
} from '../../src/rooms/idle-actions.js';
import type { IdleInput, IdleTag } from '../../src/rooms/idle-types.js';
import { visibleObjects } from '../../src/rooms/room-visibility.js';
import { INITIAL_STATE, type AvatarState } from '../../src/rooms/scene-actions.js';
import { builtInRoom } from './fixtures.js';

const room = builtInRoom('reading-room');

function input(overrides: Partial<IdleInput> = {}): IdleInput {
  return {
    name: 'Mei',
    personality: '',
    habits: '',
    room,
    visible: visibleObjects(room, 21 / 9), // everything, including the bookshelf
    state: INITIAL_STATE,
    position: [0, 0, -0.3],
    recent: [],
    now: new Date(2026, 10, 9, 12, 0),
    ...overrides,
  };
}

const seated: AvatarState = { posture: 'seated', held: null, seat: { objectId: 'sofa', session: 's', frame: { origin: { x: 0, z: 0, yaw: 0 }, scale: 1 }, approach: [0, 0, 0], facing: 0 } };
const holding: AvatarState = { posture: 'standing', held: { objectId: 'mug', hand: 'left' } };

describe('parseIdleReply', () => {
  it('accepts scene tags and moves, returning object ids', () => {
    expect(parseIdleReply('{go:the bookshelf}{move:browses the books}', input())).toEqual([
      { type: 'go', object: 'bookshelf' },
      { type: 'move', text: 'browses the books' },
    ]);
    expect(parseIdleReply('Sure! {sit:Armchair} and then {come}', input())).toEqual([
      { type: 'sit', object: 'armchair' },
      { type: 'come' },
    ]);
  });

  it('keeps at most three tags', () => {
    const tags = parseIdleReply('{go:sofa}{look:bookshelf}{go:armchair}{go:coffee table}', input());
    expect(tags).toHaveLength(3);
  });

  it('drops tags whose objects do not exist, are off camera or lack the needed tag', () => {
    const wide = input({ visible: visibleObjects(room, 16 / 9) });
    expect(parseIdleReply('{go:piano}', wide)).toEqual([]);
    expect(parseIdleReply('{go:bookshelf}', wide)).toEqual([]); // not in view at 16:9
    expect(parseIdleReply('{sit:coffee table}', wide)).toEqual([]); // nothing to sit on
    expect(parseIdleReply('{pick:sofa}', wide)).toEqual([]);
    expect(parseIdleReply('{go:floor lamp}', wide)).toEqual([]); // no stand or look tag
    expect(parseIdleReply('{go:piano}{sit:sofa}', wide)).toEqual([{ type: 'sit', object: 'sofa' }]);
  });

  it('only allows {stand} when seated, {pick} when the hands are free and {put} when holding it', () => {
    expect(parseIdleReply('{stand}', input())).toEqual([]);
    expect(parseIdleReply('{stand}', input({ state: seated }))).toEqual([{ type: 'stand' }]);
    expect(parseIdleReply('{pick:mug}', input())).toEqual([{ type: 'pick', object: 'mug' }]);
    expect(parseIdleReply('{pick:mug}', input({ state: holding }))).toEqual([]);
    expect(parseIdleReply('{put:mug@coffee table}', input())).toEqual([]);
    expect(parseIdleReply('{put:mug@coffee table}', input({ state: holding }))).toEqual([
      { type: 'put', object: 'mug', surface: 'coffee-table' },
    ]);
    expect(parseIdleReply('{put:mug@sofa}', input({ state: holding }))).toEqual([]);
    // A pick followed by a put within one answer is understood.
    expect(parseIdleReply('{pick:mug}{put:mug@coffee table}', input())).toHaveLength(2);
  });

  it('understands a leading {wait} and ignores unknown tags', () => {
    expect(parseIdleReply('{wait}', input())).toEqual([{ type: 'wait' }]);
    expect(parseIdleReply('{WAIT} {go:sofa}', input())).toEqual([{ type: 'wait' }]);
    expect(startsWithWait('{go:sofa}{wait}')).toBe(false);
    expect(parseIdleReply('{go:sofa}{wait}', input())).toEqual([{ type: 'go', object: 'sofa' }]);
    expect(parseIdleReply('{dance}{anim:wave}', input())).toEqual([]);
    expect(parseIdleReply('I think I will just sit.', input())).toEqual([]);
  });
});

describe('writing tags back', () => {
  const tags: IdleTag[] = [
    { type: 'go', object: 'bookshelf' },
    { type: 'move', text: 'browses {the} books' },
    { type: 'put', object: 'mug', surface: 'coffee-table' },
    { type: 'stand' },
  ];

  it('writes the text the scene executor reads, which reads back to the same tags', () => {
    expect(idleTagsToText(tags)).toBe('{go:bookshelf}{move:browses the books}{put:mug@coffee-table}{stand}');
    expect(parseIdleReply(idleTagsToText(tags), input({ state: holding }))[0]).toEqual({ type: 'go', object: 'bookshelf' });
  });

  it('lists targets and describes what happened for the log', () => {
    expect(idleTargets(tags)).toEqual(['bookshelf', 'mug', 'coffee-table']);
    expect(describeIdleTags(tags.slice(0, 2), room)).toBe('walked to the bookshelf (browses {the} books)');
    expect(describeIdleTags([{ type: 'sit', object: 'armchair' }, { type: 'move', text: 'a person sips tea' }], room)).toBe(
      'sat down on the armchair (sips tea)',
    );
    expect(describeIdleTags([{ type: 'come' }, { type: 'wait' }], room)).toBe('walked back to the middle of the room');
    expect(describeIdleTags([{ type: 'wait' }], room)).toBe('');
  });
});

describe('fallbackIdleTags', () => {
  const sequence = (...values: number[]) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)] ?? 0;
  };

  it('builds candidates from tags: sit, go with the idle hint, pick', () => {
    const picks = new Set<string>();
    for (let r = 0; r < 1; r += 0.01) picks.add(idleTagsToText(fallbackIdleTags(input(), () => r)));
    expect(picks).toContain('{sit:sofa}');
    expect(picks).toContain('{sit:armchair}');
    expect(picks).toContain('{go:bookshelf}{move:browse the books}');
    expect(picks).toContain('{go:coffee-table}{move:looks around}');
    expect(picks).toContain('{pick:mug}');
    expect([...picks].every((text) => !text.includes('put'))).toBe(true);
    expect(picks.has('{come}')).toBe(false); // at home
  });

  it('offers putting down what is held, and not picking up more', () => {
    const picks = new Set<string>();
    for (let r = 0; r < 1; r += 0.01) picks.add(idleTagsToText(fallbackIdleTags(input({ state: holding }), () => r)));
    expect(picks).toContain('{put:mug@coffee-table}');
    expect(picks).not.toContain('{pick:mug}');
  });

  it('offers a walk home, with low weight, only when far from it', () => {
    const far = input({ position: [-2.5, 0, -2.5] });
    const picks = new Map<string, number>();
    for (let r = 0; r < 1; r += 0.005) {
      const text = idleTagsToText(fallbackIdleTags(far, () => r));
      picks.set(text, (picks.get(text) ?? 0) + 1);
    }
    const come = picks.get('{come}') ?? 0;
    expect(come).toBeGreaterThan(0);
    expect(come).toBeLessThan((picks.get('{sit:sofa}') ?? 0));
  });

  it('avoids the last two targets', () => {
    const picks = new Set<string>();
    for (let r = 0; r < 1; r += 0.01) picks.add(idleTagsToText(fallbackIdleTags(input(), () => r, ['sofa', 'mug', 'armchair'])));
    expect([...picks].some((text) => text.includes('armchair') || text.includes('mug'))).toBe(false);
    expect([...picks].some((text) => text.includes('sofa'))).toBe(true); // only the last two are avoided
  });

  it('stays seated 60 % of the time and otherwise stands up', () => {
    expect(fallbackIdleTags(input({ state: seated }), sequence(0.59))).toEqual([{ type: 'wait' }]);
    expect(fallbackIdleTags(input({ state: seated }), sequence(0.6))).toEqual([{ type: 'stand' }]);
  });

  it('waits when nothing is possible and is deterministic for a given random', () => {
    expect(fallbackIdleTags(input({ visible: [] }), () => 0.5)).toEqual([{ type: 'wait' }]);
    expect(fallbackIdleTags(input(), () => 0.3)).toEqual(fallbackIdleTags(input(), () => 0.3));
  });
});
