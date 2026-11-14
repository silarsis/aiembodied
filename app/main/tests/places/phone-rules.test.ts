import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cameraPresenceOn } from '../../src/places/camera-setting.js';
import { doorbellOn } from '../../src/places/doorbell-setting.js';
import { DEFAULT_DESKTOP_ROOM, DEFAULT_PHONE_ROOM } from '../../src/places/default-room.js';
import { LOCATIONS_KEY, OFFLINE_GRACE_MS, PHONE_OFFLINE_GRACE_MS, PLACES_KEY, PlaceManager } from '../../src/places/place-manager.js';
import type { PlaceKind } from '../../src/places/place-kind.js';
import { NextDoorReturn, RETURN_CHANCE } from '../../src/places/next-door-return.js';
import { URGENT_QUIET_MS, urgentTarget } from '../../src/places/urgent-walk.js';
import { wanderRefusal } from '../../src/places/wander.js';
import { cameraSettingHere } from '../../src/satellite/snapshot-facts.js';
import { PHONE_AWAY_HOME_MS, LOCKED_HOME_MS, PlaceDevices } from '../../src/room-hub/place-devices.js';
import { PlacePresence } from '../../src/presence/place-presence.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];
const NOW = 9_000_000;

function setup(kind: PlaceKind, options: { locations?: Record<string, string>; activeAt?: Record<string, number> } = {}) {
  const data = new Map<string, string>(options.locations ? [[LOCATIONS_KEY, JSON.stringify(options.locations)]] : []);
  const clock = { now: NOW };
  const places = new PlaceManager({
    store: { getValue: (key) => data.get(key) ?? null, setValue: (key, value) => void data.set(key, value) },
    registry: { list: () => PROFILES },
    now: () => clock.now,
    activeAt: (placeId) => options.activeAt?.[placeId] ?? null,
  });
  places.addPlace({ id: 'pocket', name: 'the pocket', node: 'room-1', kind });
  places.setOnline('pocket', true);
  return { places, data, clock };
}

describe('phone rules: the kind of a place', () => {
  it('is saved for a phone and a browser, left out for a desktop, and survives a reload', () => {
    for (const kind of ['phone', 'browser'] as const) {
      const { places, data } = setup(kind);
      expect(places.get('pocket')?.kind).toBe(kind);
      expect(JSON.parse(data.get(PLACES_KEY) as string)).toContainEqual(expect.objectContaining({ id: 'pocket', kind }));
      const again = new PlaceManager({ store: { getValue: (k) => data.get(k) ?? null, setValue: () => undefined }, registry: { list: () => PROFILES } });
      expect(again.get('pocket')?.kind).toBe(kind);
    }
    const desktop = setup('desktop');
    expect(desktop.places.get('pocket')).not.toHaveProperty('kind');
    expect(JSON.parse(desktop.data.get(PLACES_KEY) as string).find((p: { id: string }) => p.id === 'pocket')).not.toHaveProperty('kind');
  });

  it('ignores a made-up kind and never gives a built-in place one', () => {
    const data = new Map([[PLACES_KEY, JSON.stringify([{ id: 'home', name: 'x', node: 'local', kind: 'phone' }, { id: 'r', name: 'r', node: 'room-9', kind: 'toaster' }])]]);
    const places = new PlaceManager({ store: { getValue: (k) => data.get(k) ?? null, setValue: () => undefined }, registry: { list: () => PROFILES } });
    expect(places.get('home')).not.toHaveProperty('kind');
    expect(places.get('r')).not.toHaveProperty('kind');
  });
});

describe('phone rules: defaults by kind (truth table)', () => {
  it.each([
    ['desktop', true, false],
    ['phone', false, false],
    ['browser', false, false],
  ] as const)('%s: camera presence default %s, doorbell default %s', (kind, camera, doorbell) => {
    expect(cameraPresenceOn({ node: 'room-1', kind })).toBe(camera);
    expect(doorbellOn({ node: 'room-1', kind } as never)).toBe(doorbell);
  });

  it('keeps the old defaults for this PC and next door, and a saved setting still wins', () => {
    expect(cameraPresenceOn({ node: 'local' })).toBe(false);
    expect(cameraPresenceOn({ node: 'offscreen' })).toBe(false);
    expect(doorbellOn({ node: 'local' })).toBe(true);
    expect(cameraPresenceOn({ node: 'room-1', kind: 'phone', camera: true })).toBe(true);
    expect(cameraPresenceOn({ node: 'room-1', kind: 'desktop', camera: false })).toBe(false);
    expect(doorbellOn({ node: 'room-1', doorbell: true })).toBe(true);
  });

  it('the satellite reads the kind from the snapshot', () => {
    const snapshot = (kind?: string, camera?: boolean) => ({ localPlaceId: 'p', places: [{ id: 'p', node: 'room-1', ...(kind ? { kind } : {}), ...(camera === undefined ? {} : { camera }) }] });
    expect(cameraSettingHere(snapshot())).toBe(true);
    expect(cameraSettingHere(snapshot('phone'))).toBe(false);
    expect(cameraSettingHere(snapshot('browser'))).toBe(false);
    expect(cameraSettingHere(snapshot('phone', true))).toBe(true);
  });

  it('a new room starts on a 2D background for a phone and in the Studio flat otherwise', () => {
    expect(setup('phone').places.get('pocket')?.room).toBe(DEFAULT_PHONE_ROOM);
    expect(DEFAULT_PHONE_ROOM.startsWith('room:')).toBe(false);
    expect(setup('desktop').places.get('pocket')?.room).toBe(DEFAULT_DESKTOP_ROOM);
    expect(setup('browser').places.get('pocket')?.room).toBe(DEFAULT_DESKTOP_ROOM);
  });
});

describe('phone rules: no unprompted wandering into a phone', () => {
  const activeAt = { pocket: NOW - 1000, home: NOW - 1000 };

  it.each([
    ['desktop', null],
    ['browser', null],
    ['phone', 'a phone is not for wandering'],
  ] as const)('wanderRefusal into a %s room', (kind, expected) => {
    const { places } = setup(kind, { activeAt, locations: { echo: 'home' } });
    expect(wanderRefusal(places.snapshot(), 'echo', 'the pocket')).toBe(expected);
  });

  it('a summon, an explicit move and urgent news still go to a phone', () => {
    const { places } = setup('phone', { activeAt: { pocket: NOW - 1000 }, locations: { echo: 'home' } });
    // Urgent news: the phone counts as in use within 2 minutes.
    expect(urgentTarget(places.snapshot(), 'echo')).toBe('pocket');
    const quiet = setup('phone', { activeAt: { pocket: NOW - URGENT_QUIET_MS + 1000 }, locations: { echo: 'home' } });
    expect(urgentTarget(quiet.places.snapshot(), 'echo')).toBe('pocket');
    const stale = setup('phone', { activeAt: { pocket: NOW - URGENT_QUIET_MS - 1000 }, locations: { echo: 'home' } });
    expect(urgentTarget(stale.places.snapshot(), 'echo')).toBeNull();
    // A move that is not 'wandered' is not asked of wanderRefusal at all.
    expect(places.startMove('echo', 'pocket', 'summoned').ok).toBe(true);
  });

  describe('the next-door return tick', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function tickFor(kind: PlaceKind, active: Record<string, number>) {
      const { places } = setup(kind, { activeAt: active, locations: { echo: 'next-door', sage: 'next-door' } });
      const rng = vi.fn(() => 0);
      const tick = new NextDoorReturn({ places, restlessness: () => 'normal', talkedAgoMs: () => null, rng });
      return { tick, rng };
    }

    it('never picks a phone room, even the only one in use', () => {
      const { tick, rng } = tickFor('phone', { pocket: NOW - 1000 });
      expect(tick.tick()).toBeNull();
      expect(rng).not.toHaveBeenCalled();
    });

    it('picks the phone-less place instead when both are in use', () => {
      const { tick } = tickFor('phone', { pocket: NOW - 500, home: NOW - 5000 });
      expect(tick.tick()).toEqual({ avatarId: 'echo', placeId: 'home' });
    });

    it.each(['desktop', 'browser'] as const)('still picks a %s room', (kind) => {
      const { tick } = tickFor(kind, { pocket: NOW - 1000 });
      expect(RETURN_CHANCE.normal).toBeGreaterThan(0);
      expect(tick.tick()).toEqual({ avatarId: 'echo', placeId: 'pocket' });
    });
  });
});

describe('phone rules: a phone that goes away sends its avatars home after 2 minutes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const walkIn = (places: PlaceManager) => {
    places.startMove('echo', 'pocket', 'called');
    places.arrived('echo');
  };

  it('offline: 2 minutes for a phone, 60 seconds for a desktop and a browser', () => {
    expect(PHONE_OFFLINE_GRACE_MS).toBe(2 * 60_000);
    for (const [kind, ms] of [['phone', PHONE_OFFLINE_GRACE_MS], ['desktop', OFFLINE_GRACE_MS], ['browser', OFFLINE_GRACE_MS]] as const) {
      const { places } = setup(kind);
      walkIn(places);
      places.setOnline('pocket', false);
      vi.advanceTimersByTime(ms - 1);
      expect(places.locationOf('echo')).toBe('pocket');
      vi.advanceTimersByTime(1);
      expect(places.snapshot().transit).toEqual([{ avatarId: 'echo', from: 'pocket', to: 'home' }]);
    }
  });

  it('is cancelled when the phone comes back in time', () => {
    const { places } = setup('phone');
    walkIn(places);
    places.setOnline('pocket', false);
    vi.advanceTimersByTime(PHONE_OFFLINE_GRACE_MS - 1000);
    places.setOnline('pocket', true);
    vi.advanceTimersByTime(PHONE_OFFLINE_GRACE_MS);
    expect(places.locationOf('echo')).toBe('pocket');
    expect(places.snapshot().transit).toEqual([]);
  });

  function devicesFor(kind: PlaceKind) {
    const { places } = setup(kind);
    walkIn(places);
    const devices = new PlaceDevices({ places, presence: new PlacePresence() });
    const state = (locked: boolean) => ({ op: 'device.state', mic: 'live', camera: 'off', speakers: 'live', locked, closed: false, fullscreen: false });
    return { places, devices, state };
  }

  it('not in the foreground (locked) for 2 minutes sends a phone home, and coming back cancels it', () => {
    const { places, devices, state } = devicesFor('phone');
    devices.onMessage('pocket', state(true));
    vi.advanceTimersByTime(PHONE_AWAY_HOME_MS - 1);
    expect(places.snapshot().transit).toEqual([]);
    devices.onMessage('pocket', state(false));
    vi.advanceTimersByTime(LOCKED_HOME_MS);
    expect(places.snapshot().transit).toEqual([]);
    devices.onMessage('pocket', state(true));
    vi.advanceTimersByTime(PHONE_AWAY_HOME_MS);
    expect(places.snapshot().transit).toEqual([{ avatarId: 'echo', from: 'pocket', to: 'home' }]);
  });

  it.each(['desktop', 'browser'] as const)('a locked %s keeps the 5 minute clock', (kind) => {
    const { places, devices, state } = devicesFor(kind);
    devices.onMessage('pocket', state(true));
    vi.advanceTimersByTime(LOCKED_HOME_MS - 1);
    expect(places.snapshot().transit).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(places.snapshot().transit).toHaveLength(1);
  });
});
