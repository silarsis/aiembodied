import type { Dirent } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCoderGguf, pickCoderGguf } from '../src/coding/gguf-finder.js';

/** A fake folder tree: a map of folder -> entries. */
function tree(files: string[]): (dir: string) => Dirent[] {
  const folders = new Map<string, Map<string, boolean>>();
  for (const file of files) {
    let current = path.dirname(file);
    let child = path.basename(file);
    let isDir = false;
    for (;;) {
      const entries = folders.get(current) ?? new Map<string, boolean>();
      entries.set(child, isDir);
      folders.set(current, entries);
      const parent = path.dirname(current);
      if (parent === current || folders.has(parent) && folders.get(parent)!.has(path.basename(current))) break;
      child = path.basename(current);
      current = parent;
      isDir = true;
    }
  }
  return (dir) => [...(folders.get(dir) ?? [])].map(([name, directory]) => ({ name, isDirectory: () => directory }) as unknown as Dirent);
}

const home = path.resolve('/home/kevin');
const hf = path.join(home, '.cache', 'huggingface', 'hub', 'models--Qwen--Qwen3-Coder-Next-GGUF', 'snapshots', 'abc', 'Q4_K_M');

describe('coder GGUF finder', () => {
  it('prefers the first part of a split Q4_K_M model in the Hugging Face cache', () => {
    const files = [
      path.join(hf, 'Qwen3-Coder-Next-Q4_K_M-00002-of-00003.gguf'),
      path.join(hf, 'Qwen3-Coder-Next-Q4_K_M-00001-of-00003.gguf'),
      path.join(hf, 'Qwen3-Coder-Next-Q4_K_M-00003-of-00003.gguf'),
      path.join(home, '.cache', 'huggingface', 'hub', 'models--Qwen--Qwen3-Coder-Next-GGUF', 'snapshots', 'abc', 'Q8_0', 'Qwen3-Coder-Next-Q8_0.gguf'),
    ];
    expect(findCoderGguf({ homedir: home, env: {}, readdir: tree(files) })).toBe(files[1]);
  });

  it('falls back to llama.cpp’s folder, then the app’s model folder', () => {
    const local = path.resolve('/appdata/Local');
    const inLlama = path.join(local, 'llama.cpp', 'Qwen_Qwen3-Coder-Next-Q4_K_M.gguf');
    expect(
      findCoderGguf({ homedir: home, env: { AIEMBODIED_HOST_LOCALAPPDATA: local }, readdir: tree([inLlama, path.join(local, 'llama.cpp', 'other-Q4_K_M.gguf')]) }),
    ).toBe(inLlama);
    const ours = path.join(home, '.cache', 'aiembodied', 'llm-models', 'qwen3-coder-next', 'Qwen3-Coder-Next-Q4_K_M.gguf');
    expect(findCoderGguf({ homedir: home, env: {}, readdir: tree([ours]) })).toBe(ours);
    const custom = path.resolve('/models/Qwen3-Coder-Next-Q4_K_M-00001-of-00002.gguf');
    expect(findCoderGguf({ homedir: home, env: { LOCAL_LLM_MODELS_DIR: path.dirname(custom) }, readdir: tree([custom]) })).toBe(custom);
  });

  it('ignores other models and other quantisations, and returns null when nothing matches', () => {
    expect(pickCoderGguf(['/m/Qwen3-Coder-Next-Q8_0.gguf', '/m/Qwen3-Flash-Q4_K_M.gguf', '/m/readme.txt'])).toBeNull();
    expect(pickCoderGguf(['/m/qwen3-coder-next-q4_k_m-00002-of-00002.gguf'])).toBeNull();
    expect(findCoderGguf({ homedir: home, env: {}, readdir: () => [] })).toBeNull();
  });
});
