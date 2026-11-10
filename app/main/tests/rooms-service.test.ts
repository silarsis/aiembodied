import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundService } from '../src/backgrounds/background-service.js';
import { RoomService } from '../src/rooms/room-service.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const SAVED = '3f2b8c1e-0000-4000-8000-000000000001';
const BROKEN = '3f2b8c1e-0000-4000-8000-000000000002';

async function setup() {
  const roomsDirectory = await mkdtemp(path.join(tmpdir(), 'rooms-'));
  directories.push(roomsDirectory);
  const builtIn = JSON.parse(
    await (await import('node:fs/promises')).readFile(path.resolve('assets/rooms/studio-flat.json'), 'utf8'),
  ) as Record<string, unknown>;
  await mkdir(path.join(roomsDirectory, SAVED));
  await writeFile(path.join(roomsDirectory, SAVED, 'room.json'), JSON.stringify({ ...builtIn, name: 'My room', id: 'ignored' }));
  await mkdir(path.join(roomsDirectory, BROKEN));
  await writeFile(path.join(roomsDirectory, BROKEN, 'room.json'), '{"version":1}');
  const service = new RoomService({ assetsDirectory: path.resolve('assets/rooms'), roomsDirectory });
  return { service, roomsDirectory };
}

describe('RoomService', () => {
  it('lists built-in and valid saved rooms and skips invalid saved ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service } = await setup();
    const rooms = await service.list();
    expect(rooms.map((room) => room.id)).toEqual([
      'room:builtin:reading-room',
      'room:builtin:studio-flat',
      `room:${SAVED}`,
    ]);
    expect(rooms.map((room) => room.builtIn)).toEqual([true, true, false]);
    expect(rooms[2].name).toBe('My room');
    expect(warn).toHaveBeenCalledOnce();
  });
  it('loads rooms and stamps the requested id', async () => {
    const { service } = await setup();
    expect((await service.load('room:builtin:reading-room')).id).toBe('room:builtin:reading-room');
    expect((await service.load(`room:${SAVED}`)).id).toBe(`room:${SAVED}`);
  });
  it('rejects traversal, unknown and malformed ids', async () => {
    const { service } = await setup();
    for (const id of [
      'room:builtin:../reading-room',
      'room:builtin:..\\..\\secret',
      'room:../../etc/passwd',
      'room:builtin:missing',
      'room:not-a-uuid',
      'reading-room',
      '',
    ]) {
      expect(service.hasRoom(id)).toBe(false);
      await expect(service.load(id)).rejects.toThrow('not available');
    }
  });
});

describe('BackgroundService with rooms', () => {
  it('stores a room as the active stage and refuses unknown rooms', async () => {
    const { service: rooms } = await setup();
    const values = new Map<string, string>();
    const service = new BackgroundService({
      store: { getValue: (key) => values.get(key) ?? null, setValue: (key, value) => void values.set(key, value) },
      assetsDirectory: path.resolve('assets/backgrounds'),
      backgroundsDirectory: await mkdtemp(path.join(tmpdir(), 'bg-')),
      comfy: { isAvailable: async () => false, run: async () => Buffer.alloc(0) },
      rooms,
    });
    directories.push(service['options'].backgroundsDirectory);
    service.setActive('room:builtin:reading-room');
    expect(values.get('stage.activeBackground')).toBe('room:builtin:reading-room');
    expect(service.getActive()).toBe('room:builtin:reading-room');
    expect(() => service.setActive('room:builtin:nope')).toThrow('not available');
    service.setActive(null);
    expect(service.getActive()).toBeNull();
    await expect(service.delete('room:builtin:reading-room')).rejects.toThrow();
  });
  it('rejects room ids when no room service is configured', async () => {
    const service = new BackgroundService({
      store: { getValue: () => null, setValue: () => undefined },
      assetsDirectory: '',
      backgroundsDirectory: '',
      comfy: { isAvailable: async () => false, run: async () => Buffer.alloc(0) },
    });
    expect(() => service.setActive('room:builtin:reading-room')).toThrow('not available');
  });
});

describe('RoomService with models that are no longer on disk', () => {
  const MADE = '3f2b8c1e-0000-4000-8000-000000000003';
  async function roomWithModels() {
    const { roomsDirectory } = await setup();
    const builtIn = JSON.parse(await (await import('node:fs/promises')).readFile(path.resolve('assets/rooms/studio-flat.json'), 'utf8')) as { objects: Array<Record<string, any>> };
    const objects = [
      { id: 'chair', name: 'rocking chair', position: [1, 0, 1], size: [0.6, 0.9, 0.6], model: { asset: 'generated/chair-3fa91c2e', file: 'model.glb', scale: 0.8 }, tags: { sit: { position: [0, 0.45, 0.05], facing: 0 } } },
      { id: 'lamp', name: 'lamp', position: [-1, 0, 1], size: [0.3, 1.5, 0.3], model: { asset: 'polyhaven/Lamp_01', file: 'Lamp_01_1k.gltf', scale: 1 } },
      { id: 'box', name: 'box', position: [0, 0, -1], size: [1, 1, 1], parts: [{ shape: 'box', size: [1, 1, 1], offset: [0, 0.5, 0], color: '#112233' }] },
    ];
    await mkdir(path.join(roomsDirectory, MADE));
    await writeFile(path.join(roomsDirectory, MADE, 'room.json'), JSON.stringify({ ...builtIn, name: 'Made room', objects }));
    await writeFile(path.join(roomsDirectory, MADE, 'layout.json'), JSON.stringify({ objects: [{ id: 'chair', category: 'seat', color: 'red' }, { id: 'lamp', category: 'lamp', color: 'black' }] }));
    return { roomsDirectory, service: new RoomService({ assetsDirectory: path.resolve('assets/rooms'), roomsDirectory }) };
  }

  it('turns them into simple shapes of the right kind, size and colour', async () => {
    const { service } = await roomWithModels();
    const room = await service.load(`room:${MADE}`);
    const chair = room.objects.find((o) => o.id === 'chair')!;
    expect(chair.model).toBeUndefined();
    expect(chair.parts?.length).toBeGreaterThan(1);
    expect(chair.parts?.[0].color).toBe('#a8372f');
    expect(chair.size).toEqual([0.6, 0.9, 0.6]);
    expect(room.objects.find((o) => o.id === 'lamp')?.model).toBeUndefined();
    expect(room.objects.find((o) => o.id === 'lamp')?.parts?.length).toBeGreaterThan(0);
    expect(room.objects.find((o) => o.id === 'box')?.parts).toHaveLength(1);
    expect((await service.list()).map((r) => r.name)).toContain('Made room');
  });

  it('keeps the model while its file is there', async () => {
    const { service, roomsDirectory } = await roomWithModels();
    await mkdir(path.join(roomsDirectory, 'assets', 'generated', 'chair-3fa91c2e'), { recursive: true });
    await writeFile(path.join(roomsDirectory, 'assets', 'generated', 'chair-3fa91c2e', 'model.glb'), 'glb');
    const room = await service.load(`room:${MADE}`);
    expect(room.objects.find((o) => o.id === 'chair')?.model?.asset).toBe('generated/chair-3fa91c2e');
    expect(room.objects.find((o) => o.id === 'chair')?.parts).toBeUndefined();
    expect(room.objects.find((o) => o.id === 'lamp')?.model).toBeUndefined();
  });

  it('uses a plain grey box when the room has no layout.json', async () => {
    const { service, roomsDirectory } = await roomWithModels();
    await (await import('node:fs/promises')).rm(path.join(roomsDirectory, MADE, 'layout.json'));
    const chair = (await service.load(`room:${MADE}`)).objects.find((o) => o.id === 'chair')!;
    expect(chair.model).toBeUndefined();
    expect(chair.parts?.length).toBeGreaterThan(0);
  });

  it('never touches built-in rooms', async () => {
    const { service } = await roomWithModels();
    const room = await service.load('room:builtin:reading-room');
    expect(room.objects.every((o) => o.model === undefined)).toBe(true);
  });
});
