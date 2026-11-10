import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRoomFile } from '../src/rooms/validate.js';
import type { RoomFile } from '../src/rooms/types.js';

function good(): RoomFile {
  return {
    version: 1,
    id: 'room:test',
    name: 'Test room',
    shell: {
      width: 6,
      depth: 5,
      height: 2.8,
      floor: { color: '#886644' },
      walls: { color: '#ddd' },
      openings: [{ wall: 'north', kind: 'window', offset: 0, width: 1, height: 1, sill: 1 }],
    },
    lights: [{ type: 'ambient', color: '#ffffff', intensity: 1 }],
    camera: { position: [0, 1.5, 2], target: [0, 1, 0], fov: 50 },
    home: { position: [0, 0, 0], facing: 0 },
    objects: [
      { id: 'box', name: 'box', position: [1, 0, 1], size: [1, 1, 1], parts: [{ shape: 'box', size: [1, 1, 1], offset: [0, 0.5, 0], color: '#112233' }] },
    ],
  };
}
function mutate(change: (room: Record<string, any>) => void): unknown {
  const room = JSON.parse(JSON.stringify(good())) as Record<string, any>;
  change(room);
  return room;
}

describe('validateRoomFile', () => {
  it('accepts a good file', () => {
    expect(validateRoomFile(good()).name).toBe('Test room');
  });
  it('accepts library models with an asset, file and scale, and the old file-only form', () => {
    const room = mutate((r) => (r.objects[0].model = { asset: 'polyhaven/ArmChair_01', file: 'ArmChair_01_1k.gltf', scale: 1.2 }));
    expect(() => validateRoomFile(room)).not.toThrow();
    expect(() => validateRoomFile(mutate((r) => (r.objects[0].model = { file: 'a.glb' })))).not.toThrow();
  });
  it('accepts a generated object as the asset', () => {
    const room = mutate((r) => (r.objects[0].model = { asset: 'generated/rocking-chair-3fa91c2e', file: 'model.glb', scale: 0.8 }));
    expect(validateRoomFile(room).objects[0].model?.asset).toBe('generated/rocking-chair-3fa91c2e');
  });
  it('accepts both built-in rooms', () => {
    const directory = path.resolve('assets/rooms');
    const files = readdirSync(directory).filter((name) => name.endsWith('.json'));
    expect(files.sort()).toEqual(['reading-room.json', 'studio-flat.json']);
    for (const file of files) {
      const room = validateRoomFile(JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
      expect(room.objects.length).toBeGreaterThanOrEqual(6);
      expect(room.objects.length).toBeLessThanOrEqual(10);
    }
  });
  const bad: Array<[string, (room: Record<string, any>) => void, RegExp]> = [
    ['wrong version', (r) => (r.version = 2), /version/],
    ['not an object', () => undefined, /room/],
    ['missing name', (r) => delete r.name, /name/],
    ['zero width', (r) => (r.shell.width = 0), /shell\.width/],
    ['NaN depth', (r) => (r.shell.depth = Number.NaN), /shell\.depth/],
    ['bad colour', (r) => (r.shell.floor.color = 'red'), /colour/],
    ['opening off the wall', (r) => (r.shell.openings[0].offset = 2.8), /fit/],
    ['opening too tall', (r) => (r.shell.openings[0].height = 2), /taller/],
    ['unknown light', (r) => (r.lights[0].type = 'laser'), /light type/],
    ['camera with a short position', (r) => (r.camera.position = [0, 1]), /camera\.position/],
    ['infinite home', (r) => (r.home.position = [0, 0, Infinity]), /home\.position/],
    ['duplicate ids', (r) => r.objects.push({ ...r.objects[0] }), /used twice/],
    ['object outside the shell', (r) => (r.objects[0].position = [4, 0, 0]), /outside the room/],
    ['negative size', (r) => (r.objects[0].size = [1, -1, 1]), /size/],
    ['bad part shape', (r) => (r.objects[0].parts[0].shape = 'cone'), /shape/],
    ['model path escape', (r) => (r.objects[0].model = { file: '../x.glb' }), /room folder/],
    ['bad asset ref', (r) => (r.objects[0].model = { file: 'a.gltf', asset: 'polyhaven/..' }), /asset/],
    ['bad scale', (r) => (r.objects[0].model = { file: 'a.gltf', asset: 'polyhaven/X_1', scale: 0 }), /scale/],
    ['bad collider', (r) => (r.objects[0].collider = 'mesh'), /collider/],
    ['bad tag', (r) => (r.objects[0].tags = { sit: { position: [0, 0], facing: 0 } }), /sit/],
  ];
  it.each(bad)('rejects %s', (name, change, message) => {
    const input = name === 'not an object' ? 'nope' : mutate(change);
    expect(() => validateRoomFile(input)).toThrow(message);
  });
});
