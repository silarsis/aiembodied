import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOrder, RoomGenerationService, type ObjectGenerator, type RoomGenerationProgress } from '../src/rooms/room-generation.js';
import { RoomService } from '../src/rooms/room-service.js';
import { validateLayout, type LayoutObject } from '../src/rooms/room-layout.js';
import type { ResolvedModel } from '../src/rooms/room-placer.js';
import { GeneratedLibrary } from '../src/rooms/asset-library/generated-library.js';
import { GeneratedSource } from '../src/rooms/asset-library/generated-source.js';
import { makeGlb } from './rooms-glb-fixture.js';
import type { RoomFile } from '../src/rooms/types.js';
import { validateRoomFile } from '../src/rooms/validate.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const ROOM_ID = `room:${UUID}`;
const layout = () =>
  validateLayout({
    name: 'Cosy study',
    shell: { width: 6, depth: 6, height: 2.7, windows: [{ wall: 'north', width: 1.4 }], door: { wall: 'east' } },
    objects: [
      { id: 'lamp', name: 'floor lamp', category: 'lamp', size: [0.3, 1.5, 0.3], place: { against: 'west' } },
      { id: 'chair', name: 'rocking chair', category: 'seat', size: [0.6, 0.9, 0.6], seat_height: 0.45, place: { against: 'south' } },
      { id: 'desk', name: 'desk', category: 'table', size: [1.4, 0.75, 0.7], place: { against: 'north' } },
      { id: 'rug', name: 'rug', category: 'decor', size: [2, 0.02, 1.5], place: {} },
    ],
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'roommaking-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const modelFor = (id: string, size: [number, number, number]): ResolvedModel => ({ model: { asset: `generated/${id}-aaaaaaaa`, file: 'model.glb', scale: 1 }, size });

/** A generator that makes whatever it is told to, one object at a time, and can be held up. */
class FakeGenerator implements ObjectGenerator {
  readonly started: string[] = [];
  readonly cache = new Map<string, ResolvedModel>();
  readonly fail = new Set<string>();
  readonly sizes = new Map<string, [number, number, number]>();
  gate: ((signal: AbortSignal) => Promise<void>) | null = null;
  signals: AbortSignal[] = [];
  async resolve(object: LayoutObject) {
    return this.cache.get(object.name) ?? null;
  }
  async generate(object: LayoutObject, signal: AbortSignal) {
    this.started.push(object.id);
    this.signals.push(signal);
    await this.gate?.(signal);
    if (signal.aborted) throw new Error('Cancelled.');
    if (this.fail.has(object.id)) throw new Error('ComfyUI failed');
    const made = modelFor(object.id, this.sizes.get(object.id) ?? object.size);
    this.cache.set(object.name, made);
    return { resolved: made, reused: false };
  }
  async list() {
    return [];
  }
  async remove() {}
}

function service(generator: FakeGenerator, settings: { enabled?: boolean; maxPerRoom?: number; available?: boolean } = {}) {
  const events: RoomGenerationProgress[] = [];
  const updated: string[] = [];
  const instance = new RoomGenerationService({
    roomsDirectory: dir,
    writeLayout: async () => layout(),
    sources: [],
    generator,
    objectSettings: () => ({ enabled: true, maxPerRoom: 3, available: true, ...settings }),
    onRoomUpdated: (id) => updated.push(id),
    uuid: () => UUID,
    seed: () => 5,
  });
  return { instance, events, updated, onProgress: (e: RoomGenerationProgress) => events.push(e) };
}

const readRoom = async (): Promise<RoomFile> => validateRoomFile(JSON.parse(await readFile(path.join(dir, UUID, 'room.json'), 'utf8')));
const finished = (events: RoomGenerationProgress[]) => vi.waitFor(() => expect(events.at(-1)?.phase).toBe('done'));

describe('making missing objects in the background', () => {
  it('saves the room with simple shapes at once, then swaps in each model and says so', async () => {
    const generator = new FakeGenerator();
    let release!: () => void;
    generator.gate = () => new Promise<void>((resolve) => (release = resolve));
    const { instance, events, updated, onProgress } = service(generator);

    const result = await instance.generate('a study', onProgress);
    expect(result.making).toBe(3);
    // Nothing is claimed yet about the three objects that are being made; the rug is a flat shape now.
    expect(result.warnings).toEqual(["Couldn't find a rug, used a simple shape."]);
    expect(instance.busy).toBe(true);
    expect(instance.making).toBe(ROOM_ID);
    await expect(instance.generate('another')).rejects.toThrow(/already/);

    const before = await readRoom();
    expect(before.objects.find((o) => o.id === 'chair')?.parts?.length).toBeGreaterThan(0);
    expect(before.objects.find((o) => o.id === 'chair')?.model).toBeUndefined();

    await vi.waitFor(() => expect(generator.started).toEqual(['chair']));
    expect(events.at(-1)).toMatchObject({ phase: 'making', roomId: ROOM_ID, message: 'Making the rocking chair (1/3)…' });
    release();
    generator.gate = null;
    await finished(events);

    // Seats, then tables, then lamps.
    expect(generator.started).toEqual(['chair', 'desk', 'lamp']);
    expect(events.filter((e) => e.phase === 'making').map((e) => e.message)).toEqual([
      'Making the rocking chair (1/3)…',
      'Making the desk (2/3)…',
      'Making the floor lamp (3/3)…',
    ]);
    expect(updated).toEqual([ROOM_ID, ROOM_ID, ROOM_ID]);
    expect(events.at(-1)).toMatchObject({
      phase: 'done',
      roomId: ROOM_ID,
      message: 'Done, with notes',
      warnings: ['Made a new model for the rocking chair.', 'Made a new model for the desk.', 'Made a new model for the floor lamp.'],
    });
    expect(instance.busy).toBe(false);
    expect(instance.making).toBeNull();

    const after = await readRoom();
    const chair = after.objects.find((o) => o.id === 'chair')!;
    const chairBefore = before.objects.find((o) => o.id === 'chair')!;
    expect(chair.model).toEqual({ asset: 'generated/chair-aaaaaaaa', file: 'model.glb', scale: 1 });
    expect(chair.parts).toBeUndefined();
    expect(chair.position).toEqual(chairBefore.position);
    expect(chair.rotationY).toEqual(chairBefore.rotationY);
    expect(chair.tags?.sit).toEqual(chairBefore.tags?.sit);
    expect(after.objects.find((o) => o.id === 'rug')?.model).toBeUndefined();

    const generation = JSON.parse(await readFile(path.join(dir, UUID, 'generation.json'), 'utf8'));
    expect(generation).toMatchObject({ madeObjects: ['chair', 'desk', 'lamp'], couldNotMake: [], making: ['chair', 'desk', 'lamp'] });
    expect((await new RoomService({ assetsDirectory: path.join(dir, 'none'), roomsDirectory: dir }).list()).map((r) => r.id)).toEqual([ROOM_ID]);
  });

  it('re-fits to the real size around the placed position, sliding in from a wall only as far as needed', async () => {
    const generator = new FakeGenerator();
    generator.sizes.set('chair', [0.8, 0.9, 0.7]);
    const { instance, events, onProgress } = service(generator, { maxPerRoom: 1 });
    await instance.generate('a study', onProgress);
    const before = await readRoom();
    await finished(events);
    const chair = (await readRoom()).objects.find((o) => o.id === 'chair')!;
    expect(chair.size).toEqual([0.8, 0.9, 0.7]);
    // Deeper than the shapes were and flush against the wall: slid in by the extra 5 cm, no more.
    const was = before.objects.find((o) => o.id === 'chair')!.position;
    expect(chair.position[1]).toBe(was[1]);
    expect(Math.hypot(chair.position[0] - was[0], chair.position[2] - was[2])).toBeCloseTo(0.05, 2);
    // The spot in front of the chair moved out by half the extra depth.
    const oldStand = before.objects.find((o) => o.id === 'chair')!.tags!.stand!.position;
    expect(chair.tags!.stand!.position[2]).toBeCloseTo(oldStand[2] + (0.7 - 0.6) / 2 * Math.sign(oldStand[2] || 1), 3);
  });

  it('stops at the limit and says which objects stayed simple shapes', async () => {
    const generator = new FakeGenerator();
    const { instance, events, onProgress } = service(generator, { maxPerRoom: 1 });
    await instance.generate('a study', onProgress);
    await finished(events);
    expect(generator.started).toEqual(['chair']);
    expect(events.at(-1)?.warnings).toEqual([
      'Made a new model for the rocking chair.',
      "Couldn't make a desk (the limit is 1 new object per room), used a simple shape.",
      "Couldn't make a floor lamp (the limit is 1 new object per room), used a simple shape.",
    ]);
    const room = await readRoom();
    expect(room.objects.find((o) => o.id === 'desk')?.model).toBeUndefined();
    expect(room.objects.find((o) => o.id === 'desk')?.parts?.length).toBeGreaterThan(0);
  });

  it('uses models made earlier without counting them against the limit', async () => {
    const generator = new FakeGenerator();
    generator.cache.set('desk', modelFor('desk', [1.4, 0.75, 0.7]));
    const { instance, events, onProgress } = service(generator, { maxPerRoom: 1 });
    await instance.generate('a study', onProgress);
    await finished(events);
    expect(generator.started).toEqual(['chair']);
    expect(events.at(-1)?.warnings).toContain("Couldn't make a floor lamp (the limit is 1 new object per room), used a simple shape.");
    expect((await readRoom()).objects.find((o) => o.id === 'desk')?.model?.asset).toBe('generated/desk-aaaaaaaa');
  });

  it('falls back to a simple shape with a note when making one fails, and carries on', async () => {
    const generator = new FakeGenerator();
    generator.fail.add('chair');
    const { instance, events, updated, onProgress } = service(generator);
    await instance.generate('a study', onProgress);
    await finished(events);
    expect(generator.started).toEqual(['chair', 'desk', 'lamp']);
    expect(events.at(-1)?.warnings).toEqual([
      "Couldn't make a rocking chair, used a simple shape.",
      'Made a new model for the desk.',
      'Made a new model for the floor lamp.',
    ]);
    expect(updated).toHaveLength(2);
    const room = await readRoom();
    expect(room.objects.find((o) => o.id === 'chair')?.model).toBeUndefined();
    expect(room.objects.find((o) => o.id === 'chair')?.parts?.length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(path.join(dir, UUID, 'generation.json'), 'utf8')).couldNotMake).toEqual(['chair']);
  });

  it('keeps the simple shape and warns when the real footprint would overlap something', async () => {
    const generator = new FakeGenerator();
    generator.sizes.set('lamp', [5, 1.5, 5]);
    const { instance, events, updated, onProgress } = service(generator);
    await instance.generate('a study', onProgress);
    await finished(events);
    const notes = events.at(-1)?.warnings ?? [];
    expect(notes.find((n) => n.startsWith('Made a new floor lamp but'))).toMatch(/so kept a simple shape\.$/);
    expect(updated).toHaveLength(2);
    expect((await readRoom()).objects.find((o) => o.id === 'lamp')?.model).toBeUndefined();
  });

  it('cancel stops the background work too and leaves the room as it is', async () => {
    const generator = new FakeGenerator();
    generator.gate = (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    const { instance, events, updated, onProgress } = service(generator);
    await instance.generate('a study', onProgress);
    await vi.waitFor(() => expect(generator.started).toEqual(['chair']));
    expect(instance.cancel()).toBe(true);
    await finished(events);
    expect(generator.signals[0].aborted).toBe(true);
    expect(generator.started).toEqual(['chair']);
    expect(events.at(-1)).toMatchObject({ message: 'Stopped making objects', roomId: ROOM_ID });
    expect(events.at(-1)?.warnings).toEqual([
      'Stopped before making the rocking chair, used a simple shape.',
      'Stopped before making the desk, used a simple shape.',
      'Stopped before making the floor lamp, used a simple shape.',
    ]);
    expect(updated).toEqual([]);
    expect(instance.busy).toBe(false);
    expect((await readRoom()).objects.find((o) => o.id === 'chair')?.parts?.length).toBeGreaterThan(0);
  });

  it('deleting the room stops making objects for it', async () => {
    const generator = new FakeGenerator();
    generator.gate = (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    const { instance, events, updated, onProgress } = service(generator);
    await instance.generate('a study', onProgress);
    await vi.waitFor(() => expect(generator.started).toEqual(['chair']));
    await instance.delete(ROOM_ID);
    await finished(events);
    expect(updated).toEqual([]);
    expect(generator.started).toEqual(['chair']);
    expect(instance.busy).toBe(false);
  });

  it.each([
    ['switched off', { enabled: false }],
    ['the image and 3D steps are not set up', { available: false }],
    ['the limit is 0', { maxPerRoom: 0 }],
  ])('makes nothing when %s: every missing object is a simple shape right away', async (_name, settings) => {
    const generator = new FakeGenerator();
    const { instance, events, onProgress } = service(generator, settings);
    const result = await instance.generate('a study', onProgress);
    expect(result.making).toBeUndefined();
    expect(result.warnings).toEqual([
      "Couldn't find a floor lamp, used a simple shape.",
      "Couldn't find a rocking chair, used a simple shape.",
      "Couldn't find a desk, used a simple shape.",
      "Couldn't find a rug, used a simple shape.",
    ]);
    expect(events.at(-1)).toMatchObject({ phase: 'done', message: 'Done, with notes' });
    expect(generator.started).toEqual([]);
    expect(instance.busy).toBe(false);
  });

  it('puts the most important objects first', () => {
    const objects = layout().objects;
    expect(makeOrder(objects).map((o) => o.id)).toEqual(['chair', 'desk', 'lamp', 'rug']);
  });
});

describe('with the real generated source', () => {
  it('makes an object for the first room and finds it again, ready-made, for the next', async () => {
    const calls: string[] = [];
    const comfy = {
      uploadImage: async () => 'aiembodied/x.png',
      run: async (_graph: unknown, options?: { output?: string }) => {
        calls.push(options?.output === 'mesh' ? 'mesh' : 'image');
        return options?.output === 'mesh' ? makeGlb({ min: [-0.3, 0, -0.3], max: [0.3, 0.9, 0.3] }) : Buffer.from('png');
      },
    };
    const generated = new GeneratedSource({
      library: new GeneratedLibrary(path.join(dir, 'assets')),
      pickComfy: async () => comfy,
      imageModel: async () => ({ id: 'q', name: 'Qwen', family: 'qwen-image-2.1', model: 'q', clip: 'c', vae: 'v' }),
      geometryModel: async () => ({ kind: 'trellis2', id: 't', name: 'T', unet: 't', shapeVae: 's', textureVae: 'x' }),
    });
    const rooms = path.join(dir, 'rooms');
    const ids = ['11111111-2222-3333-4444-555555555555', '11111111-2222-3333-4444-666666666666'];
    const events: RoomGenerationProgress[] = [];
    const build = () =>
      new RoomGenerationService({
        roomsDirectory: rooms,
        writeLayout: async () => layout(),
        sources: [generated],
        generator: generated,
        objectSettings: () => ({ enabled: true, maxPerRoom: 1, available: true }),
        uuid: () => ids.shift()!,
        seed: () => 5,
      });

    const first = build();
    await first.generate('a study', (e) => events.push(e));
    await vi.waitFor(() => expect(events.at(-1)?.phase).toBe('done'));
    expect(calls).toEqual(['image', 'mesh']);
    expect(events.at(-1)?.warnings?.[0]).toBe('Made a new model for the rocking chair.');
    // The cap was 1: the chair came first, the desk and lamp stayed shapes.
    const firstRoom = validateRoomFile(JSON.parse(await readFile(path.join(rooms, '11111111-2222-3333-4444-555555555555', 'room.json'), 'utf8')));
    expect(firstRoom.objects.find((o) => o.id === 'chair')?.model?.asset).toMatch(/^generated\/rocking-chair-/);

    // The next room asks for the same objects; the chair is found at once, so only one more is made.
    const secondEvents: RoomGenerationProgress[] = [];
    const second = build();
    const result = await second.generate('another study', (e) => secondEvents.push(e));
    expect(result.making).toBe(2);
    const secondRoom = validateRoomFile(JSON.parse(await readFile(path.join(rooms, '11111111-2222-3333-4444-666666666666', 'room.json'), 'utf8')));
    expect(secondRoom.objects.find((o) => o.id === 'chair')?.model?.asset).toBe(firstRoom.objects.find((o) => o.id === 'chair')?.model?.asset);
    await vi.waitFor(() => expect(secondEvents.at(-1)?.phase).toBe('done'));
    expect(calls).toEqual(['image', 'mesh', 'image', 'mesh']);
  });
});
