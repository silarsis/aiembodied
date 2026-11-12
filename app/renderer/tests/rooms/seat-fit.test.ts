import { describe, expect, it } from 'vitest';
import {
  BUTTOCKS_BELOW_HIPS,
  MAX_SEAT_OFFSET,
  easeOffset,
  seatOffsetTarget,
  seatedContactY,
} from '../../src/rooms/seat-fit.js';

describe('seat fit arithmetic', () => {
  it('puts the contact below the hips in proportion to the avatar', () => {
    expect(seatedContactY(1, 0.95)).toBeCloseTo(1 - BUTTOCKS_BELOW_HIPS, 9);
    expect(seatedContactY(1, 1.9)).toBeCloseTo(1 - 2 * BUTTOCKS_BELOW_HIPS, 9);
    expect(seatedContactY(1, 0.95, 2)).toBeCloseTo(1 - 2 * BUTTOCKS_BELOW_HIPS, 9);
    expect(seatedContactY(1, 0)).toBeCloseTo(1 - BUTTOCKS_BELOW_HIPS, 9);
  });

  it('lifts a sunken avatar and lowers a floating one, and clamps', () => {
    expect(seatOffsetTarget(0.4, 0.5, 0)).toBeCloseTo(0.1, 9);
    expect(seatOffsetTarget(0.6, 0.5, 0)).toBeCloseTo(-0.1, 9);
    expect(seatOffsetTarget(0, 5, 0)).toBe(MAX_SEAT_OFFSET);
    expect(seatOffsetTarget(5, 0, 0)).toBe(-MAX_SEAT_OFFSET);
  });

  it('does not accumulate: the applied offset is taken out of the measurement', () => {
    // After applying the 0.1 offset the contact reads 0.5; the target stays 0.1.
    expect(seatOffsetTarget(0.5, 0.5, 0.1)).toBeCloseTo(0.1, 9);
  });

  it('eases towards the target and settles exactly', () => {
    let value = 0;
    value = easeOffset(value, 0.2, 0.1);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(0.2);
    for (let i = 0; i < 100; i += 1) value = easeOffset(value, 0.2, 1 / 60);
    expect(value).toBe(0.2);
    expect(easeOffset(0.1, 0.2, 0)).toBe(0.1);
  });
});
