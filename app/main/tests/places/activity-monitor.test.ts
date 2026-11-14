import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_BELOW_IDLE_SECONDS, ACTIVITY_POLL_MS, ActivityMonitor } from '../../src/presence/activity-monitor.js';
import { PlacePresence } from '../../src/presence/place-presence.js';

function setup(idle: () => number) {
  const clock = { now: 1000 };
  const onActive = vi.fn();
  const handles: Array<() => void> = [];
  const intervals: number[] = [];
  const cleared: unknown[] = [];
  const monitor = new ActivityMonitor({
    idleSeconds: idle,
    onActive,
    now: () => clock.now,
    setInterval: (fn, ms) => (handles.push(fn), intervals.push(ms), handles.length),
    clearInterval: (handle) => void cleared.push(handle),
  });
  return { monitor, onActive, clock, handles, intervals, cleared };
}

describe('ActivityMonitor', () => {
  it('counts the PC as in use when the idle time is under 60 seconds', () => {
    let idle = 5;
    const { monitor, onActive, clock } = setup(() => idle);
    monitor.poll();
    expect(onActive).toHaveBeenLastCalledWith(1000);
    expect(monitor.activeAt).toBe(1000);
    idle = ACTIVE_BELOW_IDLE_SECONDS;
    clock.now = 2000;
    monitor.poll();
    expect(onActive).toHaveBeenCalledTimes(1);
    expect(monitor.activeAt).toBe(1000);
    idle = ACTIVE_BELOW_IDLE_SECONDS - 1;
    clock.now = 3000;
    monitor.poll();
    expect(onActive).toHaveBeenLastCalledWith(3000);
  });

  it('polls now and then every 15 seconds, and stops', () => {
    const { monitor, onActive, handles, intervals, cleared } = setup(() => 0);
    monitor.start();
    monitor.start();
    expect(intervals).toEqual([ACTIVITY_POLL_MS]);
    expect(ACTIVITY_POLL_MS).toBe(15_000);
    expect(onActive).toHaveBeenCalledTimes(1);
    handles[0]();
    expect(onActive).toHaveBeenCalledTimes(2);
    monitor.stop();
    expect(cleared).toEqual([1]);
  });

  it('treats a failing or nonsense idle time as not active', () => {
    for (const idle of [() => Number.NaN, () => { throw new Error('no power monitor'); }, () => -1 / 0]) {
      const { monitor, onActive } = setup(idle);
      expect(() => monitor.poll()).not.toThrow();
      expect(onActive).not.toHaveBeenCalled();
    }
  });
});

describe('a satellite\'s activity', () => {
  it('is stamped with bija\'s clock when it arrives, whatever the satellite\'s clock says', () => {
    const presence = new PlacePresence(() => 777);
    presence.onSatelliteOp('study', { op: 'presence', activeAt: 12 });
    expect(presence.get('study')?.activeAt).toBe(777);
  });
});
