import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATIONS_KEY, PlaceManager } from '../../src/places/place-manager.js';
import { PlaceDevices, FULLSCREEN_HOME_MS, LOCKED_HOME_MS } from '../../src/room-hub/place-devices.js';
import { PlacePresence } from '../../src/presence/place-presence.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];

/** A closed, locked or full-screen room sends its avatars home, and they walk in through bija's door (the renderer confirms). */
describe('rooms closing send avatars home through bija\'s door', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const data = new Map<string, string>([[LOCATIONS_KEY, JSON.stringify({ echo: 'study', sage: 'study' })]]);
    const places = new PlaceManager({
      store: { getValue: (key) => data.get(key) ?? null, setValue: (key, value) => void data.set(key, value) },
      registry: { list: () => PROFILES },
    });
    places.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    places.setOnline('study', true);
    const devices = new PlaceDevices({ places, presence: new PlacePresence() });
    const arrivals: Array<[string, string]> = [];
    places.onArrived((avatarId, placeId) => arrivals.push([avatarId, placeId]));
    const state = (patch: object) => devices.onMessage('study', { op: 'device.state', mic: 'off', camera: 'off', speakers: 'live', locked: false, closed: false, fullscreen: false, ...patch });
    const expectHomeThroughTheDoor = () => {
      // In transit towards the local place (the lounge): confirmed by the renderer once the body stands at the door.
      expect(places.snapshot().transit.map((move) => move.to)).toEqual(['home', 'home']);
      expect(places.avatarsAt('home')).toEqual([]);
      places.arrived('echo');
      places.arrived('sage');
      expect(places.avatarsAt('home')).toEqual(['echo', 'sage']);
      expect(arrivals).toEqual([['echo', 'home'], ['sage', 'home']]);
    };
    return { places, state, devices, expectHomeThroughTheDoor, data };
  }

  it('closing the room (the kill switch)', () => {
    const t = setup();
    t.devices.onMessage('study', { op: 'room.close' });
    expect(t.places.startMove('echo', 'study', 'chose to')).toMatchObject({ ok: false });
    t.expectHomeThroughTheDoor();
  });

  it('a screen locked for 5 minutes', () => {
    const t = setup();
    t.state({ locked: true });
    vi.advanceTimersByTime(LOCKED_HOME_MS - 1);
    expect(t.places.snapshot().transit).toEqual([]);
    vi.advanceTimersByTime(1);
    t.expectHomeThroughTheDoor();
  });

  it('a full-screen app for 2 minutes, but not if it ends first', () => {
    const t = setup();
    t.state({ fullscreen: true });
    vi.advanceTimersByTime(FULLSCREEN_HOME_MS - 1000);
    t.state({ fullscreen: false });
    vi.advanceTimersByTime(FULLSCREEN_HOME_MS);
    expect(t.places.snapshot().transit).toEqual([]);
    t.state({ fullscreen: true });
    vi.advanceTimersByTime(FULLSCREEN_HOME_MS);
    t.expectHomeThroughTheDoor();
  });
});
