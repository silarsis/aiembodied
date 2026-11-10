import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundService } from '../src/backgrounds/background-service.js';
import type { GeometryModel } from '../src/avatar/generation/character-model-service.js';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { refitObject } from '../src/rooms/room-refit.js';
import { objectMakingAvailable, pickSingleImageGeometry } from '../src/rooms/room-generation-setup.js';
import { DEFAULT_OBJECT_SETTINGS, parseObjectSettings, sanitizeObjectSettings } from '../src/rooms/object-settings.js';
import type { ResolvedModel } from '../src/rooms/room-placer.js';
import type { RoomFile, RoomObject } from '../src/rooms/types.js';

function room(objects: RoomObject[]): RoomFile {
  return {
    version: 1,
    id: 'room:x',
    name: 'Room',
    shell: { width: 6, depth: 5, height: 2.8, floor: { color: '#886644' }, walls: { color: '#dddddd' } },
    lights: [],
    camera: { position: [0, 1.5, 2], target: [0, 1, 0], fov: 50 },
    home: { position: [0, 0, 1.5], facing: 0 },
    objects,
  };
}
const chair = (patch: Partial<RoomObject> = {}): RoomObject => ({
  id: 'chair',
  name: 'chair',
  position: [-1.5, 0, -1],
  rotationY: 0,
  size: [0.6, 0.9, 0.6],
  parts: [{ shape: 'box', size: [0.6, 0.9, 0.6], offset: [0, 0.45, 0], color: '#aa0000' }],
  tags: { look: { position: [0, 0.54, 0] }, stand: { position: [0, 0, 0.8], facing: 180 } },
  ...patch,
});
const made = (size: [number, number, number]): ResolvedModel => ({ model: { asset: 'generated/chair-3fa91c2e', file: 'model.glb', scale: 0.7 }, size });

describe('refitObject', () => {
  it('swaps shapes for the model, keeping position and turn, and follows the new size', () => {
    const result = refitObject(room([chair({ rotationY: 90 })]), 'chair', made([0.7, 0.9, 0.8]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.room.objects[0];
    expect(next.parts).toBeUndefined();
    expect(next.model).toEqual({ asset: 'generated/chair-3fa91c2e', file: 'model.glb', scale: 0.7 });
    expect(next.size).toEqual([0.7, 0.9, 0.8]);
    expect(next.position).toEqual([-1.5, 0, -1]);
    expect(next.rotationY).toBe(90);
    expect(next.tags?.stand?.position).toEqual([0, 0, 0.9]);
    expect(next.tags?.look?.position[1]).toBeCloseTo(0.54);
  });

  it('refuses a footprint that overlaps another object, and says what', () => {
    const wall = chair({ id: 'sofa', name: 'sofa', position: [-0.9, 0, -1], size: [0.5, 0.9, 0.5] });
    const result = refitObject(room([chair(), wall]), 'chair', made([0.9, 0.9, 0.6]));
    expect(result).toEqual({ ok: false, reason: 'it would overlap the sofa' });
  });

  it('ignores rugs, and things on other surfaces', () => {
    const rug = chair({ id: 'rug', name: 'rug', position: [-1.5, 0, -1], size: [2, 0.02, 2], collider: 'none' });
    const mug = chair({ id: 'mug', name: 'mug', position: [-1.5, 0.75, -1], size: [0.1, 0.1, 0.1] });
    expect(refitObject(room([chair(), rug, mug]), 'chair', made([0.6, 0.9, 0.6])).ok).toBe(true);
  });

  it('slides in from a wall by a little, but not by a lot', () => {
    const atWall = chair({ position: [-2.68, 0, -1] });
    const near = refitObject(room([atWall]), 'chair', made([0.8, 0.9, 0.6]));
    expect(near.ok && near.room.objects[0].position[0]).toBeCloseTo(-2.58, 2);
    expect(refitObject(room([atWall]), 'chair', made([1.5, 0.9, 0.6]))).toEqual({ ok: false, reason: 'it would stick out through a wall' });
  });

  it('keeps clear of the spot where the avatar stands', () => {
    const result = refitObject(room([chair({ position: [0, 0, 0.9] })]), 'chair', made([0.6, 0.9, 0.6]));
    expect(result).toEqual({ ok: false, reason: 'it would be in the way of the spot where the avatar stands' });
  });

  it('reports an object that is gone', () => {
    expect(refitObject(room([]), 'chair', made([1, 1, 1]))).toEqual({ ok: false, reason: 'it is no longer in the room' });
  });
});

describe('object settings', () => {
  it('defaults to on, three per room', () => {
    expect(DEFAULT_OBJECT_SETTINGS).toEqual({ enabled: true, maxPerRoom: 3 });
    expect(parseObjectSettings(null)).toEqual({ enabled: true, maxPerRoom: 3 });
    expect(parseObjectSettings('not json')).toEqual({ enabled: true, maxPerRoom: 3 });
  });
  it('keeps the limit between 0 and 8 and ignores nonsense', () => {
    expect(sanitizeObjectSettings({ enabled: false, maxPerRoom: 12 })).toEqual({ enabled: false, maxPerRoom: 8 });
    expect(sanitizeObjectSettings({ maxPerRoom: -2 })).toEqual({ enabled: true, maxPerRoom: 0 });
    expect(sanitizeObjectSettings({ maxPerRoom: 2.6 }).maxPerRoom).toBe(3);
    expect(sanitizeObjectSettings({ enabled: 'yes', maxPerRoom: 'many' })).toEqual({ enabled: true, maxPerRoom: 3 });
  });
});

describe('BackgroundService object settings', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'bg-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it('saves under rooms.objects and merges partial changes', () => {
    const values = new Map<string, string>();
    const service = new BackgroundService({
      store: { getValue: (key) => values.get(key) ?? null, setValue: (key, value) => void values.set(key, value) },
      assetsDirectory: directory,
      backgroundsDirectory: directory,
      comfy: { isAvailable: async () => true, run: vi.fn() },
    });
    expect(service.getObjectSettings()).toEqual({ enabled: true, maxPerRoom: 3 });
    expect(service.setObjectSettings({ maxPerRoom: 5 })).toEqual({ enabled: true, maxPerRoom: 5 });
    expect(service.setObjectSettings({ enabled: false })).toEqual({ enabled: false, maxPerRoom: 5 });
    expect(JSON.parse(values.get('rooms.objects')!)).toEqual({ enabled: false, maxPerRoom: 5 });
    expect(service.getObjectSettings()).toEqual({ enabled: false, maxPerRoom: 5 });
  });
});

describe('the image and 3D steps', () => {
  it('count as set up when both routes have a server', () => {
    const routing = resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS));
    expect(objectMakingAvailable(routing)).toBe(true);
    expect(objectMakingAvailable({ ...routing, routes: { ...routing.routes, mesh: { server: 'gone' } } })).toBe(false);
  });

  const trellis: GeometryModel = { kind: 'trellis2', id: 't', name: 'TRELLIS.2', unet: 't', shapeVae: 's', textureVae: 'x' };
  const hunyuan: GeometryModel = { kind: 'hunyuan3d-2mv', id: 'h', name: 'Hunyuan3D 2mv', checkpoint: 'h' };
  const models = (geometry: Array<{ id: string; views?: boolean; available: boolean }>) => ({
    list: async () => ({ geometry: geometry.map((g) => ({ name: g.id, ...g })) }),
    resolveGeometry: async (id?: string) => (id === 't' ? trellis : hunyuan),
  });

  it('picks TRELLIS.2 for a single picture when it is installed', async () => {
    expect(await pickSingleImageGeometry(models([{ id: 'h', views: true, available: true }, { id: 't', available: true }]))).toBe(trellis);
  });
  it('else the studio default, Hunyuan3D 2mv from the front alone', async () => {
    expect(await pickSingleImageGeometry(models([{ id: 'h', views: true, available: true }, { id: 't', available: false }]))).toBe(hunyuan);
  });
});
