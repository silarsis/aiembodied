import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATIONS_KEY, PlaceManager } from '../../src/places/place-manager.js';
import { NEXT_DOOR_TICK_MS, NextDoorReturn, RETURN_CHANCE } from '../../src/places/next-door-return.js';
import { CONVERSATION_MS, WANDER_COOLDOWN_MS } from '../../src/places/wander.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];

function setup(options: { locations?: Record<string, string>; activeAt?: Record<string, number>; level?: 'calm' | 'normal' | 'restless' | null; talked?: number | null; roll?: number } = {}) {
  const data = new Map<string, string>([[LOCATIONS_KEY, JSON.stringify(options.locations ?? { sage: 'next-door' })]]);
  const clock = { now: 5_000_000 };
  const activeAt = options.activeAt ?? { home: clock.now - 30_000 };
  const places = new PlaceManager({
    store: { getValue: (key) => data.get(key) ?? null, setValue: (key, value) => void data.set(key, value) },
    registry: { list: () => PROFILES },
    now: () => clock.now,
    activeAt: (placeId) => activeAt[placeId] ?? null,
  });
  const rng = vi.fn(() => options.roll ?? 0);
  const tick = new NextDoorReturn({
    places,
    restlessness: () => (options.level === undefined ? 'normal' : options.level),
    talkedAgoMs: () => options.talked ?? null,
    rng,
  });
  return { places, tick, rng, clock, activeAt };
}

describe('NextDoorReturn', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('brings an avatar back from next door when the die comes up and someone used the PC', () => {
    const { places, tick } = setup({ roll: RETURN_CHANCE.normal - 0.001 });
    expect(tick.tick()).toEqual({ avatarId: 'sage', placeId: 'home' });
    expect(places.snapshot().transit).toEqual([{ avatarId: 'sage', from: 'next-door', to: 'home' }]);
  });

  it('stays next door when the die does not come up', () => {
    const { places, tick, rng } = setup({ roll: RETURN_CHANCE.normal });
    expect(tick.tick()).toBeNull();
    expect(rng).toHaveBeenCalledTimes(1);
    expect(places.snapshot().transit).toEqual([]);
  });

  it('uses a bigger chance for a more restless avatar', () => {
    expect(RETURN_CHANCE.calm).toBeLessThan(RETURN_CHANCE.normal);
    expect(RETURN_CHANCE.normal).toBeLessThan(RETURN_CHANCE.restless);
    const { tick } = setup({ level: 'restless', roll: RETURN_CHANCE.restless - 0.001 });
    expect(tick.tick()).not.toBeNull();
    const calm = setup({ level: 'calm', roll: RETURN_CHANCE.normal - 0.001 });
    expect(calm.tick.tick()).toBeNull();
  });

  it('does nothing, and does not roll, when wandering is off', () => {
    const { tick, rng } = setup({ level: null });
    expect(tick.tick()).toBeNull();
    expect(rng).not.toHaveBeenCalled();
  });

  it('does not roll when nobody could come: no PC used lately, nobody anywhere else', () => {
    const { tick, rng } = setup({ activeAt: {}, locations: { echo: 'next-door', sage: 'next-door' } });
    expect(tick.tick()).toBeNull();
    expect(rng).not.toHaveBeenCalled();
  });

  it('does not bring back an avatar that moved in the last 10 minutes, then does after', () => {
    const { places, tick, clock, activeAt } = setup({ locations: { sage: 'home' } });
    places.startMove('sage', 'next-door', 'chose to');
    clock.now += 1500;
    vi.advanceTimersByTime(1500);
    expect(places.locationOf('sage')).toBe('next-door');
    activeAt.home = clock.now - 1000;
    expect(tick.tick()).toBeNull();
    clock.now += WANDER_COOLDOWN_MS;
    activeAt.home = clock.now - 1000;
    expect(tick.tick()).toEqual({ avatarId: 'sage', placeId: 'home' });
  });

  it('keeps an avatar next door that Kevin just talked with', () => {
    expect(setup({ talked: CONVERSATION_MS - 1 }).tick.tick()).toBeNull();
    expect(setup({ talked: CONVERSATION_MS }).tick.tick()).not.toBeNull();
  });

  it('does not go to a closed or offline desktop room', () => {
    const { places, tick } = setup({ activeAt: { study: 5_000_000 - 1000 }, locations: { echo: 'next-door', sage: 'next-door' } });
    places.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    expect(tick.tick()).toBeNull();
    places.setOnline('study', true);
    places.setClosed('study', true);
    expect(tick.tick()).toBeNull();
    places.setClosed('study', false);
    expect(tick.tick()).toEqual({ avatarId: 'echo', placeId: 'study' });
  });

  it('prefers the place that was used most recently', () => {
    const { places, tick } = setup({ activeAt: { home: 5_000_000 - 200_000, study: 5_000_000 - 20_000 } });
    places.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    places.setOnline('study', true);
    expect(tick.tick()).toEqual({ avatarId: 'sage', placeId: 'study' });
  });

  it('rolls once a minute on the injected timer', () => {
    const handles: Array<() => void> = [];
    const intervals: number[] = [];
    const cleared: unknown[] = [];
    const places = setup().places;
    const loop = new NextDoorReturn({
      places,
      restlessness: () => 'normal',
      talkedAgoMs: () => null,
      setInterval: (fn, ms) => (handles.push(fn), intervals.push(ms), handles.length),
      clearInterval: (handle) => void cleared.push(handle),
    });
    loop.start();
    loop.start();
    expect(intervals).toEqual([NEXT_DOOR_TICK_MS]);
    loop.stop();
    expect(cleared).toEqual([1]);
  });
});
