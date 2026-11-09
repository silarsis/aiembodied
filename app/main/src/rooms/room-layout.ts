/**
 * The layout a language model writes for a described room (see docs/features/3d-rooms.md,
 * "Describing a room"), and the checks that turn untrusted model output into a clean RoomLayout.
 * Pure: no network, no files.
 */
import { LIGHTING_PRESETS, type LightingPreset } from './room-palette.js';

export const WALL_NAMES = ['north', 'south', 'east', 'west'] as const;
export type WallSide = (typeof WALL_NAMES)[number];
export const OBJECT_CATEGORIES = ['seat', 'table', 'storage', 'bed', 'lamp', 'decor', 'plant', 'prop', 'appliance'] as const;
export type ObjectCategory = (typeof OBJECT_CATEGORIES)[number];
export const MAX_LAYOUT_OBJECTS = 14;

export interface LayoutPlace {
  against: WallSide | null;
  near: string | null;
  on: string | null;
  facing: string | null;
  corner: boolean;
}

export interface LayoutObject {
  id: string;
  name: string;
  /** Words for the model library search. */
  search: string;
  category: ObjectCategory;
  /** Width, height, depth in metres. */
  size: [number, number, number];
  place: LayoutPlace;
  /** Colour word or hex for the simple shape used when no model is found. */
  color: string | null;
  seatHeight: number | null;
  grabbable: boolean;
  surface: boolean;
  idle: string | null;
}

export interface RoomLayout {
  name: string;
  description: string;
  shell: {
    width: number;
    depth: number;
    height: number;
    floor: string;
    walls: string;
    windows: Array<{ wall: WallSide; width: number }>;
    door: { wall: WallSide } | null;
  };
  lighting: LightingPreset;
  objects: LayoutObject[];
}

export class LayoutError extends Error {}

function fail(problem: string): never {
  throw new LayoutError(problem);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, where: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${where} must be a non-empty string`);
  return value.trim().slice(0, max);
}
function optionalText(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}
function number(value: unknown, where: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(`${where} must be a number`);
  return n;
}
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
function wall(value: unknown, where: string): WallSide {
  const w = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!(WALL_NAMES as readonly string[]).includes(w)) fail(`${where} must be one of north, south, east, west`);
  return w as WallSide;
}
function nullableWall(value: unknown, where: string): WallSide | null {
  return value === null || value === undefined || value === '' || value === 'none' ? null : wall(value, where);
}
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const LIGHTING_ALIASES: Array<[RegExp, LightingPreset]> = [
  [/night|moon|dark|evening.*cool/, 'cool night'],
  [/evening|sunset|dusk|warm|cosy|cozy|lamp/, 'warm evening'],
  [/morning|dawn|soft/, 'soft morning'],
  [/day|bright|sun|noon/, 'bright day'],
];
function lighting(value: unknown): LightingPreset {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((LIGHTING_PRESETS as readonly string[]).includes(raw)) return raw as LightingPreset;
  for (const [pattern, preset] of LIGHTING_ALIASES) if (pattern.test(raw)) return preset;
  return 'neutral';
}

/**
 * Checks and normalises the model's JSON. Throws a LayoutError naming the first real problem
 * (the retry sends that text back to the model). Small slips are fixed quietly: ids become slugs,
 * numbers are clamped, references to unknown objects are dropped, extra objects are cut.
 */
export function validateLayout(raw: unknown): RoomLayout {
  if (!isRecord(raw)) fail('the reply must be one JSON object');
  const shellRaw = raw.shell;
  if (!isRecord(shellRaw)) fail('"shell" must be an object with width, depth, height, floor, walls');
  const shell: RoomLayout['shell'] = {
    width: clamp(number(shellRaw.width, 'shell.width'), 3, 10),
    depth: clamp(number(shellRaw.depth, 'shell.depth'), 3, 10),
    height: clamp(number(shellRaw.height ?? 2.8, 'shell.height'), 2.4, 3.5),
    floor: optionalText(shellRaw.floor, 40) ?? 'warm oak',
    walls: optionalText(shellRaw.walls, 40) ?? 'cream',
    windows: [],
    door: null,
  };
  if (shellRaw.windows !== undefined && shellRaw.windows !== null) {
    if (!Array.isArray(shellRaw.windows)) fail('shell.windows must be a list');
    shellRaw.windows.slice(0, 4).forEach((entry, index) => {
      if (!isRecord(entry)) fail(`shell.windows[${index}] must be an object with wall and width`);
      shell.windows.push({
        wall: wall(entry.wall, `shell.windows[${index}].wall`),
        width: clamp(entry.width === undefined ? 1.4 : number(entry.width, `shell.windows[${index}].width`), 0.6, 3),
      });
    });
  }
  if (isRecord(shellRaw.door)) shell.door = { wall: wall(shellRaw.door.wall, 'shell.door.wall') };

  if (!Array.isArray(raw.objects) || raw.objects.length === 0) fail('"objects" must be a list with at least one object');
  const objects: LayoutObject[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of raw.objects.slice(0, MAX_LAYOUT_OBJECTS).entries()) {
    const where = `objects[${index}]`;
    if (!isRecord(entry)) fail(`${where} must be an object`);
    const name = text(entry.name ?? entry.id, `${where}.name`, 60);
    let id = slug(typeof entry.id === 'string' && entry.id.trim() ? entry.id : name) || `object-${index + 1}`;
    for (let n = 2; ids.has(id); n += 1) id = `${slug(name) || 'object'}-${n}`;
    ids.add(id);
    const categoryRaw = typeof entry.category === 'string' ? entry.category.trim().toLowerCase() : '';
    if (!(OBJECT_CATEGORIES as readonly string[]).includes(categoryRaw))
      fail(`${where}.category must be one of ${OBJECT_CATEGORIES.join(', ')}`);
    const category = categoryRaw as ObjectCategory;
    if (!Array.isArray(entry.size) || entry.size.length !== 3) fail(`${where}.size must be [width, height, depth] in metres`);
    const size = entry.size.map((n, i) => clamp(number(n, `${where}.size[${i}]`), 0.03, 6)) as [number, number, number];
    const placeRaw = isRecord(entry.place) ? entry.place : {};
    const place: LayoutPlace = {
      against: nullableWall(placeRaw.against, `${where}.place.against`),
      near: optionalText(placeRaw.near, 40),
      on: optionalText(placeRaw.on, 40),
      facing: optionalText(placeRaw.facing, 40),
      corner: placeRaw.corner === true,
    };
    const seatHeightRaw = entry.seat_height ?? entry.seatHeight;
    const grabbable = entry.grabbable === true;
    objects.push({
      id,
      name,
      search: optionalText(entry.search, 80) ?? name,
      category,
      size,
      place,
      color: optionalText(entry.color, 40),
      seatHeight:
        seatHeightRaw === undefined || seatHeightRaw === null ? null : clamp(number(seatHeightRaw, `${where}.seat_height`), 0.15, 0.9),
      grabbable,
      surface: entry.surface === true,
      idle: optionalText(entry.idle, 80),
    });
  }
  // References are by id or by name; unknown ones are dropped (the object is then just placed freely).
  const byKey = new Map<string, string>();
  for (const object of objects) {
    byKey.set(object.id, object.id);
    byKey.set(object.name.toLowerCase(), object.id);
    byKey.set(slug(object.name), object.id);
  }
  const resolve = (value: string | null, self: string): string | null => {
    if (!value) return null;
    const found = byKey.get(value) ?? byKey.get(value.toLowerCase()) ?? byKey.get(slug(value));
    return found && found !== self ? found : null;
  };
  for (const object of objects) {
    object.place.near = resolve(object.place.near, object.id);
    object.place.on = resolve(object.place.on, object.id);
    const facing = object.place.facing;
    object.place.facing = facing && /^(center|centre|room)$/i.test(facing) ? 'center' : resolve(facing, object.id);
    if (object.place.on) object.place.against = null;
  }
  // `on` chains must end at the floor: drop a link that would loop.
  for (const object of objects) {
    const seen = new Set([object.id]);
    for (let next = object.place.on; next; ) {
      if (seen.has(next)) {
        object.place.on = null;
        break;
      }
      seen.add(next);
      next = objects.find((o) => o.id === next)?.place.on ?? null;
    }
  }
  return {
    name: optionalText(raw.name, 60) ?? 'New room',
    description: optionalText(raw.description, 300) ?? '',
    shell,
    lighting: lighting(raw.lighting),
    objects,
  };
}
