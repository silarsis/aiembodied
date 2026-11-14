import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATIONS_KEY, PlaceManager, scopedPlaces } from '../../src/places/place-manager.js';
import { createDoorbell, wakeShouldListen } from '../../src/places/doorbell.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];

function setup(locations: Record<string, string> = {}) {
  const data = new Map<string, string>([[LOCATIONS_KEY, JSON.stringify(locations)]]);
  const places = new PlaceManager({
    store: { getValue: (key) => data.get(key) ?? null, setValue: (key, value) => void data.set(key, value) },
    registry: { list: () => PROFILES },
  });
  return places;
}

describe('wakeShouldListen (bija)', () => {
  it('listens while an avatar is here, whatever the doorbell says', () => {
    const places = setup();
    expect(wakeShouldListen(places, 'home')).toBe(true);
    places.setDoorbell('home', false);
    expect(wakeShouldListen(places, 'home')).toBe(true);
  });

  it('listens with nobody here while the doorbell is on (the default on bija)', () => {
    const places = setup({ echo: 'next-door', sage: 'next-door' });
    expect(wakeShouldListen(places, 'home')).toBe(true);
  });

  it('stops with the doorbell off and nobody here, and resumes when an avatar is here', () => {
    const places = setup({ echo: 'next-door', sage: 'next-door' });
    places.setDoorbell('home', false);
    expect(wakeShouldListen(places, 'home')).toBe(false);
    places.startMove('echo', 'home', 'summoned');
    // Walking in does not count as being here.
    expect(wakeShouldListen(places, 'home')).toBe(false);
    places.arrived('echo');
    expect(wakeShouldListen(places, 'home')).toBe(true);
  });
});

describe('createDoorbell', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function bell(places: PlaceManager, placeId = 'home', partner: string | null = null) {
    return createDoorbell({ places: scopedPlaces(places, placeId), placeId, partner: () => partner, avatarIds: () => PROFILES.map((profile) => profile.id) });
  }

  it('with somebody here the wake word is simply heard', async () => {
    const places = setup();
    const heard = vi.fn();
    await expect(bell(places).onWake(heard)).resolves.toBe('here');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(places.snapshot().transit).toEqual([]);
  });

  it('with nobody here it calls the partner over, and the turn starts once the avatar has arrived', async () => {
    const places = setup({ echo: 'next-door', sage: 'next-door' });
    const heard = vi.fn();
    const result = bell(places, 'home', 'sage').onWake(heard);
    await vi.advanceTimersByTimeAsync(2000);
    expect(places.snapshot().transit).toEqual([{ avatarId: 'sage', from: 'next-door', to: 'home' }]);
    expect(heard).not.toHaveBeenCalled();
    places.arrived('sage');
    await expect(result).resolves.toBe('arrived');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(places.locationOf('sage')).toBe('home');
  });

  it('calls Echo when there is no recent partner', async () => {
    const places = setup({ echo: 'next-door', sage: 'next-door' });
    void bell(places).onWake();
    await vi.advanceTimersByTimeAsync(0);
    expect(places.snapshot().transit).toEqual([{ avatarId: 'echo', from: 'next-door', to: 'home' }]);
  });

  it('does nothing with the doorbell off and nobody here', async () => {
    const places = setup({ echo: 'next-door', sage: 'next-door' });
    places.setDoorbell('home', false);
    const heard = vi.fn();
    await expect(bell(places).onWake(heard)).resolves.toBe('off');
    expect(heard).not.toHaveBeenCalled();
    expect(places.snapshot().transit).toEqual([]);
  });

  it('ignores a second ring while the avatar is on its way, and does not start the turn if nobody came', async () => {
    const places = setup({ echo: 'next-door', sage: 'next-door' });
    const doorbell = bell(places);
    const heard = vi.fn();
    const first = doorbell.onWake(heard);
    await vi.advanceTimersByTimeAsync(10);
    await expect(doorbell.onWake(heard)).resolves.toBe('busy');
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(first).resolves.toBe('failed');
    expect(heard).not.toHaveBeenCalled();
  });

  it('wake.heard from a satellite summons into that place; audio never matters, only the doorbell setting', async () => {
    const places = setup({ echo: 'next-door', sage: 'next-door' });
    places.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    places.setOnline('study', true);
    const study = bell(places, 'study');
    // Off by default for a desktop room: nothing happens.
    await expect(study.onWake()).resolves.toBe('off');
    expect(places.snapshot().transit).toEqual([]);
    places.setDoorbell('study', true);
    const result = study.onWake();
    await vi.advanceTimersByTimeAsync(0);
    expect(places.snapshot().transit).toEqual([{ avatarId: 'echo', from: 'next-door', to: 'study' }]);
    places.arrived('echo');
    await expect(result).resolves.toBe('arrived');
    expect(places.avatarsAt('study')).toEqual(['echo']);
    // With an avatar in the room the same message is just heard.
    await expect(study.onWake()).resolves.toBe('here');
  });

  it('does not call anyone into a closed room', async () => {
    const places = setup({ echo: 'next-door', sage: 'next-door' });
    places.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    places.setOnline('study', true);
    places.setDoorbell('study', true);
    places.setClosed('study', true);
    await expect(bell(places, 'study').onWake()).resolves.toBe('failed');
    expect(places.snapshot().transit).toEqual([]);
  });
});
