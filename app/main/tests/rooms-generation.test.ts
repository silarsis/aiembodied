import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomGenerationService, type RoomGenerationProgress } from '../src/rooms/room-generation.js';
import { RoomService } from '../src/rooms/room-service.js';
import { validateLayout } from '../src/rooms/room-layout.js';
import type { ObjectSource } from '../src/rooms/asset-library/library-source.js';
import { validateRoomFile } from '../src/rooms/validate.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const layout = () =>
  validateLayout({
    name: 'Cosy study',
    shell: { width: 5, depth: 5, height: 2.7, windows: [{ wall: 'north', width: 1.4 }], door: { wall: 'east' } },
    objects: [
      { id: 'desk', name: 'desk', category: 'table', size: [1.4, 0.75, 0.7], place: { against: 'north' } },
      { id: 'chair', name: 'rocking chair', category: 'seat', size: [0.6, 0.9, 0.6], seat_height: 0.45, place: { near: 'desk' } },
    ],
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'roomgen-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const deskSource: ObjectSource = {
  name: 'fake',
  async resolve(object) {
    return object.id === 'desk' ? { model: { asset: 'polyhaven/Desk_01', file: 'Desk_01_1k.gltf', scale: 1 }, size: [1.4, 0.75, 0.7] } : null;
  },
};

describe('RoomGenerationService', () => {
  it('plans, finds, arranges and saves a room that RoomService lists', async () => {
    const events: RoomGenerationProgress[] = [];
    const service = new RoomGenerationService({ roomsDirectory: dir, writeLayout: async () => layout(), sources: [deskSource], uuid: () => UUID, seed: () => 5 });
    const result = await service.generate(' a cosy study ', (e) => events.push(e));
    expect(result.room).toMatchObject({ id: `room:${UUID}`, name: 'Cosy study', builtIn: false, description: 'a cosy study' });
    expect(result.warnings).toEqual(["Couldn't find a rocking chair, used a simple shape."]);
    expect(events.map((e) => e.message)).toEqual(['Planning the room', 'Finding furniture (0/2)', 'Finding furniture (1/2)', 'Finding furniture (2/2)', 'Arranging', 'Done, with notes']);
    expect((await readdir(path.join(dir, UUID))).sort()).toEqual(['generation.json', 'layout.json', 'room.json']);
    const room = validateRoomFile(JSON.parse(await readFile(path.join(dir, UUID, 'room.json'), 'utf8')));
    expect(room.objects.find((o) => o.id === 'desk')?.model?.asset).toBe('polyhaven/Desk_01');
    expect(room.objects.find((o) => o.id === 'chair')?.parts?.length).toBeGreaterThan(0);
    const generation = JSON.parse(await readFile(path.join(dir, UUID, 'generation.json'), 'utf8'));
    expect(generation).toMatchObject({ description: 'a cosy study', fellBack: ['chair'] });
    const listed = await new RoomService({ assetsDirectory: path.join(dir, 'none'), roomsDirectory: dir }).list();
    expect(listed.map((r) => r.id)).toEqual([`room:${UUID}`]);
  });

  it('allows one generation at a time and can be cancelled', async () => {
    let release!: () => void;
    const service = new RoomGenerationService({
      roomsDirectory: dir,
      writeLayout: (_d, signal) => new Promise((resolve, reject) => {
        release = () => resolve(layout());
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      sources: [],
      uuid: () => UUID,
    });
    const first = service.generate('a room');
    await expect(service.generate('another')).rejects.toThrow(/already/);
    expect(service.busy).toBe(true);
    expect(service.cancel()).toBe(true);
    await expect(first).rejects.toThrow(/cancelled/);
    expect(service.busy).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    expect(release).toBeTypeOf('function');
    expect(service.cancel()).toBe(false);
  });

  it('surfaces layout failures and rejects empty descriptions', async () => {
    const service = new RoomGenerationService({ roomsDirectory: dir, writeLayout: async () => { throw new Error('model down'); }, sources: [] });
    await expect(service.generate('x')).rejects.toThrow('model down');
    await expect(service.generate('  ')).rejects.toThrow(/Describe/);
    expect(service.busy).toBe(false);
  });

  it('deletes saved rooms only', async () => {
    const service = new RoomGenerationService({ roomsDirectory: dir, writeLayout: async () => layout(), sources: [], uuid: () => UUID });
    await service.generate('a room');
    await expect(service.delete('room:builtin:reading-room')).rejects.toThrow(/built/);
    await expect(service.delete('room:../..')).rejects.toThrow();
    await service.delete(`room:${UUID}`);
    expect(await readdir(dir)).toEqual([]);
  });
});
