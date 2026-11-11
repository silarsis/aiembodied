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
