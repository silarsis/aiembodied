import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HfQuant } from '../src/local-llm/huggingface.js';
import { LlmLibrary, type LlmDownload, type LlmLibraryOptions } from '../src/local-llm/llm-library.js';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const partA = Buffer.from('first part of the model ');
const partB = Buffer.from('second part');
const quant: HfQuant = {
  id: 'Q4/m-Q4_K_M.gguf',
  label: 'Q4_K_M',
  sizeBytes: partA.length + partB.length,
  files: [
    { path: 'Q4/m-Q4_K_M-00001-of-00002.gguf', size: partA.length, sha256: sha(partA) },
    { path: 'Q4/m-Q4_K_M-00002-of-00002.gguf', size: partB.length, sha256: sha(partB) },
  ],
};

/** Serves the two parts, honouring Range like Hugging Face's CDN. */
function server(bodies: Record<string, Buffer> = { '00001': partA, '00002': partB }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = Object.keys(bodies).find((name) => String(url).includes(name));
    if (!key) return new Response('missing', { status: 404 });
    const range = /bytes=(\d+)-/.exec((init?.headers as Record<string, string>)?.Range ?? '');
    const body = bodies[key];
    return range ? new Response(body.subarray(Number(range[1])), { status: 206 }) : new Response(body, { status: 200 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

async function library(overrides: Partial<LlmLibraryOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'llm-library-'));
  folders.push(root);
  const lib = new LlmLibrary({
    file: path.join(root, 'userData', 'local-llm.json'),
    modelsDirectory: path.join(root, 'models'),
    fetchFn: server(),
    freeSpace: async () => 10 * 1024 ** 3,
    ...overrides,
  });
  return { lib, root };
}

async function settle(lib: LlmLibrary, id: string): Promise<LlmDownload> {
  for (let i = 0; i < 200; i += 1) {
    const entry = lib.list().find((download) => download.id === id);
    if (entry && !['queued', 'downloading', 'verifying'].includes(entry.state) && (entry.state !== 'done' || !entry.use || entry.result)) return entry;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('download did not finish');
}

describe('LlmLibrary', () => {
  it('downloads every part, checks it, records it and puts it to use', async () => {
    const onDownloaded = vi.fn(async () => 'llama-server is restarting');
    const { lib, root } = await library({ onDownloaded });
    const started = await lib.start('unsloth/M-GGUF', quant, { use: true, contextLength: 32768 });
    const done = await settle(lib, started.id);
    expect(done).toMatchObject({ state: 'done', received: quant.sizeBytes, result: 'llama-server is restarting' });
    const folder = path.join(root, 'models', 'unsloth', 'M-GGUF', 'Q4');
    expect(await readFile(path.join(folder, 'm-Q4_K_M-00002-of-00002.gguf'), 'utf8')).toBe('second part');
    const saved = await lib.read();
    expect(saved.models).toEqual([
      expect.objectContaining({ id: 'unsloth/M-GGUF:Q4/m-Q4_K_M.gguf', alias: 'm-q4_k_m', path: path.join(folder, 'm-Q4_K_M-00001-of-00002.gguf'), contextLength: 32768 }),
    ]);
    expect(onDownloaded).toHaveBeenCalledWith(expect.objectContaining({ alias: 'm-q4_k_m' }));
  });

  it('resumes a partial file with a range request', async () => {
    const fetchFn = server();
    const { lib, root } = await library({ fetchFn });
    const folder = path.join(root, 'models', 'o', 'r', 'Q4');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'm-Q4_K_M-00001-of-00002.gguf.part'), partA.subarray(0, 6));
    const done = await settle(lib, (await lib.start('o/r', quant, { use: false })).id);
    expect(done.state).toBe('done');
    expect((fetchFn.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Range: 'bytes=6-' });
    expect(await readFile(path.join(folder, 'm-Q4_K_M-00001-of-00002.gguf'))).toEqual(partA);
  });

  it('fails a damaged file and throws its part away', async () => {
    const { lib, root } = await library({ fetchFn: server({ '00001': Buffer.from('garbage garbage garbage!'), '00002': partB }) });
    const done = await settle(lib, (await lib.start('o/r', quant, { use: false })).id);
    expect(done).toMatchObject({ state: 'failed', error: expect.stringContaining('checksum') });
    await expect(stat(path.join(root, 'models', 'o', 'r', 'Q4', 'm-Q4_K_M-00001-of-00002.gguf.part'))).rejects.toThrow();
  });

  it('refuses a download the drive has no room for', async () => {
    const { lib } = await library({ freeSpace: async () => 1024 });
    await expect(lib.start('o/r', quant, { use: false })).rejects.toThrow('Not enough disk space');
  });

  it('explains a gated model', async () => {
    const { lib } = await library({ fetchFn: vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch });
    const done = await settle(lib, (await lib.start('meta/x', quant, { use: false })).id);
    expect(done.error).toContain('Gated models');
  });

  it('picks, refuses to delete the one in use, and deletes the others', async () => {
    const { lib, root } = await library();
    await settle(lib, (await lib.start('o/r', quant, { use: false })).id);
    const id = 'o/r:Q4/m-Q4_K_M.gguf';
    await expect(lib.select(id)).resolves.toMatchObject({ alias: 'r-q4_k_m' });
    await expect(lib.selected()).resolves.toMatchObject({ id });
    await expect(lib.remove(id)).rejects.toThrow('in use');
    await lib.select(null);
    await expect(lib.selected()).resolves.toBeNull();
    await lib.remove(id);
    expect((await lib.read()).models).toEqual([]);
    await expect(stat(path.join(root, 'models', 'o', 'r', 'Q4', 'm-Q4_K_M-00001-of-00002.gguf'))).rejects.toThrow();
  });
});
