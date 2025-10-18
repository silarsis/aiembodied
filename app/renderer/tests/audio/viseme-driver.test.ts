import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisemeDriver, type VisemeFrame } from '../../src/audio/viseme-driver.js';

class StubAnalyser implements Pick<AnalyserNode, 'fftSize' | 'getFloatTimeDomainData'> {
  public fftSize: number;

  private readonly frames: Float32Array[];

  private index = 0;

  constructor(frames: number[][]) {
    this.frames = frames.map((values) => Float32Array.from(values));
    this.fftSize = this.frames[0]?.length ?? 32;
  }

  getFloatTimeDomainData(target: Float32Array): void {
    const current = this.frames[Math.min(this.index, this.frames.length - 1)];
    target.set(current);
    this.index += 1;
  }
}

function createScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  return {
    request(callback: FrameRequestCallback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id: number) {
      callbacks.delete(id);
    },
    flush(time: number) {
      const entries = Array.from(callbacks.values());
      callbacks.clear();
      for (const callback of entries) {
        callback(time);
      }
    },
    hasPending() {
      return callbacks.size > 0;
    },
  };
}

describe('VisemeDriver', () => {
  const originalError = console.error;

  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalError;
  });

  it('emits smoothed viseme frames from analyser samples', async () => {
    const scheduler = createScheduler();
    let current = 0;
    const now = () => current;
    const analyser = new StubAnalyser([
      new Array(64).fill(0),
      new Array(64).fill(0.5),
      new Array(64).fill(0.1),
    ]);

    const frames: VisemeFrame[] = [];
    const driver = new VisemeDriver(
      {
        onFrame: (frame) => {
          frames.push(frame);
        },
      },
      {
        scheduler,
        now,
        noiseFloor: 0,
        intensityExponent: 1,
        attackMs: 30,
        releaseMs: 60,
        thresholds: [0.2, 0.4, 0.6, 0.8],
      },
    );

    await driver.setAnalyser(analyser);
    driver.start();

    scheduler.flush(current);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.intensity).toBeCloseTo(0);
    expect(frames[0]?.index).toBe(0);

    current += 16;
    scheduler.flush(current);
    expect(frames).toHaveLength(2);
    expect(frames[1]?.intensity ?? 0).toBeGreaterThan(0.3);
    expect(frames[1]?.intensity ?? 0).toBeLessThan(0.8);
    expect(frames[1]?.index).toBeGreaterThan(0);

    current += 16;
    scheduler.flush(current);
    expect(frames).toHaveLength(3);
    expect(frames[2]?.intensity ?? 0).toBeLessThan(frames[1]?.intensity ?? 0);

    await driver.destroy();
  });

  it('triggers blink events when intensity stays low', async () => {
    const scheduler = createScheduler();
    let current = 0;
    const now = () => current;
    const analyser = new StubAnalyser([new Array(64).fill(0)]);

    const onFrame = vi.fn();
    const driver = new VisemeDriver(
      {
        onFrame,
      },
      {
        scheduler,
        now,
        noiseFloor: 0,
        intensityExponent: 1,
        blinkIntervalRangeMs: [50, 50],
        blinkMaxIntensity: 0.3,
        attackMs: 10,
        releaseMs: 10,
      },
    );

    await driver.setAnalyser(analyser);
    driver.start();

    const timestamps = [0, 50, 100, 150, 200, 250];
    for (const timestamp of timestamps) {
      current = timestamp;
      scheduler.flush(current);
    }

    const blinked = onFrame.mock.calls.some((call) => call[0]?.blink === true);
    expect(blinked).toBe(true);

    await driver.destroy();
  });

  it('stops emitting frames after stop is called', async () => {
    const scheduler = createScheduler();
    let current = 0;
    const now = () => current;
    const analyser = new StubAnalyser([new Array(64).fill(0.25)]);

    const frames: VisemeFrame[] = [];
    const driver = new VisemeDriver(
      {
        onFrame: (frame) => {
          frames.push(frame);
        },
      },
      {
        scheduler,
        now,
        noiseFloor: 0,
        intensityExponent: 1,
        attackMs: 10,
        releaseMs: 10,
      },
    );

    await driver.setAnalyser(analyser);
    driver.start();

    scheduler.flush(current);
    expect(frames).toHaveLength(1);

    driver.stop();
    const emitted = frames.length;

    current += 16;
    scheduler.flush(current);
    expect(frames).toHaveLength(emitted);

    await driver.destroy();
  });
});
