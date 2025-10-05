import { describe, expect, it } from 'vitest';
import { calculateRms, normalizeAudioLevel } from '../../src/audio/metrics.js';

describe('audio metrics helpers', () => {
  it('computes the root mean square value for samples', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const rms = calculateRms(samples);

    expect(rms).toBeGreaterThan(0);
    expect(rms).toBeLessThanOrEqual(1);
  });

  it('normalizes audio level into perceptual scale', () => {
    expect(normalizeAudioLevel(0)).toBe(0);
    expect(normalizeAudioLevel(0.25)).toBeCloseTo(0.5, 2);
    expect(normalizeAudioLevel(4)).toBe(1);
  });
});
