import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetCache } from '../../src/satellite/asset-cache.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const dir = () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'asset-cache-'));
  folders.push(folder);
  return path.join(folder, 'cache', 'assets');
};
const bytes = (length: number, fill = 1) => new Uint8Array(length).fill(fill);

describe('AssetCache', () => {
  it('keeps a file by its key and gives it back with its type', async () => {
    const cache = new AssetCache({ dir: dir() });
    expect(await cache.get('aiembodied-asset://polyhaven/chair/chair.glb')).toBeNull();
    await cache.put('aiembodied-asset://polyhaven/chair/chair.glb', 'model/gltf-binary', bytes(10, 7));
    const hit = await cache.get('aiembodied-asset://polyhaven/chair/chair.glb');
    expect(hit?.mime).toBe('model/gltf-binary');
    expect(Array.from(hit?.data ?? [])).toEqual(Array(10).fill(7));
    expect(await cache.get('aiembodied-asset://polyhaven/chair/other.glb')).toBeNull();
  });

  it('is still there after a restart (a new cache on the same folder)', async () => {
    const folder = dir();
    await new AssetCache({ dir: folder }).put('k', 'text/plain', bytes(4, 3));
    const again = new AssetCache({ dir: folder });
    expect(Array.from((await again.get('k'))?.data ?? [])).toEqual([3, 3, 3, 3]);
    expect(await again.size()).toBe(4);
  });

  it('replaces a key without counting it twice', async () => {
    const cache = new AssetCache({ dir: dir() });
    await cache.put('k', 'a', bytes(100));
    await cache.put('k', 'a', bytes(30));
    expect(await cache.size()).toBe(30);
  });

  it('drops the oldest-used files when it grows past its cap', async () => {
    let now = 1000;
    const cache = new AssetCache({ dir: dir(), maxBytes: 100, now: () => (now += 10) });
    await cache.put('a', 'x', bytes(40));
    await cache.put('b', 'x', bytes(40));
    // Using "a" makes "b" the oldest.
    expect(await cache.get('a')).not.toBeNull();
    await cache.put('c', 'x', bytes(40));
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('a')).not.toBeNull();
    expect(await cache.get('c')).not.toBeNull();
    expect(await cache.size()).toBe(80);
  });

  it('does not keep a file bigger than the whole cache, and leaves the rest alone', async () => {
    const cache = new AssetCache({ dir: dir(), maxBytes: 50 });
    await cache.put('small', 'x', bytes(20));
    await cache.put('huge', 'x', bytes(51));
    expect(await cache.get('huge')).toBeNull();
    expect(await cache.get('small')).not.toBeNull();
  });

  it('leaves no half-written files behind', async () => {
    const folder = dir();
    const cache = new AssetCache({ dir: folder });
    await Promise.all([cache.put('a', 'x', bytes(10)), cache.put('b', 'x', bytes(10)), cache.put('c', 'x', bytes(10))]);
    await cache.idle();
    expect(readdirSync(folder).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(folder).filter((name) => name.endsWith('.bin'))).toHaveLength(3);
  });
});
