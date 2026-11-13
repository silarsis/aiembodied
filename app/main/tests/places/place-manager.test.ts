import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HALLWAY_MS,
  HOME_PLACE_ID,
  LOCATIONS_KEY,
  MOVE_DEADLINE_MS,
  NEXT_DOOR_PLACE_ID,
  PLACES_KEY,
  PlaceManager,
  placesNote,
} from '../../src/places/place-manager.js';
import type { PlacesSnapshot } from '../../src/places/place-manager.js';
import type { SwitchboardEventInput } from '../../src/switchboard/types.js';
import type { SwitchboardBus } from '../../src/switchboard/bus.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
  { id: 'rex', name: 'Rex', vrmModelId: null },
];

function setup(options: { kv?: Record<string, string>; profiles?: typeof PROFILES; withBus?: boolean } = {}) {
  const kv = new Map<string, string>(Object.entries(options.kv ?? {}));
  const store = { getValue: (key: string) => kv.get(key) ?? null, setValue: (key: string, value: string) => void kv.set(key, value) };
  const published: SwitchboardEventInput[] = [];
  const bus = { publish: (event: SwitchboardEventInput) => (published.push(event), null) } as unknown as SwitchboardBus;
  const profiles = options.profiles ?? PROFILES;
  const manager = new PlaceManager({ store, registry: { list: () => profiles }, bus: options.withBus === false ? undefined : () => bus });
  const snapshots: PlacesSnapshot[] = [];
  manager.onChanged((snapshot) => snapshots.push(snapshot));
  return { manager, kv, published, snapshots };
}

describe('PlaceManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('places', () => {
    it('has the two built-in places', () => {
      const { manager } = setup();
      expect(manager.list()).toEqual([
        { id: 'home', name: 'the lounge', node: 'local' },
        { id: 'next-door', name: 'next door', node: 'offscreen' },
      ]);
      expect(manager.localPlaceId()).toBe(HOME_PLACE_ID);
    });

    it('fills in built-ins that are missing and keeps stored extras', () => {
      const { manager } = setup({
        kv: { [PLACES_KEY]: JSON.stringify([{ id: 'attic', name: 'the attic', node: 'pc-2' }, { id: 'home', name: 'Living room', node: 'wrong' }, 'junk']) },
      });
      const list = manager.list();
      expect(list.map((place) => place.id)).toEqual(['home', 'next-door', 'attic']);
      // A built-in keeps its node; only the name can change.
      expect(list[0]).toEqual({ id: 'home', name: 'Living room', node: 'local' });
      // A place drawn by another PC says whether that PC is connected (not yet, after a start-up).
      expect(list[2]).toEqual({ id: 'attic', name: 'the attic', node: 'pc-2', online: false });
    });

    it('survives garbage in the store', () => {
      const { manager } = setup({ kv: { [PLACES_KEY]: '{not json', [LOCATIONS_KEY]: '[1,2]' } });
      expect(manager.list()).toHaveLength(2);
      expect(manager.locationOf('echo')).toBe('home');
    });

    it('renames a place, saves it and announces the change', () => {
      const { manager, kv, snapshots } = setup();
      expect(manager.rename('next-door', '  the garden ')).toEqual({ id: 'next-door', name: 'the garden', node: 'offscreen' });
      expect(JSON.parse(kv.get(PLACES_KEY) ?? '[]')).toContainEqual({ id: 'next-door', name: 'the garden', node: 'offscreen' });
      expect(snapshots).toHaveLength(1);
      expect(manager.rename('nowhere', 'x')).toBeNull();
      expect(manager.rename('home', '   ')).toBeNull();
    });

    it('resolves a place by id or name, ignoring case, "the" and separators', () => {
      const { manager } = setup();
      expect(manager.resolvePlace('next door')?.id).toBe('next-door');
      expect(manager.resolvePlace('Next-Door')?.id).toBe('next-door');
      expect(manager.resolvePlace('next_door')?.id).toBe('next-door');
      expect(manager.resolvePlace('the next door')?.id).toBe('next-door');
      expect(manager.resolvePlace('THE LOUNGE')?.id).toBe('home');
      expect(manager.resolvePlace('lounge')?.id).toBe('home');
      expect(manager.resolvePlace('home')?.id).toBe('home');
      expect(manager.resolvePlace('the moon')).toBeNull();
      expect(manager.resolvePlace('  ')).toBeNull();
      manager.rename('next-door', 'The Garden');
      expect(manager.resolvePlace('garden')?.id).toBe('next-door');
    });
  });

  describe('who is where', () => {
    it('puts everybody at home when nothing is stored', () => {
      const { manager } = setup();
      expect(manager.avatarsAt('home')).toEqual(['echo', 'sage', 'rex']);
      expect(manager.avatarsAt('next-door')).toEqual([]);
      expect(manager.isPresent('sage')).toBe(true);
      expect(manager.awayFromLocal()).toEqual([]);
    });

    it('treats an unknown place as home, and ignores avatars that are not in the registry', () => {
      const { manager } = setup({ kv: { [LOCATIONS_KEY]: JSON.stringify({ sage: 'the-moon', ghost: 'next-door', rex: 'next-door' }) } });
      expect(manager.locationOf('sage')).toBe('home');
      expect(manager.avatarsAt('home')).toEqual(['echo', 'sage']);
      expect(manager.avatarsAt('next-door')).toEqual(['rex']);
      expect(manager.snapshot().locations).toEqual({ echo: 'home', sage: 'home', rex: 'next-door' });
      expect(manager.isPresent('ghost')).toBe(false);
    });

    it('keeps registry order in avatarsAt', () => {
      const { manager } = setup({ kv: { [LOCATIONS_KEY]: JSON.stringify({ rex: 'next-door', echo: 'next-door' }) } });
      expect(manager.avatarsAt('next-door')).toEqual(['echo', 'rex']);
    });
  });

  describe('moves', () => {
    it('walks an avatar to an offscreen place through the hallway', () => {
      const { manager, kv, snapshots } = setup();
      const result = manager.startMove('sage', 'next-door', 'chose to');
      expect(result.ok).toBe(true);
      // In transit it is nowhere: not at home, not next door.
      expect(manager.isPresent('sage')).toBe(false);
      expect(manager.inTransit('sage')).toBe(true);
      expect(manager.avatarsAt('home')).toEqual(['echo', 'rex']);
      expect(manager.avatarsAt('next-door')).toEqual([]);
      expect(snapshots.at(-1)?.transit).toEqual([{ avatarId: 'sage', from: 'home', to: 'next-door' }]);
      // Nothing is stored until it arrives.
      expect(kv.get(LOCATIONS_KEY)).toBeUndefined();

      vi.advanceTimersByTime(HALLWAY_MS - 1);
      expect(manager.inTransit('sage')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(manager.inTransit('sage')).toBe(false);
      expect(manager.avatarsAt('next-door')).toEqual(['sage']);
      expect(JSON.parse(kv.get(LOCATIONS_KEY) ?? '{}')).toEqual({ sage: 'next-door' });
      expect(snapshots.at(-1)?.transit).toEqual([]);
    });

    it('waits for the renderer when the target is this PC, and arrives on `arrived`', () => {
      const { manager } = setup({ kv: { [LOCATIONS_KEY]: JSON.stringify({ sage: 'next-door' }) } });
      expect(manager.startMove('sage', 'home', 'summoned').ok).toBe(true);
      vi.advanceTimersByTime(HALLWAY_MS * 3);
      expect(manager.isPresent('sage')).toBe(false);
      expect(manager.arrived('sage')).toBe(true);
      expect(manager.isPresent('sage')).toBe(true);
      expect(manager.locationOf('sage')).toBe('home');
      // Nothing is left to confirm.
      expect(manager.arrived('sage')).toBe(false);
    });

    it('fails a move that is not confirmed in time and leaves the avatar where it was', () => {
      const { manager, kv, published } = setup({ kv: { [LOCATIONS_KEY]: JSON.stringify({ sage: 'next-door' }) } });
      manager.startMove('sage', 'home', 'summoned');
      vi.advanceTimersByTime(MOVE_DEADLINE_MS - 1);
      expect(manager.inTransit('sage')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(manager.inTransit('sage')).toBe(false);
      expect(manager.locationOf('sage')).toBe('next-door');
      expect(manager.isPresent('sage')).toBe(false);
      expect(JSON.parse(kv.get(LOCATIONS_KEY) ?? '{}')).toEqual({ sage: 'next-door' });
      expect(published.at(-1)?.txn?.state).toBe('failed');
      expect(published.at(-1)?.payload).toMatchObject({ reason: 'not confirmed in time' });
      // A late confirmation changes nothing.
      expect(manager.arrived('sage')).toBe(false);
    });

    it('puts a failed move away from this PC back on screen', () => {
      // A place drawn by another PC that never confirms: the avatar is back in the room it left.
      const { manager } = setup({ kv: { [PLACES_KEY]: JSON.stringify([{ id: 'attic', name: 'the attic', node: 'pc-2' }]) } });
      manager.setOnline('attic', true);
      manager.startMove('sage', 'attic', 'chose to');
      expect(manager.isPresent('sage')).toBe(false);
      vi.advanceTimersByTime(MOVE_DEADLINE_MS);
      expect(manager.isPresent('sage')).toBe(true);
    });

    it('rejects moves that make no sense', () => {
      const { manager } = setup();
      expect(manager.startMove('sage', 'home', 'x')).toEqual({ ok: false, reason: 'already there' });
      expect(manager.startMove('sage', 'moon', 'x')).toEqual({ ok: false, reason: 'unknown place' });
      expect(manager.startMove('ghost', 'next-door', 'x')).toEqual({ ok: false, reason: 'unknown avatar' });
      expect(manager.startMove('sage', 'next-door', 'x').ok).toBe(true);
      expect(manager.startMove('sage', 'home', 'x')).toEqual({ ok: false, reason: 'already moving' });
      expect(manager.startMove('sage', 'next-door', 'x')).toEqual({ ok: false, reason: 'already moving' });
    });

    it('can move two avatars at once', () => {
      const { manager } = setup();
      manager.startMove('sage', 'next-door', 'x');
      manager.startMove('rex', 'next-door', 'x');
      vi.advanceTimersByTime(HALLWAY_MS);
      expect(manager.avatarsAt('next-door')).toEqual(['sage', 'rex']);
    });

    it('persists locations across managers sharing a store', () => {
      const { manager, kv } = setup();
      manager.startMove('rex', 'next-door', 'x');
      vi.advanceTimersByTime(HALLWAY_MS);
      const again = new PlaceManager({ store: { getValue: (key) => kv.get(key) ?? null, setValue: (key, value) => void kv.set(key, value) }, registry: { list: () => PROFILES } });
      expect(again.locationOf('rex')).toBe('next-door');
      expect(again.avatarsAt('home')).toEqual(['echo', 'sage']);
    });

    it('announces every change with a snapshot', () => {
      const { manager, snapshots } = setup();
      manager.startMove('sage', 'next-door', 'x');
      vi.advanceTimersByTime(HALLWAY_MS);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toMatchObject({ localPlaceId: 'home', locations: { sage: 'next-door' }, transit: [] });
    });
  });

  describe('waitForArrival', () => {
    it('resolves true at once for an avatar that is here', async () => {
      const { manager } = setup();
      await expect(manager.waitForArrival('echo', 1000)).resolves.toBe(true);
    });

    it('resolves true when the avatar arrives', async () => {
      const { manager } = setup({ kv: { [LOCATIONS_KEY]: JSON.stringify({ sage: 'next-door' }) } });
      manager.startMove('sage', 'home', 'summoned');
      const waiting = manager.waitForArrival('sage', MOVE_DEADLINE_MS);
      manager.arrived('sage');
      await expect(waiting).resolves.toBe(true);
    });

    it('resolves false when the move fails', async () => {
      const { manager } = setup({ kv: { [LOCATIONS_KEY]: JSON.stringify({ sage: 'next-door' }) } });
      manager.startMove('sage', 'home', 'summoned');
      const waiting = manager.waitForArrival('sage', MOVE_DEADLINE_MS * 2);
      vi.advanceTimersByTime(MOVE_DEADLINE_MS);
      await expect(waiting).resolves.toBe(false);
    });

    it('resolves false at its own timeout', async () => {
      const { manager } = setup({ kv: { [LOCATIONS_KEY]: JSON.stringify({ sage: 'next-door' }) } });
      const waiting = manager.waitForArrival('sage', 500);
      vi.advanceTimersByTime(500);
      await expect(waiting).resolves.toBe(false);
    });
  });

  describe('journal', () => {
    it('opens one transaction per move and closes it when the avatar arrives', () => {
      const { manager, published } = setup();
      manager.startMove('sage', 'next-door', 'chose to');
      vi.advanceTimersByTime(HALLWAY_MS);
      expect(published).toHaveLength(2);
      const [open, done] = published;
      expect(open).toMatchObject({
        type: 'avatar.move',
        scene: 'next-door',
        producer: { kind: 'avatar', id: 'sage' },
        payload: { avatarId: 'sage', from: 'home', to: 'next-door', reason: 'chose to' },
        txn: { state: 'open' },
      });
      expect(open?.txn?.id).toMatch(/^move:sage:/);
      expect(done?.txn).toEqual({ id: open?.txn?.id, state: 'done' });
    });

    it('never lets a failing bus disturb a move', () => {
      const kv = new Map<string, string>();
      const bus = { publish: () => { throw new Error('bus down'); } } as unknown as SwitchboardBus;
      const manager = new PlaceManager({ store: { getValue: (key) => kv.get(key) ?? null, setValue: (key, value) => void kv.set(key, value) }, registry: { list: () => PROFILES }, bus: () => bus });
      expect(manager.startMove('sage', 'next-door', 'x').ok).toBe(true);
      vi.advanceTimersByTime(HALLWAY_MS);
      expect(manager.locationOf('sage')).toBe('next-door');
    });

    it('works without a bus', () => {
      const { manager } = setup({ withBus: false });
      expect(manager.startMove('sage', 'next-door', 'x').ok).toBe(true);
    });
  });

  describe('placesNote', () => {
    const nameOf = (id: string) => PROFILES.find((profile) => profile.id === id)?.name ?? id;

    it('says where the avatar is and who is in the other places', () => {
      const { manager } = setup({ kv: { [LOCATIONS_KEY]: JSON.stringify({ sage: 'next-door' }) } });
      expect(placesNote(manager, nameOf)).toBe(
        'You are in the lounge. Other places: next door (Sage is there). To go to another place, write {room:<place name>} at the end of what you say: you finish speaking, walk out, and arrive a few seconds later. You only hear and see what happens in the place you are in.',
      );
    });

    it('handles nobody, two and three avatars', () => {
      const { manager } = setup();
      expect(placesNote(manager, nameOf)).toContain('next door (nobody is there)');
      const two = setup({ kv: { [LOCATIONS_KEY]: JSON.stringify({ sage: 'next-door', rex: 'next-door' }) } });
      expect(placesNote(two.manager, nameOf)).toContain('next door (Sage and Rex are there)');
    });

    it('uses a renamed place', () => {
      const { manager } = setup();
      manager.rename('home', 'the kitchen');
      expect(placesNote(manager, nameOf)).toContain('You are in the kitchen.');
    });

    it('leaves out avatars in the hallway', () => {
      const { manager } = setup();
      manager.startMove('sage', 'next-door', 'x');
      expect(placesNote(manager, nameOf)).toContain('next door (nobody is there)');
    });
  });
});

describe('built-in ids', () => {
  it('are stable', () => {
    expect(HOME_PLACE_ID).toBe('home');
    expect(NEXT_DOOR_PLACE_ID).toBe('next-door');
  });
});
