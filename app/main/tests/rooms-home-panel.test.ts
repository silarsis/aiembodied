import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRoomFile } from '../src/shared/rooms/validate.js';
import { buildWalkability, findUnreachable } from '../src/rooms/room-walkability.js';

/** Both built-in rooms have a wall-mounted home panel the avatar can walk up to. */
describe('home panel in the built-in rooms', () => {
  for (const file of ['studio-flat', 'reading-room']) {
    it(`${file}: validates, hangs on a wall, and its stand spot is free and reachable`, () => {
      const room = validateRoomFile(JSON.parse(readFileSync(join(__dirname, '../assets/rooms', `${file}.json`), 'utf8')));
      const panel = room.objects.find((o) => o.id === 'home-panel')!;
      expect(panel).toMatchObject({ name: 'home panel', description: 'a wall panel that controls the house', collider: 'none' });
      expect(panel.position[1]).toBeCloseTo(1.4);
      expect(panel.size).toEqual([0.3, 0.2, 0.03]);
      // On the east wall, facing into the room.
      expect(panel.position[0]).toBeGreaterThan(room.shell.width / 2 - 0.05);
      expect(panel.tags?.stand?.position).toEqual([0, 0, 0.7]);
      expect(panel.tags?.look).toBeDefined();
      // The spot 0.7 m in front of the panel (local +z maps to world -x at rotationY -90).
      const walk = buildWalkability(room);
      const x = panel.position[0] - 0.7;
      const z = panel.position[2];
      expect(walk.free(x, z)).toBe(true);
      expect(walk.reachable(x, z)).toBe(true);
      expect(findUnreachable(room)).toEqual([]);
      // Clear of the door opening on the east wall.
      const door = room.shell.openings.find((o) => o.wall === 'east' && o.kind === 'door')!;
      expect(Math.abs(panel.position[2] - door.offset)).toBeGreaterThan(door.width / 2 + 0.15);
    });
  }
});
