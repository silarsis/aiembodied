import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLACES_KEY, PlaceManager } from '../../src/places/place-manager.js';
import { doorbellOn } from '../../src/places/doorbell-setting.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];

function setup(activeAt: Record<string, number> = {}) {
  const data = new Map<string, string>();
  const clock = { now: 1_000_000 };
  const manager = new PlaceManager({
    store: { getValue: (key) => data.get(key) ?? null, setValue: (key, value) => void data.set(key, value) },
    registry: { list: () => PROFILES },
    now: () => clock.now,
    activeAt: (placeId) => activeAt[placeId] ?? null,
  });
  return { manager, data, clock };
}

describe('PlaceManager for wandering', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('notes when each avatar last arrived, on its own clock, and puts it in the snapshot', () => {
    const { manager, clock } = setup();
    expect(manager.snapshot().movedAt).toEqual({});
    clock.now = 2_000_000;
    manager.startMove('sage', 'next-door', 'chose to');
    // Not arrived yet: in the hallway.
    expect(manager.snapshot().movedAt).toEqual({});
    clock.now = 2_001_500;
    vi.advanceTimersByTime(1500);
    expect(manager.snapshot()).toMatchObject({ now: 2_001_500, movedAt: { sage: 2_001_500 } });
  });

  it('puts the PCs that were used lately in the snapshot, only for places it has heard of', () => {
    const { manager } = setup({ home: 999_000 });
    expect(manager.snapshot().activeAt).toEqual({ home: 999_000 });
  });

  it('marks a closed desktop room in the snapshot', () => {
    const { manager } = setup();
    manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    manager.setOnline('study', true);
    expect(manager.snapshot().places.find((place) => place.id === 'study')).not.toHaveProperty('closed');
    manager.setClosed('study', true);
    expect(manager.snapshot().places.find((place) => place.id === 'study')?.closed).toBe(true);
  });

  it('keeps the doorbell setting only when it was changed, and never for next door', () => {
    const { manager, data } = setup();
    manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    expect(doorbellOn(manager.get('home'))).toBe(true);
    expect(doorbellOn(manager.get('study'))).toBe(false);
    expect(doorbellOn(manager.get('next-door'))).toBe(false);
    expect(JSON.parse(data.get(PLACES_KEY) as string).some((place: object) => 'doorbell' in place)).toBe(false);
    expect(manager.setDoorbell('study', true)).toBe(true);
    expect(manager.setDoorbell('home', false)).toBe(true);
    expect(manager.setDoorbell('next-door', true)).toBe(false);
    expect(manager.setDoorbell('nowhere', true)).toBe(false);
    expect(doorbellOn(manager.get('study'))).toBe(true);
    expect(doorbellOn(manager.get('home'))).toBe(false);
    expect(manager.snapshot().places.find((place) => place.id === 'study')?.doorbell).toBe(true);
    // Saved, and read back by a new manager.
    const again = new PlaceManager({ store: { getValue: (key) => data.get(key) ?? null, setValue: (key, value) => void data.set(key, value) }, registry: { list: () => PROFILES } });
    expect(doorbellOn(again.get('study'))).toBe(true);
    expect(doorbellOn(again.get('home'))).toBe(false);
  });
});
