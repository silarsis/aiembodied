import { describe, expect, it, vi } from 'vitest';
import type { StationUseEvent } from '../../../main/src/stations/types.js';
import { handleStationUse, type StationWalkDeps, type StationWalkExecutor } from '../../src/rooms/station-walks.js';
import { builtInRoom } from './fixtures.js';

const reading = builtInRoom('reading-room');
const studio = builtInRoom('studio-flat');

const start: StationUseEvent = {
  useId: 'use-1',
  avatarId: 'echo',
  stationId: 'default:dair-academy-papers',
  roomId: reading.id,
  objectId: 'bookshelf',
  activity: 'pulls a book from the shelf and reads',
  phase: 'start',
};

function setup(overrides: Partial<StationWalkDeps> = {}, hasWorld = true) {
  const calls: string[] = [];
  const afterCallbacks: Array<() => unknown> = [];
  const executor: StationWalkExecutor = {
    world: () => (hasWorld ? ({} as never) : null),
    submit: vi.fn((actions) => void calls.push(`submit ${JSON.stringify(actions)}`)),
    submitAfter: vi.fn((label, run) => {
      calls.push(`after ${label}`);
      afterCallbacks.push(run);
    }),
  };
  const deps: StationWalkDeps = {
    room: () => reading,
    executorFor: () => executor,
    isHere: () => true,
    gesture: vi.fn((text, avatarId) => void calls.push(`gesture ${avatarId} ${text}`)),
    arrived: vi.fn(),
    ...overrides,
  };
  return { deps, executor, calls, afterCallbacks };
}

describe('handleStationUse', () => {
  it('queues the walk to the object, then the activity, and reports arrival when the walk is over', () => {
    const { deps, calls, afterCallbacks } = setup();
    handleStationUse(start, deps);
    expect(calls).toEqual([
      'submit [{"kind":"go","objectId":"bookshelf"}]',
      'after reach the bookshelf',
      'gesture echo {move:pulls a book from the shelf and reads}',
    ]);
    // Not yet: the walk has not finished.
    expect(deps.arrived).not.toHaveBeenCalled();
    afterCallbacks[0]();
    expect(deps.arrived).toHaveBeenCalledWith('use-1');
  });

  it("queues it on the right avatar's executor", () => {
    const sage = setup().executor;
    const { deps } = setup({ executorFor: (id) => (id === 'sage' ? sage : null) });
    handleStationUse({ ...start, avatarId: 'sage' }, deps);
    expect(sage.submit).toHaveBeenCalled();
    expect(deps.gesture).toHaveBeenCalledWith(expect.any(String), 'sage');
  });

  it('answers arrived at once when it cannot walk', () => {
    const cases: Array<[string, Partial<StationWalkDeps>, boolean?]> = [
      ['no 3D room', { room: () => null }],
      ['another room', { room: () => studio }],
      ['avatar is in another place', { isHere: () => false }],
      ['no such avatar here', { executorFor: () => null }],
      ['no body or room to walk with', {}, false],
    ];
    for (const [, overrides, hasWorld] of cases) {
      const { deps, executor } = setup(overrides, hasWorld ?? true);
      handleStationUse(start, deps);
      expect(deps.arrived).toHaveBeenCalledWith('use-1');
      expect(executor.submit).not.toHaveBeenCalled();
      expect(deps.gesture).not.toHaveBeenCalled();
    }
  });

  it('answers arrived when the object is not in the room', () => {
    const { deps } = setup();
    handleStationUse({ ...start, objectId: 'ghost' }, deps);
    expect(deps.arrived).toHaveBeenCalledWith('use-1');
  });

  it('does nothing at the end of the use', () => {
    const { deps, calls } = setup();
    handleStationUse({ ...start, phase: 'end', ok: true }, deps);
    expect(calls).toEqual([]);
    expect(deps.arrived).not.toHaveBeenCalled();
  });

  it('answers arrived when queueing the walk throws', () => {
    const { deps, executor } = setup();
    vi.mocked(executor.submit).mockImplementation(() => {
      throw new Error('boom');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    handleStationUse(start, deps);
    expect(deps.arrived).toHaveBeenCalledWith('use-1');
    warn.mockRestore();
  });

  describe('a pursuit moving on to its next step', () => {
    const activity: StationUseEvent = { ...start, phase: 'activity', activity: 'jots down notes' };

    it('acts the new activity where the avatar stands, without walking or answering', () => {
      const { deps, executor, calls } = setup();
      handleStationUse(activity, deps);
      expect(calls).toEqual(['gesture echo {move:jots down notes}']);
      expect(executor.submit).not.toHaveBeenCalled();
      expect(deps.arrived).not.toHaveBeenCalled();
    });

    it('does nothing in another room, for an avatar that is elsewhere, or without a body', () => {
      for (const overrides of [{ room: () => studio }, { isHere: () => false }] as Array<Partial<StationWalkDeps>>) {
        const { deps, calls } = setup(overrides);
        handleStationUse(activity, deps);
        expect(calls).toEqual([]);
      }
      const noBody = setup({}, false);
      handleStationUse(activity, noBody.deps);
      expect(noBody.calls).toEqual([]);
    });

    it('cannot slip a tag into the gesture', () => {
      const { deps, calls } = setup();
      handleStationUse({ ...activity, activity: 'reads {go:door}' }, deps);
      expect(calls).toEqual(['gesture echo {move:reads go:door}']);
    });
  });
});
