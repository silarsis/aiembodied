/**
 * A size-capped cache on the satellite's disk for what it fetches from bija: room files (`asset.get`) and avatar
 * bodies (`avatar-model:load`). Files live in `<userData>/cache/assets/`, named by the SHA-256 of their key. When the
 * folder grows past the cap, the oldest-used files go first (reading a file counts as using it).
 *
 * Pure Node (fs, crypto); the clock is injected for the tests.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CACHE_BYTES = 500 * 1024 * 1024;

export interface CachedAsset {
  mime: string;
  data: Uint8Array;
}

interface Entry {
  size: number;
  usedAt: number;
}

export class AssetCache {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private index: Map<string, Entry> | null = null;
  private total = 0;
  /** Writes and prunes one at a time, so the folder size the index tracks stays right. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: { dir: string; maxBytes?: number; now?: () => number }) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? DEFAULT_CACHE_BYTES;
    this.now = options.now ?? Date.now;
  }

  private name(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  private dataPath(name: string): string {
    return path.join(this.dir, `${name}.bin`);
  }

  private metaPath(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  /** Reads the folder once: every `.bin` with its size and last-used time. */
  private async load(): Promise<Map<string, Entry>> {
    if (this.index) return this.index;
    const index = new Map<string, Entry>();
    await mkdir(this.dir, { recursive: true });
    let total = 0;
    for (const file of await readdir(this.dir).catch(() => [] as string[])) {
      if (file.endsWith('.tmp')) {
        await rm(path.join(this.dir, file), { force: true });
        continue;
      }
      if (!file.endsWith('.bin')) continue;
      const info = await stat(path.join(this.dir, file)).catch(() => null);
      if (!info) continue;
      index.set(file.slice(0, -4), { size: info.size, usedAt: info.mtimeMs });
      total += info.size;
    }
    this.index = index;
    this.total = total;
    return index;
  }

  /** The cached file for a key, or null. */
  async get(key: string): Promise<CachedAsset | null> {
    const index = await this.load();
    const name = this.name(key);
    if (!index.has(name)) return null;
    try {
      const [data, meta] = await Promise.all([readFile(this.dataPath(name)), readFile(this.metaPath(name), 'utf8')]);
      const parsed = JSON.parse(meta) as { key?: unknown; mime?: unknown };
      if (parsed.key !== key) return null;
      const time = new Date(this.now());
      index.get(name)!.usedAt = time.getTime();
      void utimes(this.dataPath(name), time, time).catch(() => undefined);
      return { mime: typeof parsed.mime === 'string' ? parsed.mime : 'application/octet-stream', data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    } catch {
      // The file vanished or its note is broken: forget it.
      await this.drop(name);
      return null;
    }
  }

  /** Stores a file. One larger than the whole cache is not kept. Failures are swallowed: a cache is only a speed-up. */
  put(key: string, mime: string, data: Uint8Array): Promise<void> {
    const run = this.chain.then(() => this.write(key, mime, data)).catch(() => undefined);
    this.chain = run;
    return run;
  }

  private async write(key: string, mime: string, data: Uint8Array): Promise<void> {
    if (data.byteLength > this.maxBytes) return;
    const index = await this.load();
    const name = this.name(key);
    const previous = index.get(name);
    const temporary = `${this.dataPath(name)}.tmp`;
    await writeFile(temporary, data);
    await writeFile(this.metaPath(name), JSON.stringify({ key, mime }));
    await rename(temporary, this.dataPath(name));
    this.total += data.byteLength - (previous?.size ?? 0);
    index.set(name, { size: data.byteLength, usedAt: this.now() });
    await this.prune(name);
  }

  /** Removes the oldest-used files until the folder fits. `keep` is the file just written. */
  private async prune(keep: string): Promise<void> {
    const index = await this.load();
    if (this.total <= this.maxBytes) return;
    const oldest = [...index.entries()].filter(([name]) => name !== keep).sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [name] of oldest) {
      if (this.total <= this.maxBytes) break;
      await this.drop(name);
    }
  }

  private async drop(name: string): Promise<void> {
    const entry = this.index?.get(name);
    if (entry) this.total -= entry.size;
    this.index?.delete(name);
    await Promise.all([rm(this.dataPath(name), { force: true }), rm(this.metaPath(name), { force: true })]);
  }

  /** Bytes in the cache. */
  async size(): Promise<number> {
    await this.load();
    return this.total;
  }

  /** Waits for writes started so far (tests, shutdown). */
  async idle(): Promise<void> {
    await this.chain;
  }
}
