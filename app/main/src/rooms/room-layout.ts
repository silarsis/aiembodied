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

/**
 * Words the model might use instead of one of the known categories, and the category whose
 * behaviour they get (sitting, surfaces, wall snapping, library filter, fallback shape, make order).
 * Anything else becomes a "prop": placed freely, searched in the whole library, drawn as a box.
 */
const CATEGORY_WORDS: Array<[ObjectCategory, string[]]> = [
  ['seat', ['seat', 'seating', 'chair', 'armchair', 'sofa', 'couch', 'settee', 'loveseat', 'stool', 'bench', 'ottoman', 'pouf', 'beanbag', 'recliner']],
  ['bed', ['bed', 'futon', 'cot', 'bunk', 'daybed', 'mattress', 'crib', 'hammock']],
  ['table', ['table', 'desk', 'counter', 'workbench', 'nightstand', 'bar', 'island', 'surface']],
  ['storage', ['storage', 'shelf', 'shelves', 'shelving', 'bookshelf', 'bookcase', 'cabinet', 'cupboard', 'wardrobe', 'dresser', 'drawers', 'chest', 'sideboard', 'closet', 'rack', 'locker', 'trunk']],
  ['lamp', ['lamp', 'light', 'lighting', 'lantern', 'chandelier', 'sconce', 'candle']],
  ['plant', ['plant', 'plants', 'flower', 'flowers', 'tree', 'cactus', 'fern', 'succulent', 'bonsai', 'greenery', 'houseplant', 'planter']],
  ['appliance', ['appliance', 'electronics', 'electronic', 'device', 'tv', 'television', 'fridge', 'refrigerator', 'oven', 'stove', 'microwave', 'computer', 'monitor', 'speaker', 'washer', 'dishwasher', 'fireplace', 'heater', 'fan']],
  ['decor', ['decor', 'decoration', 'decorative', 'art', 'artwork', 'painting', 'poster', 'picture', 'frame', 'rug', 'carpet', 'mat', 'curtain', 'curtains', 'mirror', 'clock', 'vase', 'sculpture', 'statue', 'ornament', 'tapestry', 'cushion', 'pillow', 'throw']],
  ];
const CATEGORY_BY_WORD = new Map<string, ObjectCategory>();
for (const [category, words] of CATEGORY_WORDS) for (const word of words) CATEGORY_BY_WORD.set(word, category);

function categoryFromWords(value: string): ObjectCategory | null {
  // Last word first: "coffee table", "reading lamp", "floor cushion" name the thing at the end.
  const words = value.toLowerCase().split(/[^a-z]+/).filter(Boolean).reverse();
  for (const word of words) {
    const found = CATEGORY_BY_WORD.get(word) ?? (word.length > 3 && word.endsWith('s') ? CATEGORY_BY_WORD.get(word.slice(0, -1)) : undefined);
    if (found) return found;
  }
  return null;
}

/**
 * Turns whatever category word the model wrote into one the room code knows. Known categories are
 * kept; other words (and, failing that, the object's name) are matched against a word table; the
 * rest become "prop". `label` keeps the model's own word when it was not a known category.
 */
export function normaliseCategory(raw: unknown, name = ''): { category: ObjectCategory; label?: string } {
  const word = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 40) : '';
  if ((OBJECT_CATEGORIES as readonly string[]).includes(word)) return { category: word as ObjectCategory };
  // Vague words ("furniture", "item") match nothing here, so the name decides.
  const category = (word && categoryFromWords(word)) || categoryFromWords(name) || 'prop';
  return word ? { category, label: word } : { category };
}

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
  /** What the room code treats it as; free-form words from the model are mapped onto these. */
  category: ObjectCategory;
  /** The model's own category word, when it was not one of OBJECT_CATEGORIES. */
  label?: string;
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
/** A wall, or null when there is none or the word is not a wall (the object is then placed freely). */
function looseWall(value: unknown): WallSide | null {
  const w = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (WALL_NAMES as readonly string[]).includes(w) ? (w as WallSide) : null;
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
 * Checks and normalises the model's JSON. Throws a LayoutError naming the problem only when the
 * room as a whole is unusable (the retry sends that text back to the model): no shell, or no usable
 * object at all. Smaller slips are fixed quietly: ids become slugs, numbers are clamped, unknown
 * categories are mapped (see normaliseCategory), bad walls become null, references to unknown
 * objects are dropped, extra objects are cut, and an object that cannot be used (no name, no size)
 * is left out. Each thing left out is reported through `notes`, when given.
 */
export function validateLayout(raw: unknown, notes?: string[]): RoomLayout {
  const note = (problem: string) => notes?.push(problem);
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
      const side = isRecord(entry) ? looseWall(entry.wall) : null;
      if (!isRecord(entry) || !side) {
        note(`shell.windows[${index}] skipped: needs a wall (north, south, east or west)`);
        return;
      }
      const width = typeof entry.width === 'number' || typeof entry.width === 'string' ? Number(entry.width) : 1.4;
      shell.windows.push({ wall: side, width: clamp(Number.isFinite(width) ? width : 1.4, 0.6, 3) });
    });
  }
  if (isRecord(shellRaw.door)) {
    const side = looseWall(shellRaw.door.wall);
    if (side) shell.door = { wall: side };
    else note('shell.door skipped: its wall is not north, south, east or west');
  }

  if (!Array.isArray(raw.objects) || raw.objects.length === 0) fail('"objects" must be a list with at least one object');
  const objects: LayoutObject[] = [];
  const ids = new Set<string>();
  const problems: string[] = [];
  for (const [index, entry] of raw.objects.slice(0, MAX_LAYOUT_OBJECTS).entries()) {
    try {
      const object = readObject(entry, `objects[${index}]`, index, ids);
      ids.add(object.id);
      objects.push(object);
    } catch (error) {
      if (!(error instanceof LayoutError)) throw error;
      problems.push(error.message);
      note(`skipped: ${error.message}`);
    }
  }
  if (objects.length === 0) fail(problems[0] ?? 'no usable objects');
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

/** One object of the layout; throws a LayoutError when it cannot be used at all. */
function readObject(entry: unknown, where: string, index: number, ids: Set<string>): LayoutObject {
  if (!isRecord(entry)) fail(`${where} must be an object`);
  const name = text(entry.name ?? entry.id, `${where}.name`, 60);
  let id = slug(typeof entry.id === 'string' && entry.id.trim() ? entry.id : name) || `object-${index + 1}`;
  for (let n = 2; ids.has(id); n += 1) id = `${slug(name) || 'object'}-${n}`;
  const { category, label } = normaliseCategory(entry.category, name);
  if (!Array.isArray(entry.size) || entry.size.length !== 3) fail(`${where}.size must be [width, height, depth] in metres`);
  const size = entry.size.map((n, i) => clamp(number(n, `${where}.size[${i}]`), 0.03, 6)) as [number, number, number];
  const placeRaw = isRecord(entry.place) ? entry.place : {};
  const place: LayoutPlace = {
    against: looseWall(placeRaw.against),
    near: optionalText(placeRaw.near, 40),
    on: optionalText(placeRaw.on, 40),
    facing: optionalText(placeRaw.facing, 40),
    corner: placeRaw.corner === true,
  };
  const seatHeightRaw = entry.seat_height ?? entry.seatHeight;
  const seatHeight = seatHeightRaw === undefined || seatHeightRaw === null || seatHeightRaw === '' ? NaN : Number(seatHeightRaw);
  return {
    id,
    name,
    search: optionalText(entry.search, 80) ?? name,
    category,
    ...(label ? { label } : {}),
    size,
    place,
    color: optionalText(entry.color, 40),
    seatHeight: Number.isFinite(seatHeight) ? clamp(seatHeight, 0.15, 0.9) : null,
    grabbable: entry.grabbable === true,
    surface: entry.surface === true,
    idle: optionalText(entry.idle, 80),
  };
}
