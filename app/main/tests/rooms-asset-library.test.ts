import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gltfBounds } from '../src/rooms/asset-library/gltf-bounds.js';
import { PolyHavenClient, safeRelative, MAX_CONCURRENT_DOWNLOADS } from '../src/rooms/asset-library/polyhaven.js';
import { PolyHavenSource, resolveObject } from '../src/rooms/asset-library/library-source.js';
import { findBestModel } from '../src/rooms/asset-library/search.js';
import { fitModel } from '../src/rooms/room-model-fit.js';
import { validateLayout } from '../src/rooms/room-layout.js';
import { ASSET_SCHEME, mimeFor, registerAssetProtocol, resolveAssetPath } from '../src/rooms/asset-protocol.js';
import type { CatalogEntry } from '../src/rooms/asset-library/types.js';

const catalog: CatalogEntry[] = [
  { id: 'ArmChair_01', name: 'Armchair 01', categories: ['furniture', 'seating'], tags: ['chair', 'fabric', 'living room'] },
  { id: 'SchoolChair_01', name: 'School Chair 01', categories: ['furniture', 'seating'], tags: ['chair', 'school', 'wood'] },
  { id: 'Sofa_01', name: 'Sofa 01', categories: ['furniture', 'seating'], tags: ['couch', 'leather'] },
  { id: 'CoffeeTable_01', name: 'Coffee Table 01', categories: ['furniture', 'tables'], tags: ['table', 'living room'] },
  { id: 'coffee_cup_01', name: 'Coffee Cup', categories: ['props', 'household'], tags: ['mug', 'cup'] },
  { id: 'potted_plant_01', name: 'Potted Plant 01', categories: ['plants', 'decorative'], tags: ['plant', 'pot', 'indoor'] },
  { id: 'Bookshelf_02', name: 'Bookshelf', categories: ['furniture', 'shelves'], tags: ['books', 'shelf'] },
  { id: 'boulder_01', name: 'Boulder 01', categories: ['rocks', 'nature'], tags: ['stone', 'rock'] },
];
const query = (search: string, category: Parameters<typeof findBestModel>[1]['category'], name = search) => findBestModel(catalog, { search, name, category })?.entry.id ?? null;

describe('model search', () => {
  it('matches exact words, plurals and synonyms within compatible categories', () => {
    expect(query('armchair fabric', 'seat', 'armchair')).toBe('ArmChair_01');
    expect(query('couch', 'seat', 'sofa')).toBe('Sofa_01');
    expect(query('coffee table', 'table')).toBe('CoffeeTable_01');
    expect(query('mug', 'prop')).toBe('coffee_cup_01');
    expect(query('plants', 'plant')).toBe('potted_plant_01');
    expect(query('bookcase', 'storage', 'bookshelves')).toBe('Bookshelf_02');
  });
  it('returns nothing below the threshold or in the wrong category', () => {
    expect(query('spaceship', 'prop')).toBeNull();
    expect(query('boulder', 'seat')).toBeNull();
    expect(query('dragon', 'decor')).toBeNull();
  });
  it('is deterministic on ties', () => {
    const twin = [{ id: 'b_chair', name: 'Chair', categories: ['furniture'], tags: [] }, { id: 'a_chair', name: 'Chair', categories: ['furniture'], tags: [] }];
    expect(findBestModel(twin, { search: 'chair', name: 'chair', category: 'seat' })?.entry.id).toBe('a_chair');
  });
});

describe('glTF bounding box', () => {
  const gltf = {
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { translation: [10, 0, 0], children: [1, 2] },
      { mesh: 0 },
      { mesh: 0, scale: [2, 2, 2], translation: [0, 1, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: [-1, 0, -0.5], max: [1, 1, 0.5] }],
  };
  it('applies node transforms to the POSITION ranges', () => {
    const bounds = gltfBounds(gltf)!;
    expect(bounds.min).toEqual([8, 0, -1]);
    expect(bounds.max).toEqual([12, 3, 1]);
    expect(bounds.size).toEqual([4, 3, 2]);
  });
  it('handles rotation and returns null without meshes', () => {
    const s = Math.SQRT1_2;
    const rotated = gltfBounds({ ...gltf, nodes: [{ mesh: 0, rotation: [0, s, 0, s] }], scenes: [{ nodes: [0] }] })!;
    expect(rotated.size[0]).toBeCloseTo(1);
    expect(rotated.size[2]).toBeCloseTo(2);
    expect(gltfBounds({ nodes: [{}], scenes: [{ nodes: [0] }] })).toBeNull();
  });
  it('fits the height with the scale clamped', () => {
    const bounds = gltfBounds(gltf)!;
    expect(fitModel(bounds, [1, 1.5, 1])).toEqual({ scale: 0.5, size: [2, 1.5, 1] });
    expect(fitModel(bounds, [1, 100, 1]).scale).toBe(2);
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'polyhaven-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const md5 = (data: string) => createHash('md5').update(data).digest('hex');
const GLTF = JSON.stringify({ scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }] });
function fakeFetch(options: { badMd5?: boolean; failFiles?: boolean; extra?: number } = {}) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let active = 0;
  let peak = 0;
  const include: Record<string, { url: string; md5: string }> = { 'ArmChair_01.bin': { url: 'https://dl.polyhaven.org/x/ArmChair_01.bin', md5: options.badMd5 ? 'deadbeef' : md5('BIN') } };
  for (let i = 0; i < (options.extra ?? 0); i += 1) include[`textures/t${i}.jpg`] = { url: `https://dl.polyhaven.org/x/t${i}.jpg`, md5: md5('BIN') };
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url === 'https://api.polyhaven.com/assets?t=models')
      return Response.json(Object.fromEntries(catalog.map((c) => [c.id, { name: c.name, categories: c.categories, tags: c.tags }])));
    if (url === 'https://api.polyhaven.com/files/ArmChair_01')
      return Response.json({ gltf: { '1k': { gltf: { url: 'https://dl.polyhaven.org/x/ArmChair_01_1k.gltf', md5: md5(GLTF), include } } } });
    if (url.startsWith('https://dl.polyhaven.org/')) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      if (options.failFiles) return new Response('no', { status: 500 });
      return new Response(url.endsWith('.gltf') ? GLTF : 'BIN');
    }
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, requests, peak: () => peak };
}

describe('PolyHavenClient', () => {
  it('caches the catalog for 7 days and sends a descriptive User-Agent', async () => {
    const net = fakeFetch();
    let now = 1_000_000;
    const client = () => new PolyHavenClient({ root: dir, fetchFn: net.fn, appVersion: '1.2.3', now: () => now });
    expect((await client().catalog()).map((c) => c.id)).toContain('ArmChair_01');
    expect(net.requests[0].headers['User-Agent']).toBe('aiembodied/1.2.3 room builder');
    await client().catalog();
    expect(net.requests.filter((r) => r.url.includes('t=models'))).toHaveLength(1);
    now += 8 * 24 * 3600 * 1000;
    await client().catalog();
    expect(net.requests.filter((r) => r.url.includes('t=models'))).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(dir, 'polyhaven', 'catalog.json'), 'utf8')).assets.Sofa_01).toBeTruthy();
  });
  it('uses the stale catalog when the network fails', async () => {
    const net = fakeFetch();
    let now = 0;
    await new PolyHavenClient({ root: dir, fetchFn: net.fn, now: () => now }).catalog();
    now = 30 * 24 * 3600 * 1000;
    const failing = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    const stale = await new PolyHavenClient({ root: dir, fetchFn: failing, now: () => now, logger: { warn: vi.fn() } }).catalog();
    expect(stale).toHaveLength(catalog.length);
    await expect(new PolyHavenClient({ root: path.join(dir, 'empty'), fetchFn: failing }).catalog()).rejects.toThrow('offline');
  });
  it('downloads a model with its includes, verifies md5, and reuses the cache', async () => {
    const net = fakeFetch({ extra: 5 });
    const client = new PolyHavenClient({ root: dir, fetchFn: net.fn });
    const model = await client.ensureModel('ArmChair_01');
    expect(model).toMatchObject({ asset: 'polyhaven/ArmChair_01', file: 'ArmChair_01_1k.gltf' });
    expect(await readFile(model.path, 'utf8')).toBe(GLTF);
    expect(await readFile(path.join(dir, 'polyhaven', 'ArmChair_01', 'textures', 't3.jpg'), 'utf8')).toBe('BIN');
    expect((await readdir(path.join(dir, 'polyhaven', 'ArmChair_01'))).some((n) => n.endsWith('.part'))).toBe(false);
    expect(net.peak()).toBeLessThanOrEqual(MAX_CONCURRENT_DOWNLOADS);
    expect(net.peak()).toBeGreaterThan(1);
    const before = net.requests.length;
    await client.ensureModel('ArmChair_01');
    await new PolyHavenClient({ root: dir, fetchFn: net.fn }).ensureModel('ArmChair_01');
    expect(net.requests).toHaveLength(before);
  });
  it('rejects a corrupt download and leaves no finished file', async () => {
    const net = fakeFetch({ badMd5: true });
    const client = new PolyHavenClient({ root: dir, fetchFn: net.fn });
    await expect(client.ensureModel('ArmChair_01')).rejects.toThrow(/md5/);
    await expect(stat(path.join(dir, 'polyhaven', 'ArmChair_01', 'ArmChair_01.bin'))).rejects.toThrow();
    await expect(stat(path.join(dir, 'polyhaven', 'ArmChair_01', 'asset.json'))).rejects.toThrow();
  });
  it('refuses unsafe ids and unsafe file paths', async () => {
    const client = new PolyHavenClient({ root: dir, fetchFn: fakeFetch().fn });
    await expect(client.ensureModel('../etc')).rejects.toThrow(/Unsafe/);
    expect(safeRelative('textures/a.jpg')).toBe('textures/a.jpg');
    for (const bad of ['../a', '/a', 'a/../../b', 'C:/a', 'a\\b', '']) expect(safeRelative(bad)).toBeNull();
    const evil = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/files/')
        ? Response.json({ gltf: { '1k': { gltf: { url: 'https://x.org/a.gltf', include: { '../../escape.bin': { url: 'https://x.org/e.bin' } } } } } })
        : new Response('x')) as unknown as typeof fetch;
    await expect(new PolyHavenClient({ root: dir, fetchFn: evil }).ensureModel('Evil_01')).rejects.toThrow(/unusable/);
  });
});

describe('library source', () => {
  it('finds, downloads and measures a model for a layout object', async () => {
    const net = fakeFetch();
    const source = new PolyHavenSource(new PolyHavenClient({ root: dir, fetchFn: net.fn }));
    const [chair] = validateLayout({ shell: { width: 5, depth: 5, height: 2.6 }, objects: [{ name: 'armchair', search: 'armchair fabric', category: 'seat', size: [0.9, 0.9, 0.9] }] }).objects;
    const found = await resolveObject([source], chair);
    expect(found?.model).toEqual({ asset: 'polyhaven/ArmChair_01', file: 'ArmChair_01_1k.gltf', scale: 0.9 });
    expect(found?.size).toEqual([0.9, 0.9, 0.9]);
    const [dragon] = validateLayout({ shell: { width: 5, depth: 5, height: 2.6 }, objects: [{ name: 'dragon', category: 'decor', size: [1, 1, 1] }] }).objects;
    expect(await resolveObject([source], dragon)).toBeNull();
  });
  it('gives null when the download fails', async () => {
    const source = new PolyHavenSource(new PolyHavenClient({ root: dir, fetchFn: fakeFetch({ failFiles: true }).fn }), { warn: vi.fn() });
    const [chair] = validateLayout({ shell: { width: 5, depth: 5, height: 2.6 }, objects: [{ name: 'armchair', category: 'seat', size: [1, 1, 1] }] }).objects;
    expect(await source.resolve(chair)).toBeNull();
  });
});

describe('asset protocol paths', () => {
  const root = path.join(os.tmpdir(), 'assets-root');
  const ok = (url: string) => resolveAssetPath(root, url);
  it('resolves files under the root', () => {
    expect(ok(`${ASSET_SCHEME}://polyhaven/ArmChair_01/textures/a%20b.jpg`)).toBe(path.join(root, 'polyhaven', 'ArmChair_01', 'textures', 'a b.jpg'));
  });
  it.each([
    `${ASSET_SCHEME}://polyhaven/../../secret`,
    `${ASSET_SCHEME}://polyhaven/%2e%2e/%2e%2e/secret`,
    `${ASSET_SCHEME}://polyhaven/a/..%2f..%2fsecret`,
    `${ASSET_SCHEME}://polyhaven/a%5c..%5csecret`,
    `${ASSET_SCHEME}://polyhaven`,
    `${ASSET_SCHEME}://../x/y`,
    'https://polyhaven/a/b',
    'not a url',
  ])('refuses %s', (url) => {
    // The URL parser may collapse dot segments; the result must never leave the root.
    const resolved = ok(url);
    if (resolved !== null) expect(resolved.startsWith(root + path.sep)).toBe(true);
  });
  it.each([
    `${ASSET_SCHEME}://polyhaven/a/..%2f..%2fsecret`,
    `${ASSET_SCHEME}://polyhaven/a%5c..%5csecret`,
    `${ASSET_SCHEME}://polyhaven`,
    'https://polyhaven/a/b',
    'not a url',
  ])('refuses outright %s', (url) => {
    expect(ok(url)).toBeNull();
  });
  it('serves a generated glb and its source picture', async () => {
    await mkdir(path.join(dir, 'generated', 'chair-3fa91c2e'), { recursive: true });
    await writeFile(path.join(dir, 'generated', 'chair-3fa91c2e', 'model.glb'), 'glb!');
    await writeFile(path.join(dir, 'generated', 'chair-3fa91c2e', 'source.png'), 'png!');
    let handler!: (request: { url: string }) => Promise<Response> | Response;
    registerAssetProtocol({ handle: (_scheme, h) => (handler = h) }, dir);
    const model = await handler({ url: `${ASSET_SCHEME}://generated/chair-3fa91c2e/model.glb` });
    expect(model.status).toBe(200);
    expect(model.headers.get('Content-Type')).toBe('model/gltf-binary');
    expect(await model.text()).toBe('glb!');
    expect((await handler({ url: `${ASSET_SCHEME}://generated/chair-3fa91c2e/source.png` })).headers.get('Content-Type')).toBe('image/png');
  });
  it('serves with the right MIME type and 404s otherwise', async () => {
    expect(mimeFor('a.gltf')).toBe('model/gltf+json');
    expect(mimeFor('a.bin')).toBe('application/octet-stream');
    expect(mimeFor('a.JPG')).toBe('image/jpeg');
    expect(mimeFor('a.png')).toBe('image/png');
    expect(mimeFor('a.glb')).toBe('model/gltf-binary');
    await mkdir(path.join(dir, 'polyhaven', 'x'), { recursive: true });
    await writeFile(path.join(dir, 'polyhaven', 'x', 'a.gltf'), '{}');
    let handler!: (request: { url: string }) => Promise<Response> | Response;
    registerAssetProtocol({ handle: (_scheme, h) => (handler = h) }, dir);
    const response = await handler({ url: `${ASSET_SCHEME}://polyhaven/x/a.gltf` });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('model/gltf+json');
    expect(await response.text()).toBe('{}');
    expect((await handler({ url: `${ASSET_SCHEME}://polyhaven/x/missing.gltf` })).status).toBe(404);
    expect((await handler({ url: `${ASSET_SCHEME}://polyhaven/../../etc/passwd` })).status).toBe(404);
  });
});
