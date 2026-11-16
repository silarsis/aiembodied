import RAPIER from '@dimforge/rapier3d-compat';
import { describe, expect, it } from 'vitest';
import { RoomPhysics } from '../../src/rooms/room-physics.js';
import { builtInRoom } from './fixtures.js';

describe('RoomPhysics avatar capsules', () => {
  it('makes a capsule per extra avatar on first use and removes it with removeAvatar', async () => {
    const physics = await RoomPhysics.create(builtInRoom('reading-room'), new Map());
    physics.setAvatarPosition(0, 0); // Echo
    expect(physics.avatarIds).toEqual([]);
    physics.setAvatarPosition(1, 1, 'sage');
    physics.setAvatarPosition(1.2, 1, 'sage');
    physics.setAvatarPosition(-1, 0.5, 'rex');
    expect(physics.avatarIds).toEqual(['sage', 'rex']);
    physics.step(1 / 30);
    physics.removeAvatar('sage');
    expect(physics.avatarIds).toEqual(['rex']);
    physics.removeAvatar('nobody');
    physics.step(1 / 30);
    physics.dispose();
    physics.setAvatarPosition(0, 0, 'sage');
    expect(physics.avatarIds).toEqual([]);
  });
});

describe('RoomPhysics furniture shapes and queries', () => {
  const room = builtInRoom('reading-room');
  const sofa = room.objects.find((object) => object.id === 'sofa')!;
  const [sx, , sz] = sofa.position;

  it('measures furniture surfaces by object', async () => {
    const physics = await RoomPhysics.create(room, new Map());
    expect(physics.surfaceAt(sx, sz + 0.05, 3, 'sofa')).toBeCloseTo(0.46, 2); // cushion, not the box top
    expect(physics.surfaceAt(sx, sz - 0.35, 3, 'sofa')).toBeCloseTo(0.82, 2); // back rest
    expect(physics.surfaceAt(sx, sz + 0.05, 2)).toBeCloseTo(0.46, 2);
    expect(physics.surfaceAt(sx, sz + 0.05, 3, 'armchair')).toBeNull();
    expect(physics.surfaceAt(0, 1.5, 2)).toBeCloseTo(0, 2); // floor
    physics.dispose();
  });

  it('reports penetration with fixed furniture only, with a push-out normal', async () => {
    const physics = await RoomPhysics.create(room, new Map());
    const capsule = new RAPIER.Capsule(0.5, 0.25);
    // Standing on the cushion; sunk 3 cm in.
    const sunk = physics.penetration(capsule, { x: sx, y: 0.46 - 0.03 + 0.75, z: sz + 0.05 });
    expect(sunk?.objectId).toBe('sofa');
    expect(sunk?.depth).toBeCloseTo(0.03, 2);
    expect(sunk?.normal.y).toBeGreaterThan(0.9);
    expect(physics.penetration(capsule, { x: sx, y: 0.46 + 0.75 + 0.05, z: sz + 0.05 })).toBeNull();
    expect(physics.penetration(capsule, { x: sx, y: 0.46 - 0.03 + 0.75, z: sz + 0.05 }, undefined, 'sofa')?.objectId).not.toBe('sofa');
    // Avatar capsules are ignored.
    physics.setAvatarPosition(-1, 0.5, 'sage');
    expect(physics.penetration(capsule, { x: -1, y: 0.8, z: 0.5 })).toBeNull();
    physics.dispose();
  });

  it('swaps an object\'s colliders for new shapes', async () => {
    const physics = await RoomPhysics.create(room, new Map());
    expect(physics.replaceObjectColliders('nobody', [])).toBe(false);
    const ok = physics.replaceObjectColliders('sofa', [
      { kind: 'cuboid', halfExtents: [0.1, 0.1, 0.1], translation: [0, 2, 0], rotation: { x: 0, y: 0, z: 0, w: 1 } },
    ]);
    expect(ok).toBe(true);
    expect(physics.surfaceAt(sx, sz, 5, 'sofa')).toBeCloseTo(2.1, 2);
    expect(physics.surfaceAt(sx + 0.8, sz, 5, 'sofa')).toBeNull();
    physics.dispose();
  });
});
