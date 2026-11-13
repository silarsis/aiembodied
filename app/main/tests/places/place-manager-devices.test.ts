import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATIONS_KEY, OFFLINE_GRACE_MS, PLACES_KEY, PlaceManager } from '../../src/places/place-manager.js';
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
    expect(manager.addPlace({ id: 'study', name: 'the study', node: 'room-1' })).toEqual({ id: 'study', name: 'the study', node: 'room-1', online: false });
    expect(snapshots).toHaveLength(1);
    // `online` is never stored.
    expect(JSON.parse(data.get(PLACES_KEY) as string)).toContainEqual({ id: 'study', name: 'the study', node: 'room-1' });
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
    expect(manager.get('study')).toEqual({ id: 'study', name: "Kevin's study", node: 'room-1', online: true });
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
});
