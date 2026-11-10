import { describe, expect, it } from 'vitest';
import { worldTag } from '../../src/rooms/room-tags.js';
import { builtInRoom } from './fixtures.js';

describe('worldTag', () => {
  const base = builtInRoom('reading-room');
  const room = {
    ...base,
    objects: [
      {
        id: 'chair',
        name: 'chair',
        position: [1, 0, 2] as [number, number, number],
        rotationY: 90,
        size: [1, 1, 1] as [number, number, number],
        tags: {
          sit: { position: [0.5, 0.4, 1] as [number, number, number], facing: 0 },
          surface: { height: 0.9 },
        },
      },
    ],
  };

  it('rotates local positions with rotationY 90 and adds to the facing', () => {
    const tag = worldTag(room, 'chair', 'sit')!;
    // Local +Z points along world +X and local +X along world -Z when rotated 90 degrees.
    expect(tag.position[0]).toBeCloseTo(1 + 1);
    expect(tag.position[1]).toBeCloseTo(0.4);
    expect(tag.position[2]).toBeCloseTo(2 - 0.5);
    expect(tag.facing).toBe(90);
  });

  it('wraps facings and handles surfaces and missing tags', () => {
    expect(worldTag({ ...room, objects: [{ ...room.objects[0], rotationY: 270 }] }, 'chair', 'sit')!.facing).toBe(-90);
    expect(worldTag(room, 'chair', 'surface')!.position).toEqual([1, 0.9, 2]);
    expect(worldTag(room, 'chair', 'grab')).toBeNull();
    expect(worldTag(room, 'nothing', 'sit')).toBeNull();
  });

  it('matches the facing convention: facing 0 is +Z, so a tag facing 90 looks along +X', () => {
    const tag = worldTag(builtInRoom('reading-room'), 'armchair', 'sit')!;
    expect(tag.facing).toBe(40);
  });
});
