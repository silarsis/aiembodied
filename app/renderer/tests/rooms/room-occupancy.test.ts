import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomOccupancy } from '../../src/rooms/room-occupancy.js';

const same = (p: { x: number; z: number }) => p;

describe('RoomOccupancy spots', () => {
  it('lists the others with where they stand and head, never the asker', () => {
    const occupancy = new RoomOccupancy();
    occupancy.standing('echo', { x: 0, z: 0 });
    occupancy.standing('sage', { x: 1, z: 2 });
    occupancy.claimSpot('sage', { x: 3, z: 3 });
    expect(occupancy.others('echo')).toEqual([{ id: 'sage', x: 1, z: 2, goal: { x: 3, z: 3 } }]);
    expect(occupancy.others('sage')).toEqual([{ id: 'echo', x: 0, z: 0 }]);
    occupancy.releaseSpot('sage');
    expect(occupancy.others('echo')).toEqual([{ id: 'sage', x: 1, z: 2 }]);
  });

  it('returns the wanted spot when it is free, also next to the asker itself', () => {
    const occupancy = new RoomOccupancy();
    occupancy.standing('echo', { x: 0, z: 0 });
    occupancy.standing('sage', { x: 2, z: 0 });
    expect(occupancy.freeSpotNear('echo', { x: 0.1, z: 0 }, same)).toEqual({ x: 0.1, z: 0 });
  });

  it('moves off another avatar standing there or heading there, to the nearest free ring point', () => {
    const occupancy = new RoomOccupancy();
    occupancy.standing('sage', { x: 0, z: 0 });
    const spot = occupancy.freeSpotNear('echo', { x: 0.1, z: 0 }, same)!;
    expect(spot).not.toBeNull();
    expect(Math.hypot(spot.x - 0.1, spot.z)).toBeCloseTo(0.5, 6);
    expect(Math.hypot(spot.x, spot.z)).toBeGreaterThanOrEqual(0.45);

    const heading = new RoomOccupancy();
    heading.standing('sage', { x: 5, z: 5 });
    heading.claimSpot('sage', { x: 1, z: 1 });
    const other = heading.freeSpotNear('echo', { x: 1, z: 1 }, same)!;
    expect(Math.hypot(other.x - 1, other.z - 1)).toBeGreaterThanOrEqual(0.45);
  });

  it('snaps candidates with closestWalkable and re-checks them; null when nothing is free', () => {
    const occupancy = new RoomOccupancy();
    occupancy.standing('sage', { x: 0, z: 0 });
    // Everything snaps back onto the occupied spot.
    expect(occupancy.freeSpotNear('echo', { x: 0, z: 0 }, () => ({ x: 0, z: 0 }))).toBeNull();
    // A wall: nothing walkable beyond x = 0.3, which is still inside the radius.
    expect(occupancy.freeSpotNear('echo', { x: 0, z: 0 }, (p) => ({ x: Math.max(-0.3, Math.min(p.x, 0.3)), z: Math.max(-0.3, Math.min(p.z, 0.3)) }))).toBeNull();
    // Candidates further than maxShift are refused.
    expect(occupancy.freeSpotNear('echo', { x: 0, z: 0 }, (p) => ({ x: p.x + 5, z: p.z }))).toBeNull();
  });
});

describe('RoomOccupancy claims', () => {
  it('lets one avatar hold a seat or object at a time', () => {
    const occupancy = new RoomOccupancy();
    expect(occupancy.claim('seat', 'sofa', 'sage')).toBe(true);
    expect(occupancy.claim('seat', 'sofa', 'sage')).toBe(true);
    expect(occupancy.claim('seat', 'sofa', 'echo')).toBe(false);
    expect(occupancy.claim('object', 'sofa', 'echo')).toBe(true);
    expect(occupancy.holder('seat', 'sofa')).toBe('sage');
    occupancy.release('seat', 'sofa', 'echo');
    expect(occupancy.holder('seat', 'sofa')).toBe('sage');
    occupancy.release('seat', 'sofa', 'sage');
    expect(occupancy.holder('seat', 'sofa')).toBeNull();
    expect(occupancy.claim('seat', 'sofa', 'echo')).toBe(true);
  });

  it('keepOnly and releaseAll drop an avatar\'s claims and goal', () => {
    const occupancy = new RoomOccupancy();
    occupancy.claim('seat', 'sofa', 'sage');
    occupancy.claim('object', 'mug', 'sage');
    occupancy.claim('object', 'book', 'echo');
    occupancy.claimSpot('sage', { x: 1, z: 1 });
    occupancy.keepOnly('sage', { seat: 'sofa' });
    expect(occupancy.holder('seat', 'sofa')).toBe('sage');
    expect(occupancy.holder('object', 'mug')).toBeNull();
    occupancy.releaseAll('sage');
    expect(occupancy.holder('seat', 'sofa')).toBeNull();
    expect(occupancy.holder('object', 'book')).toBe('echo');
    expect(occupancy.others('echo')).toEqual([]);
  });

  it('names avatars for the reasons, falling back to the id', () => {
    const occupancy = new RoomOccupancy();
    occupancy.setNames({ sage: 'Sage' });
    expect(occupancy.nameOf('sage')).toBe('Sage');
    expect(occupancy.nameOf('rex')).toBe('rex');
  });
});

describe('RoomOccupancy walking mutex', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves at once when free and for the avatar that already holds it', async () => {
    const occupancy = new RoomOccupancy();
    const release = await occupancy.acquireWalk('echo');
    const again = await occupancy.acquireWalk('echo');
    again(); // a re-entrant release does not free the lock
    let sage = false;
    void occupancy.acquireWalk('sage').then(() => (sage = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(sage).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(sage).toBe(true);
  });

  it('serves waiters first in, first out', async () => {
    const occupancy = new RoomOccupancy();
    const order: string[] = [];
    const release = await occupancy.acquireWalk('a');
    const b = occupancy.acquireWalk('b').then((r) => (order.push('b'), r));
    const c = occupancy.acquireWalk('c').then((r) => (order.push('c'), r));
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual([]);
    release();
    (await b)();
    (await c)();
    expect(order).toEqual(['b', 'c']);
  });

  it('proceeds after the timeout with a release that does nothing', async () => {
    const occupancy = new RoomOccupancy();
    const release = await occupancy.acquireWalk('a');
    let released: (() => void) | null = null;
    void occupancy.acquireWalk('b', 1000).then((r) => (released = r));
    await vi.advanceTimersByTimeAsync(999);
    expect(released).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(released).not.toBeNull();
    let c = false;
    void occupancy.acquireWalk('c').then(() => (c = true));
    released!(); // does not free a's lock
    await vi.advanceTimersByTimeAsync(10);
    expect(c).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(c).toBe(true);
  });

  it('releaseAll frees a held walk and drops the queue place', async () => {
    const occupancy = new RoomOccupancy();
    await occupancy.acquireWalk('a');
    let b = false;
    let c = false;
    void occupancy.acquireWalk('b').then(() => (b = true));
    void occupancy.acquireWalk('c').then(() => (c = true));
    occupancy.releaseAll('b'); // b gives up (its waiting call resolves, nobody holds on its behalf)
    await vi.advanceTimersByTimeAsync(0);
    expect(b).toBe(true);
    expect(c).toBe(false);
    occupancy.releaseAll('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(c).toBe(true);
    // c now holds the walk; a newcomer waits.
    let d = false;
    void occupancy.acquireWalk('d').then(() => (d = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(d).toBe(false);
  });
});
