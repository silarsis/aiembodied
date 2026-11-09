import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ASSET_FOLDER } from './asset-folder.js';
import { OBJECT_CATEGORIES, type ObjectCategory } from './room-layout.js';
import { DEFAULT_COLOR, resolveColor } from './room-palette.js';
import { buildParts } from './room-primitives.js';
import type { RoomFile, RoomObject, RoomSummary } from './types.js';
import { validateRoomFile } from './validate.js';

const BUILTIN_PREFIX = 'room:builtin:';
const SAVED_PREFIX = 'room:';
const STEM = /^[a-z0-9][a-z0-9-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Options {
  assetsDirectory: string;
  roomsDirectory: string;
}

/** Lists and loads rooms: the ones shipped in assets plus saved ones under userData/rooms/<uuid>/room.json. */
export class RoomService {
  constructor(private readonly options: Options) {}

  private fileFor(id: string): string | null {
    if (id.startsWith(BUILTIN_PREFIX)) {
      const stem = id.slice(BUILTIN_PREFIX.length);
      return STEM.test(stem) ? path.join(this.options.assetsDirectory, `${stem}.json`) : null;
    }
    if (id.startsWith(SAVED_PREFIX)) {
      const uuid = id.slice(SAVED_PREFIX.length);
      return UUID.test(uuid) ? path.join(this.options.roomsDirectory, uuid, 'room.json') : null;
    }
    return null;
  }

  /** Synchronous so the background selection can check it. */
  hasRoom(id: string): boolean {
    const file = this.fileFor(id);
    return file !== null && existsSync(file);
  }

  async load(id: string): Promise<RoomFile> {
    const file = this.fileFor(id);
    if (!file || !existsSync(file)) throw new Error('This room is not available.');
    const room = validateRoomFile(JSON.parse(await readFile(file, 'utf8')) as unknown);
    const loaded = id.startsWith(SAVED_PREFIX) && !id.startsWith(BUILTIN_PREFIX) ? await this.withoutMissingModels(room, path.dirname(file)) : room;
    return { ...loaded, id };
  }

  /**
   * A model that is no longer in the asset cache (a generated object that was deleted, a library
   * download that was cleared) is replaced by simple shapes, sized like the object, so the room
   * still looks right without the renderer trying to fetch it. The room's layout.json says what
   * the object was; without it a plain box stands in.
   */
  private async withoutMissingModels(room: RoomFile, roomFolder: string): Promise<RoomFile> {
    const assets = path.join(this.options.roomsDirectory, ASSET_FOLDER);
    const missing = room.objects.filter((object) => {
      const model = object.model;
      if (!model?.asset) return false;
      const file = path.resolve(assets, ...model.asset.split('/'), ...model.file.split('/'));
      return !file.startsWith(path.resolve(assets) + path.sep) || !existsSync(file);
    });
    if (missing.length === 0) return room;
    const layoutObjects = await readLayoutObjects(roomFolder);
    const gone = new Set(missing.map((object) => object.id));
    return {
      ...room,
      objects: room.objects.map((object) => {
        if (!gone.has(object.id)) return object;
        const rest: RoomObject = { ...object };
        delete rest.model;
        const known = layoutObjects.get(object.id);
        const seatHeight = object.tags?.sit?.position[1];
        const parts = buildParts({
          category: known?.category ?? 'prop',
          name: object.name,
          size: object.size,
          color: resolveColor(known?.color, DEFAULT_COLOR),
          ...(seatHeight !== undefined ? { seatHeight } : {}),
        });
        return { ...rest, parts } satisfies RoomObject;
      }),
    };
  }

  async list(): Promise<RoomSummary[]> {
    const result: RoomSummary[] = [];
    const builtIn = (await readdir(this.options.assetsDirectory).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((stem) => STEM.test(stem))
      .sort();
    for (const stem of builtIn) await this.add(result, `${BUILTIN_PREFIX}${stem}`, true);
    const saved = (await readdir(this.options.roomsDirectory).catch(() => [] as string[]))
      .filter((name) => UUID.test(name))
      .sort();
    for (const uuid of saved) await this.add(result, `${SAVED_PREFIX}${uuid}`, false);
    return result;
  }

  private async add(result: RoomSummary[], id: string, builtIn: boolean): Promise<void> {
    try {
      const room = await this.load(id);
      result.push({
        id,
        name: room.name,
        builtIn,
        ...(room.description ? { description: room.description } : {}),
      });
    } catch (error) {
      if (builtIn) throw error;
      console.warn(`Skipping saved room ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function readLayoutObjects(roomFolder: string): Promise<Map<string, { category: ObjectCategory; color: string | null }>> {
  const result = new Map<string, { category: ObjectCategory; color: string | null }>();
  try {
    const layout = JSON.parse(await readFile(path.join(roomFolder, 'layout.json'), 'utf8')) as { objects?: Array<Record<string, unknown>> };
    for (const object of layout.objects ?? []) {
      if (typeof object.id !== 'string' || !(OBJECT_CATEGORIES as readonly unknown[]).includes(object.category)) continue;
      result.set(object.id, { category: object.category as ObjectCategory, color: typeof object.color === 'string' ? object.color : null });
    }
  } catch {
    /* No layout.json (or damaged): plain boxes. */
  }
  return result;
}
