/**
 * Describe a room in words, get a 3D room: the layout model writes the layout, each object is
 * looked up through the object sources (model library first), the placer solves positions, and the
 * result is saved as `<roomsDirectory>/<uuid>/room.json` next to `layout.json` and `generation.json`.
 *
 * Delivery is in two phases. The room is saved and handed back as soon as it is placed, with simple
 * shapes for objects the library has nothing for. If a generator (the image-to-3D pipeline) is set
 * up, those objects are then made one at a time in the background, most important first, and each
 * one that comes out swaps its shapes for the model in room.json and calls `onRoomUpdated`.
 * One generation (including its background objects) at a time; it can be cancelled.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveObject, type ObjectSource } from './asset-library/library-source.js';
import type { LayoutObject, ObjectCategory, RoomLayout } from './room-layout.js';
import { placeRoom, type ResolvedModel } from './room-placer.js';
import { refitObject } from './room-refit.js';
import type { GeneratedObjectSummary, ObjectSettings } from './object-settings.js';
import type { RoomSummary } from './types.js';
import { validateRoomFile } from './validate.js';

export interface RoomGenerationProgress {
  phase: 'planning' | 'finding' | 'arranging' | 'making' | 'done';
  message: string;
  current?: number;
  total?: number;
  warnings?: string[];
  /** Set for the background phase: the saved room the objects are being made for. */
  roomId?: string;
}

export interface RoomGenerationResult {
  room: RoomSummary;
  warnings: string[];
  /** How many objects may still be made in the background (0 when none). */
  making?: number;
}

/** Makes objects the sources had nothing for; see `GeneratedSource`. */
export interface ObjectGenerator {
  /** An object made earlier, or null. */
  resolve(object: LayoutObject, signal?: AbortSignal): Promise<ResolvedModel | null>;
  /** Makes (or reuses) an object; throws when it cannot. */
  generate(object: LayoutObject, signal: AbortSignal): Promise<{ resolved: ResolvedModel; reused: boolean }>;
  list(): Promise<GeneratedObjectSummary[]>;
  remove(id: string): Promise<void>;
}

/** Most important first: things the avatar sits at, then what it stands at, then decoration. */
const MAKE_ORDER: Record<ObjectCategory, number> = { bed: 0, seat: 1, table: 2, storage: 3, appliance: 4, lamp: 5, plant: 6, decor: 7, prop: 8 };
/** Flat things (rugs) do not make good meshes. */
const MIN_MADE_HEIGHT = 0.06;

export function makeOrder(objects: LayoutObject[]): LayoutObject[] {
  const volume = (o: LayoutObject) => o.size[0] * o.size[1] * o.size[2];
  return objects
    .map((object, index) => ({ object, index }))
    .sort((a, b) => MAKE_ORDER[a.object.category] - MAKE_ORDER[b.object.category] || volume(b.object) - volume(a.object) || a.index - b.index)
    .map((entry) => entry.object);
}

export interface RoomGenerationOptions {
  roomsDirectory: string;
  writeLayout: (description: string, signal: AbortSignal) => Promise<RoomLayout>;
  /** Where an object gets its look from, in order: the library, models made earlier. */
  sources: ObjectSource[];
  /** Makes missing objects in the background; without it (or with it off) they become simple shapes. */
  generator?: ObjectGenerator;
  /** Read at the start of each room; `available` says the image and 3D steps are set up. */
  objectSettings?: () => ObjectSettings & { available: boolean };
  /** A saved room's room.json changed; the renderer reloads it if it is showing. */
  onRoomUpdated?: (roomId: string) => void;
  logger?: Pick<Console, 'warn'>;
  uuid?: () => string;
  seed?: () => number;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class RoomGenerationService {
  private controller: AbortController | null = null;
  /** The saved room whose objects are being made, while that goes on. */
  private makingRoom: string | null = null;

  constructor(private readonly options: RoomGenerationOptions) {}

  get busy(): boolean {
    return this.controller !== null;
  }

  /** The room id objects are still being made for, or null. */
  get making(): string | null {
    return this.makingRoom ? `room:${this.makingRoom}` : null;
  }

  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  async generate(description: string, onProgress: (event: RoomGenerationProgress) => void = () => undefined): Promise<RoomGenerationResult> {
    const text = typeof description === 'string' ? description.trim() : '';
    if (!text) throw new Error('Describe the room first.');
    if (text.length > 1000) throw new Error('The description is too long (1000 characters at most).');
    if (this.controller) throw new Error('A room is already being built.');
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const cancelled = () => new Error('Room building was cancelled.');
    // True once the background phase owns the controller and clears it when it ends.
    let handedOver = false;
    try {
      onProgress({ phase: 'planning', message: 'Planning the room' });
      const layout = await this.options.writeLayout(text, signal);
      if (signal.aborted) throw cancelled();

      const total = layout.objects.length;
      let done = 0;
      onProgress({ phase: 'finding', message: `Finding furniture (0/${total})`, current: 0, total });
      const resolved: Record<string, ResolvedModel | undefined> = {};
      const fellBack: string[] = [];
      await Promise.all(
        layout.objects.map(async (object) => {
          const found = await resolveObject(this.options.sources, object, signal).catch((error: unknown) => {
            if (signal.aborted) throw error;
            return null;
          });
          if (found) resolved[object.id] = found;
          else fellBack.push(object.id);
          done += 1;
          onProgress({ phase: 'finding', message: `Finding furniture (${done}/${total})`, current: done, total });
        }),
      );
      if (signal.aborted) throw cancelled();

      onProgress({ phase: 'arranging', message: 'Arranging' });
      const uuid = (this.options.uuid ?? randomUUID)();
      if (!UUID.test(uuid)) throw new Error('Could not make a room id.');
      const seed = (this.options.seed ?? (() => Math.floor(Math.random() * 2 ** 31)))();
      const placed = placeRoom({ layout, resolved, seed, roomId: `room:${uuid}` });
      const room = validateRoomFile({ ...placed.room, description: text.slice(0, 1000) });

      // Objects nothing found: made in the background when that is set up, else simple shapes now.
      const settings = this.options.objectSettings?.();
      const canMake = Boolean(this.options.generator && settings?.enabled && settings.available && settings.maxPerRoom > 0);
      const placedIds = new Set(room.objects.map((o) => o.id));
      const missing = layout.objects.filter((o) => fellBack.includes(o.id) && !placed.dropped.includes(o.id));
      const toMake = canMake
        ? makeOrder(missing.filter((o) => placedIds.has(o.id) && (room.objects.find((r) => r.id === o.id)?.size[1] ?? 0) >= MIN_MADE_HEIGHT))
        : [];
      const toMakeIds = new Set(toMake.map((o) => o.id));
      const warnings = [
        ...missing.filter((o) => !toMakeIds.has(o.id)).map((o) => `Couldn't find a ${o.name}, used a simple shape.`),
        ...placed.warnings,
      ];
      const folder = path.join(this.options.roomsDirectory, uuid);
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, 'layout.json'), JSON.stringify(layout, null, 2));
        await writeFile(
          path.join(folder, 'generation.json'),
          JSON.stringify(
            { description: text, createdAt: (this.options.now?.() ?? new Date()).toISOString(), seed, warnings, fellBack, dropped: placed.dropped, models: Object.fromEntries(Object.entries(resolved).map(([id, r]) => [id, r?.model.asset])), making: toMake.map((o) => o.id) },
            null,
            2,
          ),
        );
        await writeFile(path.join(folder, 'room.json'), JSON.stringify(room, null, 2));
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
      const summary = { id: `room:${uuid}`, name: room.name, builtIn: false, description: room.description };
      if (toMake.length > 0 && settings && this.options.generator) {
        handedOver = true;
        this.makingRoom = uuid;
        const cap = settings.maxPerRoom;
        void this.makeObjects({ uuid, folder, toMake, cap, generator: this.options.generator, signal, controller, onProgress });
        return { room: summary, warnings, making: toMake.length };
      }
      onProgress({ phase: 'done', message: warnings.length ? 'Done, with notes' : 'Done', warnings });
      return { room: summary, warnings };
    } catch (error) {
      if (signal.aborted) throw cancelled();
      throw error;
    } finally {
      if (!handedOver) this.controller = null;
    }
  }

  /**
   * The background phase: one object at a time, most important first. Models made earlier are used
   * for free; new ones stop at `cap`. Nothing here throws; whatever fails stays a simple shape.
   */
  private async makeObjects(job: {
    uuid: string;
    folder: string;
    toMake: LayoutObject[];
    cap: number;
    generator: ObjectGenerator;
    signal: AbortSignal;
    controller: AbortController;
    onProgress: (event: RoomGenerationProgress) => void;
  }): Promise<void> {
    const { signal, generator, cap, uuid, folder } = job;
    const roomId = `room:${uuid}`;
    const notes: string[] = [];
    const made: string[] = [];
    const failed: string[] = [];
    const total = Math.min(cap, job.toMake.length);
    let started = 0;
    try {
      for (const object of job.toMake) {
        if (signal.aborted) break;
        let model = await generator.resolve(object, signal).catch(() => null);
        let newlyMade = false;
        if (!model) {
          if (started >= cap) {
            notes.push(`Couldn't make a ${object.name} (the limit is ${cap} new object${cap === 1 ? '' : 's'} per room), used a simple shape.`);
            failed.push(object.id);
            continue;
          }
          started += 1;
          job.onProgress({ phase: 'making', roomId, message: `Making the ${object.name} (${started}/${total})…`, current: started, total });
          try {
            const result = await generator.generate(object, signal);
            model = result.resolved;
            newlyMade = !result.reused;
          } catch (error) {
            if (signal.aborted) break;
            this.options.logger?.warn('Could not make a room object.', { object: object.id, message: error instanceof Error ? error.message : String(error) });
            notes.push(`Couldn't make a ${object.name}, used a simple shape.`);
            failed.push(object.id);
            continue;
          }
        }
        const outcome = await this.applyModel(folder, object.id, model);
        if (outcome === 'gone') break;
        if (outcome !== 'ok') {
          notes.push(`Made a new ${object.name} but ${outcome}, so kept a simple shape.`);
          failed.push(object.id);
          continue;
        }
        made.push(object.id);
        if (newlyMade) notes.push(`Made a new model for the ${object.name}.`);
        this.options.onRoomUpdated?.(roomId);
      }
      if (signal.aborted) {
        const left = job.toMake.filter((o) => !made.includes(o.id) && !failed.includes(o.id));
        for (const o of left) notes.push(`Stopped before making the ${o.name}, used a simple shape.`);
      }
      await this.recordMaking(folder, { made, failed, notes }).catch(() => undefined);
    } catch (error) {
      this.options.logger?.warn('Making room objects stopped.', { message: error instanceof Error ? error.message : String(error) });
      notes.push('Stopped making new objects.');
    } finally {
      this.makingRoom = null;
      if (this.controller === job.controller) this.controller = null;
      job.onProgress({
        phase: 'done',
        roomId,
        message: signal.aborted ? 'Stopped making objects' : notes.length ? 'Done, with notes' : 'Done',
        warnings: notes,
      });
    }
  }

  /** Swaps one object's shapes for its model in room.json. Returns 'ok', 'gone' (the room was deleted) or the reason it was not done. */
  private async applyModel(folder: string, objectId: string, resolved: ResolvedModel): Promise<string> {
    const file = path.join(folder, 'room.json');
    let current;
    try {
      current = validateRoomFile(JSON.parse(await readFile(file, 'utf8')) as unknown);
    } catch {
      return 'gone';
    }
    const result = refitObject(current, objectId, resolved);
    if (!result.ok) return result.reason;
    const validated = validateRoomFile(result.room);
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(validated, null, 2));
    await rename(temporary, file);
    return 'ok';
  }

  private async recordMaking(folder: string, outcome: { made: string[]; failed: string[]; notes: string[] }): Promise<void> {
    const file = path.join(folder, 'generation.json');
    const generation = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...generation, madeObjects: outcome.made, couldNotMake: outcome.failed, makingNotes: outcome.notes }, null, 2));
  }

  /** Removes a saved room's folder. Built-in rooms and anything that is not a saved room id are refused. */
  async delete(id: string): Promise<void> {
    const uuid = typeof id === 'string' && id.startsWith('room:') ? id.slice(5) : '';
    if (!UUID.test(uuid)) throw new Error('Only rooms you built can be deleted.');
    // Objects still being made for it have nothing to go into any more.
    if (this.makingRoom === uuid) this.controller?.abort();
    await rm(path.join(this.options.roomsDirectory, uuid), { recursive: true, force: true });
  }

  listGenerated(): Promise<GeneratedObjectSummary[]> {
    return this.options.generator?.list() ?? Promise.resolve([]);
  }

  async deleteGenerated(id: string): Promise<void> {
    if (!this.options.generator) throw new Error('Generated objects are unavailable.');
    await this.options.generator.remove(id);
  }
}
