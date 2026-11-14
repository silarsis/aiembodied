import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaceManager } from '../../src/places/place-manager.js';
import { callToPlace } from '../../src/places/summon.js';
import { FULLSCREEN_HOME_MS, LOCKED_HOME_MS, PlaceDevices } from '../../src/room-hub/place-devices.js';
import { PlacePresence } from '../../src/presence/place-presence.js';
import type { SwitchboardBus } from '../../src/switchboard/bus.js';
import type { SwitchboardEventInput } from '../../src/switchboard/types.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];

function setup() {
  const data = new Map<string, string>();
  const store = { getValue: (key: string) => data.get(key) ?? null, setValue: (key: string, value: string) => void data.set(key, value) };
  const published: SwitchboardEventInput[] = [];
  const bus = { publish: (event: SwitchboardEventInput) => (published.push(event), null) } as unknown as SwitchboardBus;
  const places = new PlaceManager({ store, registry: { list: () => PROFILES }, bus: () => bus });
  places.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
  places.setOnline('study', true);
  const presence = new PlacePresence();
  const changed = vi.fn();
  const devices = new PlaceDevices({ places, presence, bus: () => bus, onChanged: changed });
  /** Walks an avatar into the study and confirms it, as the satellite does. */
  const walkIn = (avatarId: string) => {
    places.startMove(avatarId, 'study', 'called');
    places.arrived(avatarId);
  };
  const state = (fields: Record<string, unknown> = {}) => ({ op: 'device.state', mic: 'live', camera: 'off', speakers: 'live', locked: false, closed: false, fullscreen: false, ...fields });
  return { places, presence, devices, published, changed, walkIn, state };
}

describe('PlaceDevices', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the state per place and journals every change with the fact that changed', () => {
    const { devices, presence, published, changed, state } = setup();
    devices.onMessage('study', state());
    expect(presence.deviceState('study')).toMatchObject({ mic: 'live', fullscreen: false });
    devices.onMessage('study', state({ mic: 'off', fullscreen: true }));
    const events = published.filter((event) => event.type === 'place.device');
    expect(events).toHaveLength(2);
    expect(events[1].payload).toMatchObject({ placeId: 'study', changed: ['mic', 'fullscreen'], state: { mic: 'off', fullscreen: true }, previous: { mic: 'live' } });
    // The same state again is not news.
    devices.onMessage('study', state({ mic: 'off', fullscreen: true }));
    expect(published.filter((event) => event.type === 'place.device')).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('sends the avatars home when the screen stays locked for 5 minutes, and not when it unlocks in time', () => {
    const { devices, places, walkIn, state } = setup();
    walkIn('echo');
    devices.onMessage('study', state({ locked: true, mic: 'off' }));
    vi.advanceTimersByTime(LOCKED_HOME_MS - 1000);
    expect(places.locationOf('echo')).toBe('study');
    devices.onMessage('study', state({ locked: false }));
    vi.advanceTimersByTime(LOCKED_HOME_MS);
    expect(places.locationOf('echo')).toBe('study');
    devices.onMessage('study', state({ locked: true, mic: 'off' }));
    vi.advanceTimersByTime(LOCKED_HOME_MS);
    expect(places.inTransit('echo')).toBe(true);
    // bija's window confirms the arrival at the door.
    places.arrived('echo');
    expect(places.locationOf('echo')).toBe('home');
  });

  it('sends the avatars home after 2 minutes of a full-screen app', () => {
    const { devices, places, walkIn, state, published } = setup();
    walkIn('echo');
    devices.onMessage('study', state({ fullscreen: true, mic: 'off' }));
    vi.advanceTimersByTime(FULLSCREEN_HOME_MS - 1);
    expect(places.inTransit('echo')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(places.inTransit('echo')).toBe(true);
    const move = published.filter((event) => event.type === 'avatar.move').at(-1);
    expect(JSON.stringify(move?.payload)).toContain('full screen app');
  });

  it('room.close sends everyone home and refuses moves until room.open', () => {
    const { devices, places, walkIn, state } = setup();
    walkIn('echo');
    walkIn('sage');
    devices.onMessage('study', { op: 'room.close' });
    expect(places.isClosed('study')).toBe(true);
    expect(places.inTransit('echo')).toBe(true);
    expect(places.inTransit('sage')).toBe(true);
    places.arrived('echo');
    places.arrived('sage');
    expect(places.locationOf('echo')).toBe('home');
    expect(places.startMove('echo', 'study', 'called')).toEqual({ ok: false, reason: 'the study is closed' });
    devices.onMessage('study', { op: 'room.open' });
    expect(places.startMove('echo', 'study', 'called').ok).toBe(true);
    // The PC's own report agrees with it.
    devices.onMessage('study', state({ closed: true }));
    expect(places.isClosed('study')).toBe(true);
  });

  it('a closed room turns back an avatar that was walking in', () => {
    const { devices, places } = setup();
    places.startMove('echo', 'study', 'called');
    devices.onMessage('study', { op: 'room.close' });
    expect(places.inTransit('echo')).toBe(false);
    expect(places.locationOf('echo')).toBe('home');
  });

  it('forgetting a place stops its clocks', () => {
    const { devices, places, walkIn, state } = setup();
    walkIn('echo');
    devices.onMessage('study', state({ locked: true }));
    devices.forget('study');
    vi.advanceTimersByTime(LOCKED_HOME_MS * 2);
    expect(places.locationOf('echo')).toBe('study');
  });
});

describe('callToPlace (places:summon)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const avatars = PROFILES.map(({ id, name }) => ({ id, name }));

  it('calls the recent partner, else Echo, else the first avatar', () => {
    const a = setup();
    expect(callToPlace(a.places, 'study', 'sage', avatars)).toEqual({ ok: true, avatarId: 'sage', name: 'Sage', alreadyHere: false });
    expect(a.places.inTransit('sage')).toBe(true);
    const b = setup();
    expect(callToPlace(b.places, 'study', null, avatars)).toMatchObject({ ok: true, avatarId: 'echo' });
    const c = setup();
    expect(callToPlace(c.places, 'study', null, [{ id: 'sage', name: 'Sage' }])).toMatchObject({ ok: true, avatarId: 'sage' });
    expect(callToPlace(c.places, 'study', null, [])).toEqual({ ok: false, reason: 'nobody to call' });
  });

  it('calls nobody when someone is there, and says who is already coming', () => {
    const { places, walkIn } = setup();
    walkIn('sage');
    expect(callToPlace(places, 'study', null, avatars)).toMatchObject({ ok: true, avatarId: 'sage', alreadyHere: true });
    expect(places.inTransit('echo')).toBe(false);
    const other = setup();
    other.places.startMove('echo', 'study', 'called');
    expect(callToPlace(other.places, 'study', 'sage', avatars)).toMatchObject({ ok: true, avatarId: 'echo', alreadyHere: false });
    expect(other.places.inTransit('sage')).toBe(false);
  });

  it('is refused for a closed room', () => {
    const { places } = setup();
    places.setClosed('study', true);
    expect(callToPlace(places, 'study', null, avatars)).toEqual({ ok: false, reason: 'the study is closed' });
  });

  it('works for the local place too (bija\'s own window)', () => {
    const { places, walkIn } = setup();
    walkIn('echo');
    expect(callToPlace(places, 'home', 'echo', avatars)).toMatchObject({ ok: true, avatarId: 'sage', alreadyHere: true });
  });
});
