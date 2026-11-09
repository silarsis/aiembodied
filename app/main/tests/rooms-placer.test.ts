import { describe, expect, it } from 'vitest';
import { placeRoom } from '../src/rooms/room-placer.js';
import { validateLayout, type RoomLayout } from '../src/rooms/room-layout.js';
import { validateRoomFile } from '../src/rooms/validate.js';
import { findUnreachable, footprintOf, floorObstacles } from '../src/rooms/room-walkability.js';
import { contains, insideRoom, overlaps, rectOf } from '../src/rooms/placer-geometry.js';

const place = (over: Record<string, unknown>) => ({ against: null, near: null, on: null, facing: null, corner: false, ...over });
function layout(): RoomLayout {
  return validateLayout({
    name: 'Cosy reading room',
    description: 'warm',
    shell: { width: 6, depth: 5, height: 2.8, floor: 'warm oak', walls: 'soft cream', windows: [{ wall: 'north', width: 1.6 }], door: { wall: 'east' } },
    lighting: 'warm evening',
    objects: [
      { id: 'bookshelf', name: 'bookshelf', category: 'storage', size: [1.6, 2.0, 0.35], place: place({ against: 'west' }), idle: 'browses' },
      { id: 'sofa', name: 'sofa', category: 'seat', size: [2.0, 0.9, 0.9], seat_height: 0.45, place: place({ against: 'north' }) },
      { id: 'armchair', name: 'armchair', category: 'seat', size: [0.9, 0.95, 0.9], seat_height: 0.45, place: place({ near: 'coffee-table', facing: 'coffee-table' }) },
      { id: 'coffee-table', name: 'coffee table', category: 'table', size: [1.0, 0.42, 0.6], surface: true, place: place({}) },
      { id: 'mug', name: 'mug', category: 'prop', size: [0.09, 0.1, 0.09], grabbable: true, place: place({ on: 'coffee-table' }) },
      { id: 'lamp', name: 'floor lamp', category: 'lamp', size: [0.4, 1.7, 0.4], place: place({ against: 'north', corner: true }) },
      { id: 'rug', name: 'rug', category: 'decor', size: [3, 0.02, 2.2], place: place({}) },
      { id: 'plant', name: 'plant', category: 'plant', size: [0.5, 1.2, 0.5], place: place({ against: 'south', corner: true }) },
    ],
  });
}

describe('placeRoom', () => {
  it('is deterministic for a seed and passes validateRoomFile', () => {
    const a = placeRoom({ layout: layout(), seed: 7 });
    const b = placeRoom({ layout: layout(), seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(() => validateRoomFile(a.room)).not.toThrow();
    expect(a.dropped).toEqual([]);
    expect(a.room.objects).toHaveLength(8);
  });

  it('stays valid, overlap-free and walkable for many seeds', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const { room } = placeRoom({ layout: layout(), seed });
      expect(() => validateRoomFile(room)).not.toThrow();
      expect(findUnreachable(room)).toEqual([]);
      const solid = floorObstacles(room);
      for (const o of room.objects) expect(insideRoom(footprintOf(o), 3, 2.5, 0)).toBe(true);
      for (let i = 0; i < solid.length; i += 1)
        for (let j = i + 1; j < solid.length; j += 1) expect(overlaps(footprintOf(solid[i]), footprintOf(solid[j]), 0.09)).toBe(false);
    }
  });

  it('keeps objects inside the walls with a gap between them, and the way home clear', () => {
    const { room } = placeRoom({ layout: layout(), seed: 3 });
    const solid = floorObstacles(room);
    for (const o of room.objects) expect(insideRoom(footprintOf(o), room.shell.width / 2, room.shell.depth / 2, 0.0)).toBe(true);
    for (let i = 0; i < solid.length; i += 1)
      for (let j = i + 1; j < solid.length; j += 1) expect(overlaps(footprintOf(solid[i]), footprintOf(solid[j]), 0.09)).toBe(false);
    const home = rectOf(room.home.position[0], room.home.position[2], 0.6, 0.6, 0);
    for (const o of solid) expect(overlaps(footprintOf(o), home)).toBe(false);
    expect(room.camera.position[2]).toBeCloseTo(2.1);
  });

  it('keeps the door and tall things off the windows clear', () => {
    const { room } = placeRoom({ layout: layout(), seed: 5 });
    const door = room.shell.openings!.find((o) => o.kind === 'door')!;
    const doorZone = rectOf(room.shell.width / 2 - 0.5, door.offset, 1.0, door.width, 0);
    const window = room.shell.openings!.find((o) => o.kind === 'window')!;
    const windowZone = rectOf(window.offset, -room.shell.depth / 2 + 0.4, window.width, 0.8, 0);
    for (const o of room.objects) {
      if (o.size[1] < 0.06) continue;
      expect(overlaps(footprintOf(o), doorZone)).toBe(false);
      if (o.size[1] > 0.85 && !o.dynamic) expect(overlaps(footprintOf(o), windowZone)).toBe(false);
    }
  });

  it('makes seats reachable, tags objects and sets props on their surface', () => {
    const { room } = placeRoom({ layout: layout(), seed: 11 });
    expect(findUnreachable(room)).toEqual([]);
    const byId = Object.fromEntries(room.objects.map((o) => [o.id, o]));
    expect(byId.sofa.tags?.sit?.position[1]).toBeCloseTo(0.45);
    expect(byId.sofa.tags?.stand).toBeTruthy();
    expect(byId.sofa.rotationY).toBe(0);
    expect(byId['coffee-table'].tags?.surface?.height).toBeCloseTo(0.42);
    expect(byId.mug.dynamic).toBe(true);
    expect(byId.mug.tags?.grab).toBeTruthy();
    expect(byId.mug.position[1]).toBeCloseTo(0.42);
    expect(contains(footprintOf(byId['coffee-table']), footprintOf(byId.mug))).toBe(true);
    expect(byId.bookshelf.rotationY).toBe(90);
    expect(byId.bookshelf.tags?.idle).toBe('browses');
    expect(byId.rug.collider).toBe('none');
    for (const o of room.objects) expect(o.parts?.length).toBeGreaterThan(0);
  });

  it('uses a model reference and its real size when one is resolved', () => {
    const { room } = placeRoom({
      layout: layout(),
      seed: 1,
      resolved: { sofa: { model: { asset: 'polyhaven/Sofa_01', file: 'Sofa_01_1k.gltf', scale: 1.2 }, size: [2.2, 0.8, 1.0] } },
    });
    const sofa = room.objects.find((o) => o.id === 'sofa')!;
    expect(sofa.model).toEqual({ asset: 'polyhaven/Sofa_01', file: 'Sofa_01_1k.gltf', scale: 1.2 });
    expect(sofa.parts).toBeUndefined();
    expect(sofa.size).toEqual([2.2, 0.8, 1.0]);
    expect(() => validateRoomFile(room)).not.toThrow();
  });

  it('drops what cannot fit, with warnings, and still gives a valid room', () => {
    const crowded = validateLayout({
      name: 'Tiny',
      shell: { width: 3, depth: 3, height: 2.5, windows: [], door: { wall: 'east' } },
      objects: Array.from({ length: 6 }, (_, i) => ({ id: `wardrobe-${i}`, name: `wardrobe ${i}`, category: 'storage', size: [1.5, 2, 0.8], place: place({ against: 'west' }) })),
    });
    const { room, warnings, dropped } = placeRoom({ layout: crowded, seed: 2 });
    expect(dropped.length).toBeGreaterThan(0);
    expect(warnings.length).toBeGreaterThanOrEqual(dropped.length);
    expect(room.objects.length + dropped.length).toBe(6);
    expect(() => validateRoomFile(room)).not.toThrow();
    expect(findUnreachable(room)).toEqual([]);
  });

  it('drops a prop whose surface was left out and keeps seats reachable in a cramped room', () => {
    const l = validateLayout({
      name: 'Cramped',
      shell: { width: 3, depth: 3, height: 2.5, windows: [{ wall: 'north', width: 1 }], door: { wall: 'east' } },
      objects: [
        { id: 'a', name: 'sofa', category: 'seat', size: [2, 0.9, 0.9], place: place({ against: 'north' }) },
        { id: 'b', name: 'sofa two', category: 'seat', size: [2, 0.9, 0.9], place: place({ against: 'south' }) },
        { id: 't', name: 'table', category: 'table', size: [1.6, 0.7, 1.2], place: place({}) },
        { id: 'c', name: 'cup', category: 'prop', size: [0.1, 0.1, 0.1], grabbable: true, place: place({ on: 't' }) },
      ],
    });
    const { room, dropped } = placeRoom({ layout: l, seed: 4 });
    expect(findUnreachable(room)).toEqual([]);
    if (dropped.includes('t')) expect(dropped).toContain('c');
  });
});
