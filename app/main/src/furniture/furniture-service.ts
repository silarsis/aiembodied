/**
 * Furniture the user describes: one job draws the piece (the image step), builds a 3D model from the
 * drawing (the mesh step), and scales that to the real size of such a piece. Jobs run one at a time, in the
 * background; the renderer hears of each step through `onChanged`.
 *
 * Files, in <directory>/<id>/: image.png, thumb.png, model-raw.glb (as the 3D step made it) and model.glb
 * (scaled to metres). A new run works in next/ and replaces those only when it has succeeded, so a failed
 * edit leaves the old piece as it was.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { inJob } from '../avatar/generation/comfyui-client.js';
import { graphsModelFiles } from '../avatar/generation/comfyui-needs.js';
import { characterMeshGraph } from '../avatar/generation/character/graphs.js';
import { usesViews, type GeometryModel } from '../avatar/generation/character-model-service.js';
import type { ImageWorkflowModel } from '../avatar/generation/image-workflows.js';
import type { MemoryStore } from '../memory/memory-store.js';
import { objectImageGraph, type ObjectComfy } from '../rooms/asset-library/generated-source.js';
import { estimateFurniture, fallbackEstimate, type AskHelper } from './furniture-size.js';
import { fitGlb } from './furniture-model.js';
import type { FurnitureItem, FurnitureRecord } from './types.js';

export const FURNITURE_KEY = 'furniture.items.v2';
const MAX_PROMPT = 1000;
const THUMBNAIL_SIZE = 256;
const STAGES = ['image.png', 'thumb.png', 'model-raw.glb', 'model.glb'] as const;

export interface FurnitureServiceOptions {
  store: Pick<MemoryStore, 'getValue' | 'setValue'>;
  /** <userData>/furniture */
  directory: string;
  /** The ComfyUI server of a Models and servers step, started if it is this PC's. */
  pickComfy: (stage: 'image' | 'mesh') => Promise<ObjectComfy>;
  imageModel: () => Promise<ImageWorkflowModel>;
  /** The 3D model for a single picture; throws, saying what to install, when there is none. */
  geometryModel: () => Promise<GeometryModel>;
  /** Paints a picture onto an untextured shape (Hunyuan3D makes shapes only). Without it such a model stays plain. */
  paint?: (input: { meshPath: string; outputPath: string; front: string; signal: AbortSignal }) => Promise<void>;
  /** The helper model that sizes and names the piece; without it the keyword table does. */
  askHelper?: AskHelper;
  onChanged?: (item: FurnitureItem) => void;
  seed?: () => number;
  now?: () => Date;
  logger?: Pick<Console, 'warn'>;
}

interface Job {
  controller: AbortController;
  /** Settles when the job has stopped touching files, however it ended. */
  done: Promise<void>;
}

const cancelled = (): Error => new Error('Cancelled.');

function readableRecords(raw: string | null): FurnitureRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is FurnitureRecord => {
      const r = entry as Partial<FurnitureRecord> | null;
      return (
        !!r &&
        typeof r.id === 'string' &&
        /^[0-9a-f-]{36}$/.test(r.id) &&
        typeof r.name === 'string' &&
        typeof r.prompt === 'string' &&
        Array.isArray(r.dimensions) &&
        r.dimensions.length === 3 &&
        (r.status === 'generating' || r.status === 'ready' || r.status === 'failed')
      );
    });
  } catch {
    return [];
  }
}

/** The picture the 3D step works best from: one piece on plain white. No negations: the sampler ignores the negative prompt. */
export function buildFurniturePrompt(description: string): string {
  return (
    `Product photo of a single piece of furniture: ${description.trim().replace(/\.?$/, '.')} ` +
    'Three-quarter front view, the whole object in frame with margin around it, centred, ' +
    'plain pure white background, soft even studio light, one object only.'
  );
}

/** Scaled down by nearest neighbour, keeping the aspect: the thumbnail only has to be recognisable. */
function thumbnailOf(image: Buffer): Buffer {
  const source = PNG.sync.read(image);
  const ratio = Math.min(1, THUMBNAIL_SIZE / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * ratio));
  const height = Math.max(1, Math.round(source.height * ratio));
  const thumb = new PNG({ width, height });
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const from = (Math.floor((y * source.height) / height) * source.width + Math.floor((x * source.width) / width)) * 4;
      source.data.copy(thumb.data, (y * width + x) * 4, from, from + 4);
    }
  return PNG.sync.write(thumb);
}

export class FurnitureService {
  private readonly jobs = new Map<string, Job>();
  private readonly messages = new Map<string, string>();
  /** Jobs run one at a time: each starts when the one before has ended. */
  private lane: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: FurnitureServiceOptions) {}

  /** A run the app was closed in the middle of did not finish: the old model, if there is one, stays. */
  async initialize(): Promise<void> {
    const records = this.records();
    if (!records.some((record) => record.status === 'generating')) return;
    const fixed = await Promise.all(
      records.map(async (record): Promise<FurnitureRecord> => {
        if (record.status !== 'generating') return record;
        const kept = await this.exists(record.id, 'model.glb');
        return { ...record, status: kept ? 'ready' : 'failed', error: 'Interrupted.' };
      }),
    );
    this.save(fixed);
  }

  async list(): Promise<FurnitureItem[]> {
    return Promise.all(this.records().map((record) => this.toItem(record)));
  }

  async load(id: string): Promise<FurnitureItem> {
    return this.toItem(this.record(id));
  }

  /** The scaled GLB. */
  async model(id: string): Promise<Buffer> {
    this.record(id);
    try {
      return await readFile(path.join(this.directoryOf(id), 'model.glb'));
    } catch {
      throw new Error('This piece has no 3D model yet.');
    }
  }

  /** Starts making a piece and returns it at once, 'generating'. */
  async generate(prompt: string): Promise<FurnitureItem> {
    const text = this.checkPrompt(prompt);
    const estimate = fallbackEstimate(text);
    const now = this.now();
    const record: FurnitureRecord = {
      id: randomUUID(),
      name: estimate.name,
      prompt: text,
      category: estimate.category,
      dimensions: [estimate.width, estimate.height, estimate.depth],
      status: 'generating',
      createdAt: now,
      updatedAt: now,
    };
    this.save([...this.records(), record]);
    return this.start(record, text);
  }

  /** Makes the piece again from a new prompt. The old files stay until the new run has succeeded. */
  async edit(id: string, prompt: string): Promise<FurnitureItem> {
    const text = this.checkPrompt(prompt);
    const record = this.record(id);
    if (this.jobs.has(id)) throw new Error('This piece is already being made.');
    return this.start(await this.update(record.id, { status: 'generating', error: undefined }), text);
  }

  /** Stops its job, then removes its files and record. */
  async delete(id: string): Promise<void> {
    this.record(id);
    this.save(this.records().filter((record) => record.id !== id));
    const job = this.jobs.get(id);
    job?.controller.abort();
    await job?.done;
    this.messages.delete(id);
    await rm(this.directoryOf(id), { recursive: true, force: true });
  }

  private checkPrompt(prompt: unknown): string {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > MAX_PROMPT)
      throw new Error(`Describe a piece of furniture in 1–${MAX_PROMPT} characters.`);
    return prompt.trim();
  }

  private start(record: FurnitureRecord, prompt: string): Promise<FurnitureItem> {
    const controller = new AbortController();
    const previous = this.lane;
    // A piece deleted while it waits leaves the queue at once, but the next one still waits for the one running.
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(cancelled()), { once: true }));
    const run = Promise.race([previous, aborted]).then(() => this.run(record.id, prompt, controller.signal));
    const settled = run.catch(() => undefined);
    this.lane = Promise.all([previous, settled]);
    const job: Job = { controller, done: settled };
    this.jobs.set(record.id, job);
    this.progress(record.id, 'Waiting for the earlier piece to finish');
    void run
      .catch((error: unknown) => this.fail(record.id, error, controller.signal))
      .finally(() => {
        this.jobs.delete(record.id);
        this.messages.delete(record.id);
      });
    return this.toItem(record);
  }

  private async run(id: string, prompt: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw cancelled();
    const directory = this.directoryOf(id);
    const next = path.join(directory, 'next');
    await rm(next, { recursive: true, force: true });
    await mkdir(next, { recursive: true });
    const stop = (): void => {
      if (signal.aborted) throw cancelled();
    };
    try {
      this.progress(id, 'Working out the size');
      const estimate = await estimateFurniture(prompt, this.options.askHelper, signal);
      stop();

      this.progress(id, 'Drawing the piece');
      const seed = (this.options.seed ?? (() => randomInt(0, 2 ** 47)))();
      const imageModel = await this.options.imageModel();
      const image = await (await this.options.pickComfy('image')).run(objectImageGraph(imageModel, buildFurniturePrompt(prompt), seed), { signal });
      stop();
      if (image.length === 0) throw new Error('The image step returned nothing.');
      await writeFile(path.join(next, 'image.png'), image);
      await writeFile(path.join(next, 'thumb.png'), thumbnailOf(image));

      this.progress(id, 'Building the 3D model');
      const geometry = await this.options.geometryModel();
      const mesh = await this.options.pickComfy('mesh');
      const shape = await inJob(mesh, graphsModelFiles(characterMeshGraph({ front: 'front.png' }, seed, geometry)), async () => {
        const uploaded = await mesh.uploadImage(`furniture-${id}.png`, image);
        return mesh.run(characterMeshGraph({ front: uploaded }, seed, geometry), { signal, output: 'mesh' });
      });
      stop();
      const rawPath = path.join(next, 'model-raw.glb');
      if (usesViews(geometry) && this.options.paint) {
        // Hunyuan3D makes a bare shape: paint the picture onto it.
        this.progress(id, 'Painting the picture onto the model');
        const shapePath = path.join(next, 'model-shape.glb');
        await writeFile(shapePath, shape);
        await this.options.paint({ meshPath: shapePath, outputPath: rawPath, front: path.join(next, 'image.png'), signal });
        stop();
      } else {
        await writeFile(rawPath, shape);
      }

      this.progress(id, 'Scaling to real size');
      const fitted = fitGlb(await readFile(rawPath), estimate.height);
      await writeFile(path.join(next, 'model.glb'), fitted.glb);
      stop();

      // Everything made: from here the old files are replaced. A piece deleted meanwhile is not brought back.
      if (!this.records().some((record) => record.id === id)) throw cancelled();
      await Promise.all(STAGES.map((file) => rename(path.join(next, file), path.join(directory, file))));
      await this.update(id, {
        name: estimate.name,
        prompt,
        category: estimate.category,
        dimensions: fitted.dimensions,
        fit: { scale: fitted.scale, offset: fitted.offset },
        status: 'ready',
        error: undefined,
      });
    } finally {
      await rm(next, { recursive: true, force: true });
    }
  }

  /** A failed first run is 'failed'; a failed edit leaves the old model in place and says why. */
  private async fail(id: string, error: unknown, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.records().some((record) => record.id === id)) return;
    const message = error instanceof Error ? error.message : String(error);
    this.options.logger?.warn('Furniture generation failed.', { id, message });
    const kept = await this.exists(id, 'model.glb');
    await this.update(id, { status: kept ? 'ready' : 'failed', error: message });
  }

  private progress(id: string, message: string): void {
    this.messages.set(id, message);
    const record = this.records().find((entry) => entry.id === id);
    if (record) void this.toItem(record).then((item) => this.options.onChanged?.(item));
  }

  private async update(id: string, patch: Partial<FurnitureRecord>): Promise<FurnitureRecord> {
    const records = this.records();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) throw new Error('This piece is not available.');
    const record = { ...records[index], ...patch, updatedAt: this.now() };
    records[index] = record;
    this.save(records);
    this.messages.delete(id);
    this.options.onChanged?.(await this.toItem(record));
    return record;
  }

  private async toItem(record: FurnitureRecord): Promise<FurnitureItem> {
    const thumbnail = await readFile(path.join(this.directoryOf(record.id), 'thumb.png')).catch(() => null);
    const message = this.messages.get(record.id);
    return {
      ...record,
      ...(message ? { message } : {}),
      hasModel: await this.exists(record.id, 'model.glb'),
      thumbnailDataUrl: thumbnail ? `data:image/png;base64,${thumbnail.toString('base64')}` : null,
    };
  }

  private records(): FurnitureRecord[] {
    return readableRecords(this.options.store.getValue(FURNITURE_KEY));
  }

  private save(records: FurnitureRecord[]): void {
    this.options.store.setValue(FURNITURE_KEY, JSON.stringify(records));
  }

  private record(id: string): FurnitureRecord {
    const record = this.records().find((entry) => entry.id === id);
    if (!record) throw new Error('This piece is not available.');
    return record;
  }

  /** The id is one of ours (a record was found for it), so it cannot climb out of the directory. */
  private directoryOf(id: string): string {
    return path.join(this.options.directory, id);
  }

  private async exists(id: string, file: string): Promise<boolean> {
    return access(path.join(this.directoryOf(id), file)).then(() => true, () => false);
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
