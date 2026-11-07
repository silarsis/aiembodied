import { describe, expect, it, vi } from 'vitest';
import {
  aliasFor,
  groupGgufQuants,
  lookupHuggingFace,
  parseHuggingFaceRef,
  pickDefaultQuant,
  quantOf,
  resolveUrl,
} from '../src/local-llm/huggingface.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sha = (char: string) => char.repeat(64);

const siblings = [
  { rfilename: 'README.md', size: 10 },
  { rfilename: 'Qwen3-8B-Q2_K.gguf', size: 3_000, lfs: { sha256: sha('a'), size: 3_000 } },
  { rfilename: 'Qwen3-8B-Q4_K_M.gguf', size: 5_000, lfs: { sha256: sha('b'), size: 5_000 } },
  { rfilename: 'Qwen3-8B-Q8_0.gguf', size: 9_000, lfs: { sha256: sha('c'), size: 9_000 } },
  { rfilename: 'mmproj-F16.gguf', size: 600 },
  { rfilename: 'BF16/Qwen3-8B-BF16-00002-of-00002.gguf', size: 8_000, lfs: { sha256: sha('d'), size: 8_000 } },
  { rfilename: 'BF16/Qwen3-8B-BF16-00001-of-00002.gguf', size: 8_000, lfs: { sha256: sha('e'), size: 8_000 } },
];

describe('Hugging Face references', () => {
  it('reads links, repo names, llama.cpp -hf names and search words', () => {
    expect(parseHuggingFaceRef('https://huggingface.co/unsloth/Qwen3-8B-GGUF')).toEqual({ repo: 'unsloth/Qwen3-8B-GGUF' });
    expect(parseHuggingFaceRef('https://huggingface.co/unsloth/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf?download=true')).toEqual({
      repo: 'unsloth/Qwen3-8B-GGUF',
      file: 'Qwen3-8B-Q4_K_M.gguf',
    });
    expect(parseHuggingFaceRef('https://huggingface.co/unsloth/Qwen3-235B-GGUF/tree/main/UD-Q4_K_XL')).toEqual({ repo: 'unsloth/Qwen3-235B-GGUF', quant: 'UD-Q4_K_XL' });
    expect(parseHuggingFaceRef('hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M')).toEqual({ repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', quant: 'Q4_K_M' });
    expect(parseHuggingFaceRef(' unsloth/Qwen3-8B-GGUF:q8_0 ')).toEqual({ repo: 'unsloth/Qwen3-8B-GGUF', quant: 'q8_0' });
    expect(parseHuggingFaceRef('Qwen/Qwen3-8B')).toEqual({ repo: 'Qwen/Qwen3-8B' });
    expect(parseHuggingFaceRef('qwen3 8b')).toEqual({ search: 'qwen3 8b' });
    expect(parseHuggingFaceRef('gemma')).toEqual({ search: 'gemma' });
    expect(parseHuggingFaceRef('https://example.com/unsloth/Qwen3-8B-GGUF')).toBeNull();
    expect(parseHuggingFaceRef('')).toBeNull();
  });

  it('finds the quant in file and folder names', () => {
    expect(quantOf('Qwen3-8B-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantOf('model.q8_0.gguf')).toBe('Q8_0');
    expect(quantOf('Qwen3-30B-A3B-UD-Q4_K_XL.gguf')).toBe('UD-Q4_K_XL');
    expect(quantOf('Llama-3.2-3B-Instruct-IQ4_XS.gguf')).toBe('IQ4_XS');
    expect(quantOf('BF16/Qwen3-8B-BF16-00001-of-00002.gguf')).toBe('BF16');
    expect(quantOf('UD-Q2_K_XL/model-00001-of-00003.gguf')).toBe('UD-Q2_K_XL');
    expect(quantOf('qwen3.gguf')).toBeNull();
  });
});

describe('GGUF sizes', () => {
  it('groups split parts, leaves out vision projectors and sorts by size', () => {
    const quants = groupGgufQuants(siblings);
    expect(quants.map((quant) => [quant.label, quant.sizeBytes, quant.files.length])).toEqual([
      ['Q2_K', 3_000, 1],
      ['Q4_K_M', 5_000, 1],
      ['Q8_0', 9_000, 1],
      ['BF16', 16_000, 2],
    ]);
    const bf16 = quants[3];
    expect(bf16.id).toBe('BF16/Qwen3-8B-BF16.gguf');
    expect(bf16.files.map((file) => file.path)).toEqual(['BF16/Qwen3-8B-BF16-00001-of-00002.gguf', 'BF16/Qwen3-8B-BF16-00002-of-00002.gguf']);
    expect(quants[1].files[0].sha256).toBe(sha('b'));
  });

  it('names files apart when two share a quant', () => {
    const quants = groupGgufQuants([
      { rfilename: 'small-Q4_K_M.gguf', size: 1 },
      { rfilename: 'large-Q4_K_M.gguf', size: 2 },
    ]);
    expect(quants.map((quant) => quant.label)).toEqual(['small-Q4_K_M', 'large-Q4_K_M']);
  });

  it('preselects the asked-for size, else Q4_K_M, else the middle one', () => {
    const quants = groupGgufQuants(siblings);
    expect(pickDefaultQuant(quants)).toBe('Qwen3-8B-Q4_K_M.gguf');
    expect(pickDefaultQuant(quants, 'q8_0')).toBe('Qwen3-8B-Q8_0.gguf');
    expect(pickDefaultQuant(quants, undefined, 'BF16/Qwen3-8B-BF16-00002-of-00002.gguf')).toBe('BF16/Qwen3-8B-BF16.gguf');
    expect(pickDefaultQuant(groupGgufQuants([{ rfilename: 'a-Q2_K.gguf', size: 1 }, { rfilename: 'a-Q3_K_S.gguf', size: 2 }, { rfilename: 'a-Q6_K.gguf', size: 3 }]))).toBe(
      'a-Q3_K_S.gguf',
    );
  });

  it('names the model for llama-server and links the files', () => {
    expect(aliasFor('unsloth/Qwen3-8B-GGUF', 'Q4_K_M')).toBe('qwen3-8b-q4_k_m');
    expect(resolveUrl('unsloth/Qwen3-8B-GGUF', 'BF16/a b.gguf')).toBe('https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/BF16/a%20b.gguf');
  });
});

describe('lookupHuggingFace', () => {
  it('lists the sizes of a GGUF repo, with the token when there is one', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://huggingface.co/api/models/unsloth/Qwen3-8B-GGUF?blobs=true');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer hf_x');
      return json({ id: 'unsloth/Qwen3-8B-GGUF', gated: false, siblings, gguf: { context_length: 40960 } });
    }) as unknown as typeof fetch;
    const lookup = await lookupHuggingFace({ repo: 'unsloth/Qwen3-8B-GGUF', quant: 'Q8_0' }, 'hf_x', fetchFn);
    expect(lookup.repo).toBe('unsloth/Qwen3-8B-GGUF');
    expect(lookup.quants).toHaveLength(4);
    expect(lookup.selected).toBe('Qwen3-8B-Q8_0.gguf');
    expect(lookup.contextLength).toBe(40960);
    expect(lookup.suggestions).toEqual([]);
  });

  it('suggests GGUF versions of a base model', async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes('/api/models/Qwen/Qwen3-8B')) return json({ id: 'Qwen/Qwen3-8B', siblings: [{ rfilename: 'model.safetensors' }] });
      return json([{ id: 'unsloth/Qwen3-8B-GGUF', downloads: 900, likes: 5 }]);
    }) as unknown as typeof fetch;
    const lookup = await lookupHuggingFace({ repo: 'Qwen/Qwen3-8B' }, undefined, fetchFn);
    expect(lookup.quants).toEqual([]);
    expect(lookup.suggestions).toEqual([{ repo: 'unsloth/Qwen3-8B-GGUF', downloads: 900, likes: 5 }]);
    expect(lookup.note).toContain('no GGUF files');
    const search = new URL(urls[1]);
    expect(search.searchParams.getAll('filter')).toEqual(['base_model:quantized:Qwen/Qwen3-8B', 'gguf']);
  });

  it('searches GGUF repos for words', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('search')).toBe('qwen3 8b');
      expect(parsed.searchParams.get('filter')).toBe('gguf');
      return json([{ id: 'a/b-GGUF', downloads: 1, likes: 0 }]);
    }) as unknown as typeof fetch;
    const lookup = await lookupHuggingFace({ search: 'qwen3 8b' }, undefined, fetchFn);
    expect(lookup.suggestions.map((entry) => entry.repo)).toEqual(['a/b-GGUF']);
  });

  it('explains a missing repo and a gated one', async () => {
    const missing = vi.fn(async (url: string | URL | Request) => (String(url).includes('/api/models/') && !String(url).includes('?sort') && String(url).includes('blobs') ? json({}, 404) : json([]))) as unknown as typeof fetch;
    await expect(lookupHuggingFace({ repo: 'nobody/nothing' }, undefined, missing)).resolves.toMatchObject({ quants: [], note: expect.stringContaining('no public model') });
    const gated = vi.fn(async () => json({}, 401)) as unknown as typeof fetch;
    await expect(lookupHuggingFace({ repo: 'meta-llama/Llama-3-GGUF' }, undefined, gated)).rejects.toThrow('needs a Hugging Face token');
  });
});
