import type { RoomFile } from './types.js';

const WALLS = ['north', 'south', 'east', 'west'];
const LIGHTS = ['ambient', 'directional', 'point', 'hemisphere'];
const MAX_OBJECTS = 200;
const ASSET_REF = /^[a-z0-9_-]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const MAX_PARTS = 100;

function fail(where: string, problem: string): never {
  throw new Error(`Invalid room file: ${where} ${problem}.`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(where, 'must be an object');
  return value;
}
function num(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, 'must be a finite number');
  return value;
}
function positive(value: unknown, where: string): number {
  const n = num(value, where);
  if (n <= 0) fail(where, 'must be greater than zero');
  return n;
}
function str(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(where, 'must be a non-empty string');
  return value;
}
function vec3(value: unknown, where: string): void {
  if (!Array.isArray(value) || value.length !== 3) fail(where, 'must be three numbers');
  value.forEach((entry, index) => num(entry, `${where}[${index}]`));
}
function color(value: unknown, where: string): void {
  if (typeof value !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value))
    fail(where, 'must be a hex colour such as #aabbcc');
}
function array(value: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(where, 'must be a list');
  if (value.length > max) fail(where, `can have at most ${max} entries`);
  return value;
}
function optionalColorBlock(value: unknown, where: string): void {
  if (value === undefined || value === null) return;
  color(record(value, where).color, `${where}.color`);
}

/** Checks untrusted room JSON and returns it typed. Throws an Error that names the first problem. */
export function validateRoomFile(raw: unknown): RoomFile {
  const room = record(raw, 'room');
  if (room.version !== 1) fail('version', 'must be 1');
  str(room.id, 'id');
  str(room.name, 'name');
  if (room.description !== undefined && typeof room.description !== 'string')
    fail('description', 'must be text');

  const shell = record(room.shell, 'shell');
  const width = positive(shell.width, 'shell.width');
  const depth = positive(shell.depth, 'shell.depth');
  const height = positive(shell.height, 'shell.height');
  if (width > 100 || depth > 100 || height > 30) fail('shell', 'is too large');
  optionalColorBlock(record(shell.floor, 'shell.floor'), 'shell.floor');
  optionalColorBlock(record(shell.walls, 'shell.walls'), 'shell.walls');
  optionalColorBlock(shell.ceiling, 'shell.ceiling');
  optionalColorBlock(shell.outside, 'shell.outside');
  if (shell.openings !== undefined) {
    array(shell.openings, 'shell.openings', 40).forEach((entry, index) => {
      const where = `shell.openings[${index}]`;
      const opening = record(entry, where);
      if (typeof opening.wall !== 'string' || !WALLS.includes(opening.wall))
        fail(`${where}.wall`, 'must be north, south, east or west');
      if (opening.kind !== 'window' && opening.kind !== 'door')
        fail(`${where}.kind`, 'must be window or door');
      const offset = num(opening.offset, `${where}.offset`);
      const w = positive(opening.width, `${where}.width`);
      const h = positive(opening.height, `${where}.height`);
      const sill = opening.sill === undefined ? 0 : num(opening.sill, `${where}.sill`);
      if (sill < 0) fail(`${where}.sill`, 'cannot be negative');
      const wallLength = opening.wall === 'north' || opening.wall === 'south' ? width : depth;
      if (Math.abs(offset) + w / 2 > wallLength / 2) fail(where, 'does not fit on its wall');
      if (sill + h > height) fail(where, 'is taller than the room');
    });
  }

  array(room.lights, 'lights', 40).forEach((entry, index) => {
    const where = `lights[${index}]`;
    const light = record(entry, where);
    if (typeof light.type !== 'string' || !LIGHTS.includes(light.type))
      fail(`${where}.type`, 'is not a known light type');
    color(light.color, `${where}.color`);
    if (num(light.intensity, `${where}.intensity`) < 0) fail(`${where}.intensity`, 'cannot be negative');
    if (light.position !== undefined) vec3(light.position, `${where}.position`);
    if (light.groundColor !== undefined) color(light.groundColor, `${where}.groundColor`);
  });

  const camera = record(room.camera, 'camera');
  vec3(camera.position, 'camera.position');
  vec3(camera.target, 'camera.target');
  const fov = num(camera.fov, 'camera.fov');
  if (fov <= 1 || fov >= 150) fail('camera.fov', 'must be between 1 and 150 degrees');

  const home = record(room.home, 'home');
  vec3(home.position, 'home.position');
  num(home.facing, 'home.facing');

  const ids = new Set<string>();
  const halfW = width / 2;
  const halfD = depth / 2;
  array(room.objects, 'objects', MAX_OBJECTS).forEach((entry, index) => {
    const where = `objects[${index}]`;
    const object = record(entry, where);
    const id = str(object.id, `${where}.id`);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) fail(`${where}.id`, 'must be a lowercase slug');
    if (ids.has(id)) fail(`${where}.id`, `"${id}" is used twice`);
    ids.add(id);
    str(object.name, `${where}.name`);
    vec3(object.position, `${where}.position`);
    const position = object.position as number[];
    if (Math.abs(position[0]) > halfW || Math.abs(position[2]) > halfD || position[1] < 0 || position[1] > height)
      fail(`${where}.position`, 'is outside the room');
    if (object.rotationY !== undefined) num(object.rotationY, `${where}.rotationY`);
    vec3(object.size, `${where}.size`);
    (object.size as number[]).forEach((n, i) => positive(n, `${where}.size[${i}]`));
    if (object.collider !== undefined && object.collider !== 'box' && object.collider !== 'none')
      fail(`${where}.collider`, 'must be box or none');
    if (object.dynamic !== undefined && typeof object.dynamic !== 'boolean')
      fail(`${where}.dynamic`, 'must be true or false');
    if (object.model !== undefined && object.model !== null) {
      const file = str(record(object.model, `${where}.model`).file, `${where}.model.file`);
      if (file.includes('..') || /^([a-zA-Z]:|[\\/])/.test(file))
        fail(`${where}.model.file`, 'must stay inside the room folder');
      const model = object.model as Record<string, unknown>;
      if (model.asset !== undefined) {
        if (typeof model.asset !== 'string' || !ASSET_REF.test(model.asset))
          fail(`${where}.model.asset`, 'must look like polyhaven/<id> or generated/<folder>');
      }
      if (model.scale !== undefined && (positive(model.scale, `${where}.model.scale`) > 20))
        fail(`${where}.model.scale`, 'is too large');
    }
    if (object.parts !== undefined) {
      array(object.parts, `${where}.parts`, MAX_PARTS).forEach((partRaw, p) => {
        const pw = `${where}.parts[${p}]`;
        const part = record(partRaw, pw);
        vec3(part.offset, `${pw}.offset`);
        color(part.color, `${pw}.color`);
        if (part.rotation !== undefined) vec3(part.rotation, `${pw}.rotation`);
        if (part.shape === 'box') {
          vec3(part.size, `${pw}.size`);
          (part.size as number[]).forEach((n, i) => positive(n, `${pw}.size[${i}]`));
        } else if (part.shape === 'cylinder') {
          positive(part.radius, `${pw}.radius`);
          positive(part.height, `${pw}.height`);
        } else if (part.shape === 'sphere') {
          positive(part.radius, `${pw}.radius`);
        } else fail(`${pw}.shape`, 'must be box, cylinder or sphere');
      });
    }
    if (object.tags !== undefined) {
      const tags = record(object.tags, `${where}.tags`);
      for (const key of ['sit', 'stand'] as const) {
        if (tags[key] === undefined) continue;
        const tag = record(tags[key], `${where}.tags.${key}`);
        vec3(tag.position, `${where}.tags.${key}.position`);
        num(tag.facing, `${where}.tags.${key}.facing`);
      }
      if (tags.grab !== undefined) vec3(record(tags.grab, `${where}.tags.grab`).position, `${where}.tags.grab.position`);
      if (tags.look !== undefined) vec3(record(tags.look, `${where}.tags.look`).position, `${where}.tags.look.position`);
      if (tags.surface !== undefined)
        positive(record(tags.surface, `${where}.tags.surface`).height, `${where}.tags.surface.height`);
      if (tags.idle !== undefined && typeof tags.idle !== 'string') fail(`${where}.tags.idle`, 'must be text');
    }
  });
  return raw as RoomFile;
}
