import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupGgufQuants, listMmprojFiles, lookupHuggingFace } from '../src/local-llm/huggingface.js';
import { chooseVisionFiles, pickMmproj, readVisionPick, VisionModel, writeVisionPick } from '../src/local-vision/vision-model.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const MODEL_BYTES = 'model-bytes';
const MMPROJ_BYTES = 'mmproj-bytes';
const siblings = [
  { rfilename: 'README.md', size: 5 },
  { rfilename: 'Qwen3-VL-8B-Instruct-Q8_0.gguf', size: 9_000, lfs: { sha256: sha('x'), size: 9_000 } },
  { rfilename: 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf', size: MODEL_BYTES.length, lfs: { sha256: sha(MODEL_BYTES), size: MODEL_BYTES.length } },
  { rfilename: 'mmproj-Qwen3-VL-8B-Instruct-Q8_0.gguf', size: 500, lfs: { sha256: sha('y'), size: 500 } },
  { rfilename: 'mmproj-Qwen3-VL-8B-Instruct-F16.gguf', size: MMPROJ_BYTES.length, lfs: { sha256: sha(MMPROJ_BYTES), size: MMPROJ_BYTES.length } },
];

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-'));
  dirs.push(dir);
  return dir;
};

describe('picking the vision files from a repo listing', () => {
  it('takes the Q4_K_M model (never the mmproj) and the F16 projector', () => {
    expect(groupGgufQuants(siblings).map((quant) => quant.label)).toEqual(['Q4_K_M', 'Q8_0']);
    expect(listMmprojFiles(siblings).map((file) => file.path)).toEqual(['mmproj-Qwen3-VL-8B-Instruct-F16.gguf', 'mmproj-Qwen3-VL-8B-Instruct-Q8_0.gguf']);
    const chosen = chooseVisionFiles({ repo: 'ggml-org/Qwen3-VL-8B-Instruct-GGUF', gated: false, suggestions: [], quants: groupGgufQuants(siblings), mmproj: listMmprojFiles(siblings) });
    expect(chosen.quant.files[0].path).toBe('Qwen3-VL-8B-Instruct-Q4_K_M.gguf');
    expect(chosen.mmproj.path).toBe('mmproj-Qwen3-VL-8B-Instruct-F16.gguf');
  });

  it('prefers f16, then bf16, then q8_0', () => {
    const file = (name: string, size = 1) => ({ path: name, size });
    expect(pickMmproj([file('mmproj-Q8_0.gguf'), file('mmproj-BF16.gguf'), file('mmproj-f16.gguf', 9)])?.path).toBe('mmproj-f16.gguf');
    expect(pickMmproj([file('mmproj-Q8_0.gguf'), file('mmproj-BF16.gguf')])?.path).toBe('mmproj-BF16.gguf');
    expect(pickMmproj([file('mmproj-Q4_0.gguf', 5), file('mmproj-Q8_0.gguf', 9)])?.path).toBe('mmproj-Q8_0.gguf');
    expect(pickMmproj([])).toBeNull();
  });

  it('rejects a repo without an mmproj file with a clear message', () => {
    const plain = siblings.filter((entry) => !/mmproj/i.test(entry.rfilename));
    expect(() => chooseVisionFiles({ repo: 'unsloth/Qwen3-8B-GGUF', gated: false, suggestions: [], quants: groupGgufQuants(plain), mmproj: listMmprojFiles(plain) })).toThrow(
      /no mmproj file, so it can't read images/,
    );
  });

  it('lookupHuggingFace lists the mmproj files too', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'ggml-org/Qwen3-VL-8B-Instruct-GGUF', siblings })) as unknown as typeof fetch;
    const lookup = await lookupHuggingFace({ repo: 'ggml-org/Qwen3-VL-8B-Instruct-GGUF' }, undefined, fetchFn);
    expect(lookup.mmproj?.map((file) => file.path)).toContain('mmproj-Qwen3-VL-8B-Instruct-F16.gguf');
    expect(lookup.selected).toBe('Qwen3-VL-8B-Instruct-Q4_K_M.gguf');
  });
});

describe('local-vision.json', () => {
  it('writes and reads the pick, and ignores a missing or broken file', async () => {
    const file = path.join(tmp(), 'nested', 'local-vision.json');
    expect(await readVisionPick(file)).toBeNull();
    const pick = { repo: 'ggml-org/Qwen3-VL-8B-Instruct-GGUF', model: 'C:\\m\\a.gguf', mmproj: 'C:\\m\\b.gguf', alias: 'qwen3-vl' };
    await writeVisionPick(file, pick);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(pick);
    expect(await readVisionPick(file)).toEqual(pick);
    await writeVisionPick(file, pick);
    expect(await readVisionPick(path.join(path.dirname(file), 'other.json'))).toBeNull();
  });
});

describe('downloading the vision model', () => {
  const fixtureFetch = (missing: string[] = []) =>
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const repo = /huggingface\.co\/api\/models\/([^?]+)/.exec(url)?.[1];
      if (repo) return missing.includes(repo) ? json({}, 404) : json({ id: repo, siblings });
      if (url.endsWith('Q4_K_M.gguf')) return new Response(MODEL_BYTES, { status: 200 });
      if (url.endsWith('F16.gguf')) return new Response(MMPROJ_BYTES, { status: 200 });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

  const waitReady = async (model: VisionModel) => {
    for (let i = 0; i < 100; i += 1) {
      const status = await model.status();
      if (status.ready) return status;
      if (status.download?.state === 'failed') throw new Error(status.download.error);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('never ready');
  };

  it('fetches both files into vision/<repo>, saves the pick and reports Ready', async () => {
    const base = tmp();
    const fetchFn = fixtureFetch();
    const model = new VisionModel({ file: path.join(base, 'local-vision.json'), modelsDirectory: path.join(base, 'models'), token: () => 'hf_token', fetchFn, freeSpace: async () => null });
    expect((await model.status()).ready).toBe(false);
    await model.download();
    const status = await waitReady(model);
    expect(status.pick?.repo).toBe('ggml-org/Qwen3-VL-8B-Instruct-GGUF');
    expect(status.pick?.alias).toBe('qwen3-vl');
    expect(status.pick?.model).toBe(path.join(base, 'models', 'vision', 'ggml-org--Qwen3-VL-8B-Instruct-GGUF', 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf'));
    expect(readFileSync(status.pick!.model, 'utf8')).toBe(MODEL_BYTES);
    expect(readFileSync(status.pick!.mmproj, 'utf8')).toBe(MMPROJ_BYTES);
    expect(status.sizeBytes).toBe(MODEL_BYTES.length + MMPROJ_BYTES.length);
    expect(await model.pick()).toEqual(status.pick);
  });

  it('falls back to the unsloth repo when the first is not found', async () => {
    const base = tmp();
    const model = new VisionModel({
      file: path.join(base, 'local-vision.json'),
      modelsDirectory: path.join(base, 'models'),
      token: () => undefined,
      fetchFn: fixtureFetch(['ggml-org/Qwen3-VL-8B-Instruct-GGUF']),
      freeSpace: async () => null,
    });
    await model.download();
    expect((await waitReady(model)).pick?.repo).toBe('unsloth/Qwen3-VL-8B-Instruct-GGUF');
  });

  it('downloads another repo given as a link, and rejects search words and repos without mmproj', async () => {
    const base = tmp();
    const noProjector = siblings.filter((entry) => !/mmproj/i.test(entry.rfilename));
    const fetchFn = vi.fn(async (input: unknown) => {
      const repo = /api\/models\/([^?]+)/.exec(String(input))?.[1];
      if (repo === 'someone/plain-GGUF') return json({ id: repo, siblings: noProjector });
      if (repo) return json({ id: repo, siblings });
      return new Response(String(input).endsWith('F16.gguf') ? MMPROJ_BYTES : MODEL_BYTES, { status: 200 });
    }) as unknown as typeof fetch;
    const model = new VisionModel({ file: path.join(base, 'v.json'), modelsDirectory: path.join(base, 'm'), token: () => undefined, fetchFn, freeSpace: async () => null });
    await expect(model.download('qwen vision')).rejects.toThrow(/Paste a Hugging Face link or repo name/);
    await expect(model.download('someone/plain-GGUF')).rejects.toThrow(/no mmproj file/);
    expect(existsSync(path.join(base, 'v.json'))).toBe(false);
    await model.download('https://huggingface.co/someone/Qwen3-VL-8B-Instruct-GGUF');
    expect((await waitReady(model)).pick?.repo).toBe('someone/Qwen3-VL-8B-Instruct-GGUF');
  });
});
