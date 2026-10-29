import { describe, expect, it } from 'vitest';
import { PEAK_FLOOR, PEAK_QUIET_FRAMES, PeakTracker } from '../src/wake-word/peak-tracker.js';

describe('PeakTracker', () => {
  it('ignores scores that never reach the floor', () => {
    const tracker = new PeakTracker();
    for (let i = 0; i < 20; i += 1) {
      expect(tracker.push(PEAK_FLOOR / 2, i)).toBeNull();
    }
  });

  it('reports the highest score of a burst once it has been quiet long enough', () => {
    const tracker = new PeakTracker();
    expect(tracker.push(0.1, 1)).toBeNull();
    expect(tracker.push(0.42, 2)).toBeNull();
    expect(tracker.push(0.3, 3)).toBeNull();
    for (let i = 1; i < PEAK_QUIET_FRAMES; i += 1) {
      expect(tracker.push(0, 3 + i)).toBeNull();
    }
    expect(tracker.push(0, 100)).toEqual({ score: 0.42, timestamp: 2 });
    // The burst is over: more quiet reports nothing.
    expect(tracker.push(0, 101)).toBeNull();
  });

  it('keeps one burst going across short dips below the floor', () => {
    const tracker = new PeakTracker();
    tracker.push(0.2, 1);
    tracker.push(0, 2);
    tracker.push(0.6, 3);
    let result = null;
    for (let i = 0; i < PEAK_QUIET_FRAMES && !result; i += 1) {
      result = tracker.push(0, 4 + i);
    }
    expect(result).toEqual({ score: 0.6, timestamp: 3 });
  });
});
