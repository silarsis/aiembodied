/**
 * Describe a room in words, get a 3D room: the layout model writes the layout, each object is
 * looked up through the object sources (model library first), the placer solves positions, and the
 * result is saved as `<roomsDirectory>/<uuid>/room.json` next to `layout.json` and `generation.json`.
 * One generation at a time; it can be cancelled.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveObject, type ObjectSource } from './asset-library/library-source.js';
import type { RoomLayout } from './room-layout.js';
import { placeRoom, type ResolvedModel } from './room-placer.js';
import type { RoomSummary } from './types.js';
import { validateRoomFile } from './validate.js';

export interface RoomGenerationProgress {
  phase: 'planning' | 'finding' | 'arranging' | 'done';
  message: string;
  current?: number;
  total?: number;
  warnings?: string[];
}

export interface RoomGenerationResult {
  room: RoomSummary;
  warnings: string[];
}

export interface RoomGenerationOptions {
  roomsDirectory: string;
  writeLayout: (description: string, signal: AbortSignal) => Promise<RoomLayout>;
  sources: ObjectSource[];
  uuid?: () => string;
  seed?: () => number;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class RoomGenerationService {
  private controller: AbortController | null = null;

  constructor(private readonly options: RoomGenerationOptions) {}

  get busy(): boolean {
    return this.controller !== null;
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
      const warnings = [
        ...fellBack.filter((id) => !placed.dropped.includes(id)).map((id) => `Couldn't find a ${layout.objects.find((o) => o.id === id)?.name ?? id}, used a simple shape.`),
        ...placed.warnings,
      ];
      const folder = path.join(this.options.roomsDirectory, uuid);
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, 'layout.json'), JSON.stringify(layout, null, 2));
        await writeFile(
          path.join(folder, 'generation.json'),
          JSON.stringify(
            { description: text, createdAt: (this.options.now?.() ?? new Date()).toISOString(), seed, warnings, fellBack, dropped: placed.dropped, models: Object.fromEntries(Object.entries(resolved).map(([id, r]) => [id, r?.model.asset])) },
            null,
            2,
          ),
        );
        await writeFile(path.join(folder, 'room.json'), JSON.stringify(room, null, 2));
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
      onProgress({ phase: 'done', message: warnings.length ? 'Done, with notes' : 'Done', warnings });
      return { room: { id: `room:${uuid}`, name: room.name, builtIn: false, description: room.description }, warnings };
    } catch (error) {
      if (signal.aborted) throw cancelled();
      throw error;
    } finally {
      this.controller = null;
    }
  }

  /** Removes a saved room's folder. Built-in rooms and anything that is not a saved room id are refused. */
  async delete(id: string): Promise<void> {
    const uuid = typeof id === 'string' && id.startsWith('room:') ? id.slice(5) : '';
    if (!UUID.test(uuid)) throw new Error('Only rooms you built can be deleted.');
    await rm(path.join(this.options.roomsDirectory, uuid), { recursive: true, force: true });
  }
}
