/**
 * The local library of objects the app made itself: `<assets>/generated/<slug>-<hash>/` with
 * `model.glb`, `meta.json` and the picture the model was made from. Later rooms reuse an entry
 * when the same sort of object is wanted, found with the same scorer as the Poly Haven catalog.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectCategory } from '../room-layout.js';
import type { Vec3 } from '../types.js';
import { tokens, findBestModel } from './search.js';
import type { CatalogEntry } from './types.js';

export const GENERATED_FOLDER = 'generated';
export const GENERATED_MODEL_FILE = 'model.glb';
export const GENERATED_IMAGE_FILE = 'source.png';
const DIRECTORY = /^[a-z0-9][a-z0-9-]{0,80}$/;

export interface GeneratedMeta {
  name: string;
  /** The layout's search words. */
  search: string;
  category: ObjectCategory;
  /** The image prompt. */
  prompt: string;
  /** ISO time. */
  created: string;
  /** File name of the picture the model was made from, beside the model. */
  sourceImage: string;
  /** Size of the model as made, before the room scales it. */
  bbox: { min: Vec3; max: Vec3; size: Vec3 };
  seed?: number;
  geometryModel?: string;
  imageModel?: string;
}

export interface GeneratedEntry {
  /** Folder name under `generated/`. */
  dir: string;
  /** Asset ref the rooms store: `generated/<dir>`. */
  asset: string;
  meta: GeneratedMeta;
}

export function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'object';
}

export function directoryFor(name: string, unique: string): string {
  return `${slugFor(name)}-${createHash('sha1').update(unique).digest('hex').slice(0, 8)}`;
}

export const isGeneratedDirectory = (dir: unknown): dir is string => typeof dir === 'string' && DIRECTORY.test(dir);

function isMeta(value: unknown): value is GeneratedMeta {
  if (typeof value !== 'object' || value === null) return false;
  const meta = value as Record<string, unknown>;
  const bbox = meta.bbox as Record<string, unknown> | undefined;
  const size = bbox?.size;
  return (
    typeof meta.name === 'string' &&
    typeof meta.search === 'string' &&
    typeof meta.category === 'string' &&
    typeof meta.created === 'string' &&
    typeof meta.sourceImage === 'string' &&
    Array.isArray(size) &&
    size.length === 3 &&
    size.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

export class GeneratedLibrary {
  private readonly directory: string;

  /** `assetsRoot` is the room asset cache (`<userData>/rooms/assets`). */
  constructor(assetsRoot: string) {
    this.directory = path.join(assetsRoot, GENERATED_FOLDER);
  }

  folder(dir: string): string {
    return path.join(this.directory, dir);
  }

  /** Every entry that has both a readable meta.json and a model file, newest first. */
  async list(): Promise<GeneratedEntry[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const entries: GeneratedEntry[] = [];
    for (const dir of names) {
      if (!isGeneratedDirectory(dir)) continue;
      try {
        const meta: unknown = JSON.parse(await readFile(path.join(this.folder(dir), 'meta.json'), 'utf8'));
        if (!isMeta(meta)) continue;
        await access(path.join(this.folder(dir), GENERATED_MODEL_FILE));
        entries.push({ dir, asset: `${GENERATED_FOLDER}/${dir}`, meta });
      } catch {
        /* A half-written or damaged entry is not offered. */
      }
    }
    return entries.sort((a, b) => b.meta.created.localeCompare(a.meta.created) || a.dir.localeCompare(b.dir));
  }

  /** The best earlier object for this one, by the Poly Haven search scorer; null below its threshold. */
  async find(query: { search: string; name: string; category: ObjectCategory }): Promise<GeneratedEntry | null> {
    const entries = await this.list();
    const catalog: CatalogEntry[] = entries.map((entry) => ({
      id: entry.dir.replace(/-[0-9a-f]{8}$/, ''),
      name: entry.meta.name,
      categories: [entry.meta.category],
      tags: tokens(entry.meta.search),
    }));
    const match = findBestModel(catalog, query);
    return match ? entries[catalog.indexOf(match.entry)] : null;
  }

  /** Writes a new entry atomically (a temporary folder, then renamed) and returns it. */
  async add(
    dir: string,
    meta: GeneratedMeta,
    files: { model: Buffer; image: Buffer },
  ): Promise<GeneratedEntry> {
    if (!isGeneratedDirectory(dir)) throw new Error('Bad generated object folder.');
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `.making-${dir}`);
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true });
    try {
      await writeFile(path.join(temporary, GENERATED_MODEL_FILE), files.model);
      await writeFile(path.join(temporary, meta.sourceImage), files.image);
      await writeFile(path.join(temporary, 'meta.json'), JSON.stringify(meta, null, 2));
      await rm(this.folder(dir), { recursive: true, force: true });
      await rename(temporary, this.folder(dir));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    return { dir, asset: `${GENERATED_FOLDER}/${dir}`, meta };
  }

  async remove(dir: string): Promise<void> {
    if (!isGeneratedDirectory(dir)) throw new Error('That is not a generated object.');
    await rm(this.folder(dir), { recursive: true, force: true });
  }
}
