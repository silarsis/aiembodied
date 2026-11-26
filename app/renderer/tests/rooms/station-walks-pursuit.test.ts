import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationBody, StationUseEvent } from '../../../main/src/shared/stations/types.js';
import type { AvatarState, PlanWorld, SceneAction } from '../../src/rooms/scene-actions.js';
import type { PlanBuilder } from '../../src/rooms/scene-executor.js';
import { READ_REPEAT_MS } from '../../src/rooms/station-body.js';
import { handleStationUse, resetStationBodies, type StationWalkDeps, type StationWalkExecutor } from '../../src/rooms/station-walks.js';
import { builtInRoom } from './fixtures.js';

const reading = builtInRoom('reading-room');
const body: StationBody = {
  prop: 'book',
  seat: 'armchair',
  browse: 'runs a finger along the book spines',
  read: 'reads a book, turning a page now and then',
  note: 'pauses and jots something down',
};

/** A fake executor that records the queue in order and runs plans against a state the test controls. */
function setup(initial: AvatarState = { posture: 'standing', held: null }, room = reading) {
  const log: string[] = [];
  const state = { current: initial };
  const world = { room, frame: { origin: { x: 0, z: 0, yaw: 0 } } } as unknown as PlanWorld;
  const queue: Array<() => void> = [];
  const executor: StationWalkExecutor = {
    world: () => world,
    getState: () => state.current,
    submit: (actions: SceneAction[]) => void log.push(`submit ${actions.map((a) => a.kind + ('objectId' in a ? `:${a.objectId}` : '')).join(',')}`),
    submitAfter: (label, run) => {
      log.push(`after ${label}`);
      queue.push(() => void run());
    },
    submitPlan: (label: string, build: PlanBuilder) => {
      log.push(`plan ${label}`);
      queue.push(() => {
        const actions = build(world, state.current);
        log.push(`  -> ${actions.map((a) => a.kind + ('objectId' in a ? `:${a.objectId}` : '') + ('surfaceId' in a ? `@${a.surfaceId}` : '')).join(',') || 'nothing'}`);
      });
    },
  };
  const deps: StationWalkDeps = {
    room: () => room,
    executorFor: () => executor,
    isHere: () => true,
    gesture: vi.fn((text: string) => void log.push(`gesture ${text}`)),
    arrived: vi.fn(),
  };
  /** Runs everything queued so far, in order (the executor's turn). */
  const drain = () => {
    while (queue.length) queue.shift()!();
  };
  return { deps, executor, log, state, drain };
}

function event(phase: StationUseEvent['phase'], extra: Partial<StationUseEvent> = {}): StationUseEvent {
  return {
    useId: 'use-1',
    avatarId: 'echo',
    stationId: 'default:dair-academy-papers',
    roomId: reading.id,
    objectId: 'bookshelf',
    activity: 'pulls a book from the shelf and reads',
    phase,
    source: 'pursuit',
    body,
    ...extra,
  };
}
const step = (name: string, extra: Partial<StationUseEvent> = {}) => event('activity', { step: name, activity: `phase 2 text for ${name}`, ...extra });

describe('reading with a body (pursuit)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStationBodies();
  });
  afterEach(() => {
    resetStationBodies();
    vi.useRealTimers();
  });

  it('start: walks to the shelf and looks at it, then answers arrived', () => {
    const { deps, log, drain } = setup();
    handleStationUse(event('start'), deps);
    expect(log).toEqual(['submit go:bookshelf', 'after reach the bookshelf', 'submit look:bookshelf']);
    drain();
    expect(deps.arrived).toHaveBeenCalledWith('use-1');
  });

  it('want, act and choose browse the shelf (the same gesture is not played back to back)', () => {
    const { deps, log, drain } = setup();
    handleStationUse(step('want'), deps);
    handleStationUse(step('act'), deps);
    drain();
    expect(log.filter((line) => line.startsWith('gesture'))).toEqual(['gesture {move:runs a finger along the book spines}']);
    vi.advanceTimersByTime(10_000);
    handleStationUse(step('choose'), deps);
    drain();
    expect(deps.gesture).toHaveBeenCalledTimes(2);
  });

  it('consume: takes the book, sits down and reads; the reading gesture repeats while standing only', () => {
    const { deps, log, state, drain } = setup();
    handleStationUse(step('consume'), deps);
    expect(log.slice(0, 2)).toEqual(['plan take the book', 'plan sit down to read']);
    drain();
    expect(log).toContain('  -> pick:book');
    // The book is in the hand by the time the sit plan runs.
    state.current = { posture: 'standing', held: { objectId: 'book', hand: 'right' } };
    expect(log.some((line) => line.includes('gesture {move:reads a book'))).toBe(true);
    // Seated: the repeat is left out (the executor would skip a gesture then).
    state.current = { posture: 'seated', held: { objectId: 'book', hand: 'right' } };
    const before = vi.mocked(deps.gesture).mock.calls.length;
    vi.advanceTimersByTime(READ_REPEAT_MS);
    drain();
    expect(vi.mocked(deps.gesture).mock.calls.length).toBe(before);
    // Back on its feet (the sit failed): the repeat plays and the same text is let through.
    state.current = { posture: 'standing', held: null };
    vi.advanceTimersByTime(READ_REPEAT_MS);
    drain();
    expect(vi.mocked(deps.gesture).mock.calls.length).toBe(before + 1);
  });

  it('the sit plan only sits when the book is held', () => {
    const { deps, log, state, drain } = setup();
    handleStationUse(step('consume'), deps);
    state.current = { posture: 'standing', held: { objectId: 'book', hand: 'right' } };
    drain();
    expect(log).toContain('  -> sit:armchair');
  });

  it('note while seated plays nothing; the next step stops the repeat', () => {
    const { deps, state, drain } = setup({ posture: 'seated', held: { objectId: 'book', hand: 'right' } });
    handleStationUse(step('note'), deps);
    drain();
    expect(deps.gesture).not.toHaveBeenCalled();
    state.current = { posture: 'standing', held: null };
    handleStationUse(step('consume'), deps);
    handleStationUse(step('note'), deps);
    drain();
    expect(deps.gesture).toHaveBeenLastCalledWith('{move:pauses and jots something down}', 'echo');
    const calls = vi.mocked(deps.gesture).mock.calls.length;
    vi.advanceTimersByTime(READ_REPEAT_MS * 3);
    drain();
    expect(vi.mocked(deps.gesture).mock.calls.length).toBe(calls);
  });

  it('another item while seated: nothing to do, the avatar stays seated with the book', () => {
    const { deps, log, drain } = setup({ posture: 'seated', held: { objectId: 'book', hand: 'right' } });
    handleStationUse(step('act'), deps);
    handleStationUse(step('choose'), deps);
    drain();
    expect(deps.gesture).not.toHaveBeenCalled();
    expect(log.filter((line) => line.startsWith('plan'))).toEqual([]);
  });

  it('end: stands up and puts the book back on the shelf', () => {
    const { deps, log, drain } = setup({ posture: 'seated', held: { objectId: 'book', hand: 'right' } });
    handleStationUse(event('end', { ok: true }), deps);
    drain();
    expect(log).toEqual(['plan put the book back', '  -> stand,put:book@bookshelf']);
  });

  it('end of a cut-short session also comes back to the spot', () => {
    const { deps, log, drain } = setup({ posture: 'seated', held: { objectId: 'book', hand: 'right' } });
    handleStationUse(event('end', { ok: false }), deps);
    drain();
    expect(log[1]).toBe('  -> stand,put:book@bookshelf,come');
  });

  it('a room without the book or the armchair degrades to gestures at the shelf', () => {
    const bare = { ...reading, objects: reading.objects.filter((o) => o.id !== 'book' && o.id !== 'armchair') };
    const { deps, log, drain } = setup(undefined, bare);
    handleStationUse(step('consume'), deps);
    drain();
    expect(log.filter((line) => line.startsWith('  ->'))).toEqual(['  -> nothing', '  -> nothing']);
    expect(deps.gesture).toHaveBeenCalledWith('{move:reads a book, turning a page now and then}', 'echo');
  });

  it('an event without a body plan behaves as in phase 2 (gesture where it stands)', () => {
    const { deps, log } = setup();
    handleStationUse(step('consume', { body: undefined }), deps);
    expect(log).toEqual(['gesture {move:phase 2 text for consume}']);
    expect(deps.gesture).toHaveBeenCalledWith('{move:phase 2 text for consume}', 'echo');
  });
});

describe('voice tool use keeps phase 1 behaviour', () => {
  it('walks to the shelf and plays one activity; the end does nothing, no sitting', () => {
    const { deps, log, drain } = setup();
    const tool = { ...event('start'), source: 'tool' as const, body: undefined };
    handleStationUse(tool, deps);
    handleStationUse({ ...tool, phase: 'end', ok: true }, deps);
    drain();
    expect(log).toEqual(['submit go:bookshelf', 'after reach the bookshelf', 'gesture {move:pulls a book from the shelf and reads}']);
  });
});
