import { describe, expect, it } from 'vitest';
import { VRMExpressionPresetName } from '@pixiv/three-vrm';
import { clamp01, mapVisemeToPreset, smoothWeight } from '../../src/avatar/vrm-avatar-renderer.js';

describe('mapVisemeToPreset', () => {
  it('maps discrete indices to blend shape presets', () => {
    expect(mapVisemeToPreset(0)).toBe(VRMExpressionPresetName.Aa);
    expect(mapVisemeToPreset(4)).toBe(VRMExpressionPresetName.Oh);
  });

  it('returns null for unknown indices', () => {
    expect(mapVisemeToPreset(-1)).toBeNull();
    expect(mapVisemeToPreset(99)).toBeNull();
    expect(mapVisemeToPreset(undefined)).toBeNull();
  });
});

describe('clamp01', () => {
  it('forces values into the 0..1 range', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.2)).toBe(0.2);
    expect(clamp01(12)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe('smoothWeight', () => {
  it('smoothly approaches the target intensity', () => {
    const rising = smoothWeight(0, 1, 0.2, 10, 5);
    expect(rising).toBeGreaterThan(0);
    expect(rising).toBeLessThanOrEqual(1);

    const falling = smoothWeight(1, 0, 0.2, 10, 5);
    expect(falling).toBeLessThan(1);
    expect(falling).toBeGreaterThanOrEqual(0);
  });

  it('returns the current value when time does not progress', () => {
    expect(smoothWeight(0.4, 1, 0, 10, 5)).toBeCloseTo(0.4, 5);
  });
});
