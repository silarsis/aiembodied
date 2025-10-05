import { describe, expect, it } from 'vitest';
import { LatencyTracker } from '../../src/metrics/latency-tracker.js';

describe('LatencyTracker', () => {
  it('records wake to capture latency', () => {
    const tracker = new LatencyTracker();
    tracker.beginCycle(1000, 'session-1');

    const snapshot = tracker.recordCapture(1600, 'session-1');

    expect(snapshot).toEqual({ wakeToCaptureMs: 600 });
    expect(tracker.getLastSnapshot()).toEqual({ wakeToCaptureMs: 600 });
  });

  it('records capture to first audio and wake to first audio latencies', () => {
    const tracker = new LatencyTracker();
    tracker.beginCycle(500, 'session-2');
    tracker.recordCapture(900, 'session-2');

    const snapshot = tracker.recordFirstAudio(1500, 'session-2');

    expect(snapshot).toEqual({ captureToFirstAudioMs: 600, wakeToFirstAudioMs: 1000 });
    expect(tracker.getLastSnapshot()).toEqual({
      wakeToCaptureMs: 400,
      captureToFirstAudioMs: 600,
      wakeToFirstAudioMs: 1000,
    });
  });

  it('ignores events for mismatched session ids', () => {
    const tracker = new LatencyTracker();
    tracker.beginCycle(0, 'session-a');

    const capture = tracker.recordCapture(200, 'session-b');
    const audio = tracker.recordFirstAudio(400, 'session-b');

    expect(capture).toBeNull();
    expect(audio).toBeNull();
    expect(tracker.getLastSnapshot()).toBeNull();
  });
});
