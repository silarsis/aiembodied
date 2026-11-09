import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RoomFile, RoomSummary } from './types.js';
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
    return { ...room, id };
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
