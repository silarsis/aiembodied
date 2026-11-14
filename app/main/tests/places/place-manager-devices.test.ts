import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DESKTOP_ROOM, LOCATIONS_KEY, OFFLINE_GRACE_MS, PLACES_KEY, PlaceManager, scopedPlaces } from '../../src/places/place-manager.js';
import type { PlacesSnapshot } from '../../src/places/place-manager.js';
import type { SwitchboardBus } from '../../src/switchboard/bus.js';
import type { SwitchboardEventInput } from '../../src/switchboard/types.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];

function setup(kv: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(kv));
  const store = { getValue: (key: string) => data.get(key) ?? null, setValue: (key: string, value: string) => void data.set(key, value) };
  const published: SwitchboardEventInput[] = [];
  const bus = { publish: (event: SwitchboardEventInput) => (published.push(event), null) } as unknown as SwitchboardBus;
  const manager = new PlaceManager({ store, registry: { list: () => PROFILES }, bus: () => bus });
  const snapshots: PlacesSnapshot[] = [];
  manager.onChanged((snapshot) => snapshots.push(snapshot));
  return { manager, data, published, snapshots };
}

describe('PlaceManager desktop rooms', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('adds a desktop room, offline until it connects', () => {
    const { manager, data, snapshots } = setup();
    expect(manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' })).toEqual({ id: 'study', name: 'the study', node: 'room-1', online: false, room: DEFAULT_DESKTOP_ROOM });
    expect(snapshots).toHaveLength(1);
    // `online` is never stored.
    expect(JSON.parse(data.get(PLACES_KEY) as string)).toContainEqual({ id: 'study', name: 'the study', node: 'room-1', room: DEFAULT_DESKTOP_ROOM });
    const snapshot = manager.snapshot();
    expect(snapshot.places.find((place) => place.id === 'study')?.online).toBe(false);
    // Built-ins carry no online flag: always online.
    expect(snapshot.places.find((place) => place.id === 'home')).not.toHaveProperty('online');
    expect(manager.isOnline('home')).toBe(true);
    expect(manager.isOnline('next-door')).toBe(true);
    expect(manager.isOnline('study')).toBe(false);
  });

  it('refuses a taken id, a built-in node or an empty name', () => {
    const { manager } = setup();
    manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    expect(manager.addPlace({ id: 'study', name: 'again', node: 'room-2' })).toBeNull();
    expect(manager.addPlace({ id: 'home', name: 'x', node: 'room-2' })).toBeNull();
    expect(manager.addPlace({ id: 'x', name: 'x', node: 'local' })).toBeNull();
    expect(manager.addPlace({ id: 'y', name: ' ', node: 'room-2' })).toBeNull();
  });

  it('shows the snapshot from a desktop room\'s point of view', () => {
    const { manager } = setup();
    manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    expect(manager.snapshot().localPlaceId).toBe('home');
    expect(manager.snapshot('study').localPlaceId).toBe('study');
  });

  it('setOnline pushes a change; renaming keeps the flag out of storage', () => {
    const { manager, data, snapshots } = setup();
    manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    manager.setOnline('study', true);
    expect(manager.get('study')?.online).toBe(true);
    expect(snapshots.at(-1)?.places.find((place) => place.id === 'study')?.online).toBe(true);
    manager.rename('study', 'Kevin\'s study');
    expect(manager.get('study')).toEqual({ id: 'study', name: "Kevin's study", node: 'room-1', online: true, room: DEFAULT_DESKTOP_ROOM });
    expect(data.get(PLACES_KEY)).not.toContain('online');
    // No change, no push.
    const count = snapshots.length;
    manager.setOnline('study', true);
    expect(snapshots).toHaveLength(count);
    manager.setOnline('home', false);
    expect(manager.isOnline('home')).toBe(true);
  });

  it('refuses a move to a closed room', () => {
    const { manager } = setup();
    manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    expect(manager.startMove('sage', 'study', 'chose to')).toEqual({ ok: false, reason: 'the study is closed' });
    manager.setOnline('study', true);
    expect(manager.startMove('sage', 'study', 'chose to').ok).toBe(true);
    // The satellite confirms the arrival, as the local renderer does for the local place.
    expect(manager.arrived('sage')).toBe(true);
    expect(manager.locationOf('sage')).toBe('study');
    expect(manager.avatarsAt('study')).toEqual(['sage']);
  });

  function sageInStudy() {
    const context = setup();
    context.manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    context.manager.setOnline('study', true);
    context.manager.startMove('sage', 'study', 'chose to');
    context.manager.arrived('sage');
    return context;
  }

  it('keeps avatars for 60 s after the room goes offline, then sends them home', () => {
    const { manager, published } = sageInStudy();
    manager.setOnline('study', false);
    expect(manager.locationOf('sage')).toBe('study');
    vi.advanceTimersByTime(OFFLINE_GRACE_MS - 1);
    expect(manager.locationOf('sage')).toBe('study');
    vi.advanceTimersByTime(1);
    // The move is under way: Sage is in transit to the local place, where the renderer walks her in through the door.
    expect(manager.inTransit('sage')).toBe(true);
    expect(manager.snapshot().transit).toEqual([{ avatarId: 'sage', from: 'study', to: 'home' }]);
    expect(published.at(-1)).toMatchObject({ type: 'avatar.move', scene: 'home', payload: { avatarId: 'sage', from: 'study', to: 'home', reason: 'room closed' } });
    expect(manager.arrived('sage')).toBe(true);
    expect(manager.locationOf('sage')).toBe('home');
  });

  it('does nothing if the room comes back within the grace time', () => {
    const { manager } = sageInStudy();
    manager.setOnline('study', false);
    vi.advanceTimersByTime(30_000);
    manager.setOnline('study', true);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS * 2);
    expect(manager.locationOf('sage')).toBe('study');
    expect(manager.inTransit('sage')).toBe(false);
  });

  it('starts the grace clock at start-up for rooms nobody has reconnected', () => {
    const { manager } = setup({
      [PLACES_KEY]: JSON.stringify([{ id: 'study', name: 'the study', node: 'room-1' }]),
      [LOCATIONS_KEY]: JSON.stringify({ sage: 'study' }),
    });
    manager.settleOffline();
    expect(manager.locationOf('sage')).toBe('study');
    vi.advanceTimersByTime(OFFLINE_GRACE_MS);
    expect(manager.inTransit('sage')).toBe(true);
  });

  it('removing a room puts its avatars back at home and drops moves that involve it', () => {
    const { manager } = sageInStudy();
    manager.startMove('echo', 'study', 'chose to');
    expect(manager.removePlace('study')).toBe(true);
    expect(manager.get('study')).toBeNull();
    expect(manager.locationOf('sage')).toBe('home');
    expect(manager.inTransit('echo')).toBe(false);
    expect(manager.removePlace('study')).toBe(false);
    expect(manager.removePlace('home')).toBe(false);
    expect(manager.removePlace('next-door')).toBe(false);
  });

  it('a desktop room draws a room: the Studio flat until one is picked, and only desktop rooms can pick', () => {
    const { manager, data, snapshots } = setup();
    manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    expect(manager.get('study')?.room).toBe(DEFAULT_DESKTOP_ROOM);
    expect(manager.get('home')?.room).toBeUndefined();
    expect(manager.setRoom('study', 'room:abc')).toBe(true);
    expect(manager.get('study')?.room).toBe('room:abc');
    expect(JSON.parse(data.get(PLACES_KEY) as string)).toContainEqual({ id: 'study', name: 'the study', node: 'room-1', room: 'room:abc' });
    expect(snapshots.at(-1)?.places.find((place) => place.id === 'study')?.room).toBe('room:abc');
    expect(manager.setRoom('home', 'room:abc')).toBe(false);
    expect(manager.setRoom('next-door', 'room:abc')).toBe(false);
    expect(manager.setRoom('study', '  ')).toBe(false);
    expect(manager.setRoom('nowhere', 'room:abc')).toBe(false);
  });

  it('a desktop room saved before rooms could be picked gets the default room', () => {
    const { manager } = setup({ [PLACES_KEY]: JSON.stringify([{ id: 'study', name: 'the study', node: 'room-1' }]) });
    expect(manager.get('study')?.room).toBe(DEFAULT_DESKTOP_ROOM);
  });

  describe('as one place sees them', () => {
    it('presence, away and waiting for an arrival are about that place', async () => {
      const { manager } = setup();
      manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
      manager.setOnline('study', true);
      const study = scopedPlaces(manager, 'study');
      expect(study.localPlaceId()).toBe('study');
      expect(study.isPresent('echo')).toBe(false);
      expect(study.awayFromLocal()).toEqual(['echo', 'sage']);
      expect(manager.awayFromLocal()).toEqual([]);
      expect(manager.startMove('echo', 'study', 'summoned').ok).toBe(true);
      const arrived = study.waitForArrival('echo', 5000);
      manager.arrived('echo');
      await expect(arrived).resolves.toBe(true);
      expect(study.isPresent('echo')).toBe(true);
      expect(manager.isPresent('echo')).toBe(false);
      expect(study.awayFromLocal()).toEqual(['sage']);
      expect(study.snapshot().localPlaceId).toBe('study');
      expect(manager.snapshot().localPlaceId).toBe('home');
    });
  });

  it('saves "Camera presence" per place, and says nothing in the snapshot until it is changed', () => {
    const { manager, data, snapshots } = setup();
    manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    expect(manager.get('study')).not.toHaveProperty('camera');
    expect(manager.get('home')).not.toHaveProperty('camera');
    snapshots.length = 0;
    expect(manager.setCamera('study', false)).toBe(true);
    expect(manager.setCamera('home', true)).toBe(true);
    expect(manager.get('study')?.camera).toBe(false);
    expect(manager.get('home')?.camera).toBe(true);
    expect(snapshots).toHaveLength(2);
    // Setting the same value again changes nothing and tells nobody.
    manager.setCamera('home', true);
    expect(snapshots).toHaveLength(2);
    expect(JSON.parse(data.get(PLACES_KEY) as string)).toContainEqual({ id: 'study', name: 'the study', node: 'room-1', room: DEFAULT_DESKTOP_ROOM, camera: false });
    // A new manager on the same store reads them back.
    const again = new PlaceManager({ store: { getValue: (key) => data.get(key) ?? null, setValue: (key, value) => void data.set(key, value) }, registry: { list: () => PROFILES } });
    expect(again.get('study')?.camera).toBe(false);
    expect(again.get('home')?.camera).toBe(true);
  });

  it('has no camera setting for an offscreen place or an unknown one', () => {
    const { manager } = setup();
    expect(manager.setCamera('next-door', true)).toBe(false);
    expect(manager.setCamera('nowhere', true)).toBe(false);
  });

  it('tells arrival listeners once per arrival, and survives one that throws', () => {
    const { manager } = setup();
    manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
    const seen: Array<[string, string]> = [];
    manager.onArrived(() => {
      throw new Error('bad listener');
    });
    const off = manager.onArrived((avatarId, placeId) => seen.push([avatarId, placeId]));
    manager.startMove('echo', 'next-door', 'chose to');
    vi.advanceTimersByTime(2000);
    expect(seen).toEqual([['echo', 'next-door']]);
    off();
    manager.startMove('echo', 'home', 'chose to');
    vi.advanceTimersByTime(2000);
    expect(seen).toHaveLength(1);
  });
});
