/**
 * Poly Haven (CC0) model library client. The catalog is cached for a week; a model is downloaded
 * on first use into `<root>/polyhaven/<id>/` keeping the relative layout the glTF expects, written
 * as `.part` files and renamed when complete (and when the md5 matches). No more than three
 * downloads run at once. Every network call goes through the injected `fetchFn`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CatalogEntry, LocalModel } from './types.js';

export const POLYHAVEN_API = 'https://api.polyhaven.com';
export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CONCURRENT_DOWNLOADS = 3;
const RESOLUTIONS = ['1k', '2k'];
const MAX_FILE_BYTES = 80 * 1024 * 1024;

export interface PolyHavenOptions {
  /** `<userData>/rooms/assets`. */
  root: string;
  fetchFn?: typeof fetch;
  appVersion?: string;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
}

interface RemoteFile {
  url: string;
  md5?: string;
  size?: number;
}
interface AssetRecord {
  file: string;
  files: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** A relative path from the library that stays inside the model's folder. */
export function safeRelative(file: string): string | null {
  if (!file || file.includes('\0') || file.includes('\\') || path.posix.isAbsolute(file) || /^[a-zA-Z]:/.test(file)) return null;
  const normal = path.posix.normalize(file);
  if (normal === '.' || normal.startsWith('../') || normal === '..') return null;
  return normal;
}
function httpsUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export class PolyHavenClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly directory: string;
  private readonly headers: Record<string, string>;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly inFlight = new Map<string, Promise<LocalModel>>();
  private catalogPromise: Promise<CatalogEntry[]> | null = null;

  constructor(private readonly options: PolyHavenOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.directory = path.join(options.root, 'polyhaven');
    this.headers = { 'User-Agent': `aiembodied/${options.appVersion ?? '0'} room builder` };
  }

  /** Most downloads in flight at once so far; for tests. */
  peakConcurrency = 0;

  async catalog(signal?: AbortSignal): Promise<CatalogEntry[]> {
    this.catalogPromise ??= this.loadCatalog(signal).catch((error: unknown) => {
      this.catalogPromise = null;
      throw error;
    });
    return this.catalogPromise;
  }

  private async loadCatalog(signal?: AbortSignal): Promise<CatalogEntry[]> {
    const cacheFile = path.join(this.directory, 'catalog.json');
    let cached: { fetchedAt: number; assets: Record<string, unknown> } | null = null;
    try {
      const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as unknown;
      if (isRecord(parsed) && typeof parsed.fetchedAt === 'number' && isRecord(parsed.assets))
        cached = { fetchedAt: parsed.fetchedAt, assets: parsed.assets };
    } catch {
      cached = null;
    }
    if (cached && this.now() - cached.fetchedAt < CATALOG_MAX_AGE_MS) return toEntries(cached.assets);
    try {
      const response = await this.fetchFn(`${POLYHAVEN_API}/assets?t=models`, { headers: this.headers, signal });
      if (!response.ok) throw new Error(`Poly Haven catalog request failed: HTTP ${response.status}`);
      const assets = (await response.json()) as unknown;
      if (!isRecord(assets)) throw new Error('Poly Haven catalog had an unexpected shape.');
      await mkdir(this.directory, { recursive: true });
      await writeFile(`${cacheFile}.part`, JSON.stringify({ fetchedAt: this.now(), assets }));
      await rename(`${cacheFile}.part`, cacheFile);
      return toEntries(assets);
    } catch (error) {
      if (cached) {
        this.options.logger?.warn('Using the old Poly Haven catalog.', { message: error instanceof Error ? error.message : String(error) });
        return toEntries(cached.assets);
      }
      throw error;
    }
  }

  /** Downloads the model unless it is already complete on disk. Rejects on any failure. */
  ensureModel(id: string, signal?: AbortSignal): Promise<LocalModel> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) return Promise.reject(new Error(`Unsafe model id "${id}".`));
    let pending = this.inFlight.get(id);
    if (!pending) {
      pending = this.download(id, signal).finally(() => this.inFlight.delete(id));
      this.inFlight.set(id, pending);
    }
    return pending;
  }

  private local(id: string, file: string): LocalModel {
    return { asset: `polyhaven/${id}`, file, path: path.join(this.directory, id, ...file.split('/')) };
  }

  private async download(id: string, signal?: AbortSignal): Promise<LocalModel> {
    const folder = path.join(this.directory, id);
    const recordPath = path.join(folder, 'asset.json');
    try {
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as AssetRecord;
      const main = this.local(id, record.file);
      if ((await stat(main.path)).isFile()) return main;
    } catch {
      // Not downloaded yet.
    }
    const response = await this.fetchFn(`${POLYHAVEN_API}/files/${encodeURIComponent(id)}`, { headers: this.headers, signal });
    if (!response.ok) throw new Error(`Poly Haven file list for ${id} failed: HTTP ${response.status}`);
    const listing = (await response.json()) as unknown;
    const gltf = isRecord(listing) && isRecord(listing.gltf) ? listing.gltf : null;
    const variant = gltf ? RESOLUTIONS.map((r) => gltf[r]).find(isRecord) : undefined;
    const main = variant && isRecord(variant.gltf) ? variant.gltf : null;
    const mainUrl = main ? httpsUrl(main.url) : null;
    if (!main || !mainUrl) throw new Error(`Poly Haven has no glTF for ${id}.`);
    const mainName = safeRelative(decodeURIComponent(new URL(mainUrl).pathname.split('/').pop() ?? ''));
    if (!mainName) throw new Error(`Poly Haven gave an unusable file name for ${id}.`);
    const files: Array<{ relative: string; remote: RemoteFile }> = [{ relative: mainName, remote: { url: mainUrl, md5: typeof main.md5 === 'string' ? main.md5 : undefined } }];
    if (isRecord(main.include)) {
      for (const [relativeRaw, value] of Object.entries(main.include)) {
        const relative = safeRelative(relativeRaw);
        const url = isRecord(value) ? httpsUrl(value.url) : null;
        if (!relative || !url || !isRecord(value)) throw new Error(`Poly Haven listed an unusable file for ${id}.`);
        files.push({ relative, remote: { url, md5: typeof value.md5 === 'string' ? value.md5 : undefined } });
      }
    }
    await mkdir(folder, { recursive: true });
    await Promise.all(files.map(({ relative, remote }) => this.slot(() => this.fetchTo(folder, relative, remote, signal))));
    await writeFile(recordPath, JSON.stringify({ file: mainName, files: files.map((f) => f.relative) } satisfies AssetRecord));
    return this.local(id, mainName);
  }

  private async fetchTo(folder: string, relative: string, remote: RemoteFile, signal?: AbortSignal): Promise<void> {
    const target = path.join(folder, ...relative.split('/'));
    const part = `${target}.part`;
    const response = await this.fetchFn(remote.url, { headers: this.headers, signal });
    if (!response.ok) throw new Error(`Download of ${relative} failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_FILE_BYTES) throw new Error(`${relative} is too large.`);
    if (remote.md5 && createHash('md5').update(data).digest('hex') !== remote.md5.toLowerCase())
      throw new Error(`Download of ${relative} is corrupt (md5 mismatch).`);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(part, data);
      await rename(part, target);
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    }
  }

  /** Runs `job` once fewer than MAX_CONCURRENT_DOWNLOADS others are running. */
  private async slot<T>(job: () => Promise<T>): Promise<T> {
    while (this.active >= MAX_CONCURRENT_DOWNLOADS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.active);
    try {
      return await job();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function toEntries(assets: Record<string, unknown>): CatalogEntry[] {
  const result: CatalogEntry[] = [];
  for (const [id, raw] of Object.entries(assets)) {
    if (!isRecord(raw)) continue;
    result.push({ id, name: typeof raw.name === 'string' ? raw.name : id, categories: strings(raw.categories), tags: strings(raw.tags) });
  }
  return result.sort((a, b) => (a.id < b.id ? -1 : 1));
}
