import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_SETTINGS } from '../../../main/src/rooms/idle-settings.js';
import { FIRST_ACTION_DELAY_MS, type IdleExecutor } from '../../src/rooms/idle-director.js';
import { INITIAL_STATE } from '../../src/rooms/scene-actions.js';
import { useIdleDirector, type UseIdleDirectorOptions } from '../../src/rooms/use-idle-director.js';
import { builtInRoom } from './fixtures.js';

const room = builtInRoom('reading-room');

function executor(): IdleExecutor {
  return {
    busy: false,
    getState: () => INITIAL_STATE,
    world: () => ({
      room,
      hasNavigation: true,
      findPath: () => null,
      closestWalkable: (p) => p,
      objectPosition: () => null,
      frame: { origin: { x: 0, z: -0.3, yaw: 0 }, scale: 1 },
      restHipsHeight: 0.95,
      cameraAspect: 21 / 9,
    }),
    submitPlan: vi.fn(),
    onInterrupt: () => () => undefined,
  };
}

describe('useIdleDirector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs idle actions and hands the log to the conversation, but not in the middle of a response', async () => {
    const run = vi.fn();
    const exec = executor();
    const base: UseIdleDirectorOptions = {
      executor: exec,
      room,
      settings: DEFAULT_IDLE_SETTINGS,
      motionReady: true,
      persona: { name: 'Mei', personality: '', habits: '' },
      phase: 'waiting',
      pick: async () => ({ text: '{sit:sofa}' }),
      run,
    };
    const { result, rerender, unmount } = renderHook((props: UseIdleDirectorOptions) => useIdleDirector(props), { initialProps: base });
    expect(result.current.idleNote).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_ACTION_DELAY_MS);
    });
    expect(run).toHaveBeenCalledWith('{sit:sofa}');
    expect(result.current.idleNote).toBe('sat down on the sofa');

    // The assistant starts answering: the note is kept as it was, and the director stays quiet.
    rerender({ ...base, phase: 'responding' });
    expect(result.current.idleNote).toBe('sat down on the sofa');

    // Leaving the room clears the note; going back to 2D has no idle summary.
    rerender({ ...base, room: null });
    expect(result.current.idleNote).toBe('');
    unmount();
  });

  it('does not start anything when wandering is off', async () => {
    const pick = vi.fn(async () => ({ text: '{sit:sofa}' }));
    const exec = executor();
    renderHook(() =>
      useIdleDirector({
        executor: exec,
        room,
        settings: { ...DEFAULT_IDLE_SETTINGS, enabled: false },
        motionReady: true,
        persona: { name: 'Mei', personality: '', habits: '' },
        phase: 'waiting',
        pick,
        run: vi.fn(),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_ACTION_DELAY_MS * 3);
    });
    expect(pick).not.toHaveBeenCalled();
  });
});
