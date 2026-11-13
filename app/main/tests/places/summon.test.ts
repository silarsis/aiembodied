import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HALLWAY_MS, LOCATIONS_KEY, MOVE_DEADLINE_MS, PlaceManager } from '../../src/places/place-manager.js';
import { chooseSummon, summon } from '../../src/places/summon.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];

function setup(locations: Record<string, string> = {}) {
  const kv = new Map<string, string>([[LOCATIONS_KEY, JSON.stringify(locations)]]);
  return new PlaceManager({ store: { getValue: (key) => kv.get(key) ?? null, setValue: (key, value) => void kv.set(key, value) }, registry: { list: () => PROFILES } });
}

describe('summon', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is immediate for an avatar that is here', async () => {
    const places = setup();
    await expect(summon(places, 'echo')).resolves.toBe(true);
    expect(places.inTransit('echo')).toBe(false);
  });

  it('moves the avatar to this PC and waits until the renderer confirms', async () => {
    const places = setup({ sage: 'next-door' });
    let done: boolean | null = null;
    void summon(places, 'sage').then((value) => (done = value));
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBeNull();
    expect(places.snapshot().transit).toEqual([{ avatarId: 'sage', from: 'next-door', to: 'home' }]);
    places.arrived('sage');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('gives up when the avatar does not arrive', async () => {
    const places = setup({ sage: 'next-door' });
    const result = summon(places, 'sage');
    await vi.advanceTimersByTimeAsync(MOVE_DEADLINE_MS);
    await expect(result).resolves.toBe(false);
    expect(places.isPresent('sage')).toBe(false);
  });

  it('waits for an avatar already walking in', async () => {
    const places = setup({ sage: 'next-door' });
    places.startMove('sage', 'home', 'called');
    const result = summon(places, 'sage');
    places.arrived('sage');
    await expect(result).resolves.toBe(true);
  });

  it('lets an avatar that is walking out get there, then calls it back', async () => {
    const places = setup();
    places.startMove('sage', 'next-door', 'chose to');
    const result = summon(places, 'sage');
    await vi.advanceTimersByTimeAsync(HALLWAY_MS);
    expect(places.snapshot().transit).toEqual([{ avatarId: 'sage', from: 'next-door', to: 'home' }]);
    places.arrived('sage');
    await expect(result).resolves.toBe(true);
  });

  it('fails for an unknown avatar', async () => {
    await expect(summon(setup(), 'ghost')).resolves.toBe(false);
  });
});

describe('chooseSummon', () => {
  it('prefers the avatar Kevin last talked with, then Echo, then the first', () => {
    expect(chooseSummon('sage', ['echo', 'sage'])).toBe('sage');
    expect(chooseSummon(null, ['sage', 'echo'])).toBe('echo');
    expect(chooseSummon('gone', ['sage', 'rex'])).toBe('sage');
    expect(chooseSummon(null, [])).toBeNull();
  });
});
