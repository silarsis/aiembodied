/**
 * Finds the Qwen3-Coder-Next GGUF (Q4_K_M) on this PC when the user has not picked one: in the
 * Hugging Face cache, in llama.cpp's download folder, and in the app's own model folder.
 * A split model is found by its first part (`...-00001-of-0000N.gguf`), which is what
 * llama-server wants.
 */
import { readdirSync, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GgufSearchOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  /** Lists a folder; replaced in tests. */
  readdir?: (dir: string) => Dirent[];
}

const MODEL = 'qwen3-coder-next';
const QUANT = 'q4_k_m';
const MAX_DEPTH = 6;

/** Home folder as the app sees the real one (pnpm dev:run moves the profile folders). */
function homeOf(options: GgufSearchOptions): string {
  const env = options.env ?? process.env;
  return options.homedir ?? (env.AIEMBODIED_HOST_USERPROFILE?.trim() || os.homedir());
}

function defaultReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every file below `dir` (to a depth limit). Symbolic links count as files: the Hugging Face cache is full of them. */
function walk(dir: string, readdir: (dir: string) => Dirent[], depth = 0, found: string[] = []): string[] {
  if (depth > MAX_DEPTH) return found;
  for (const entry of readdir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, readdir, depth + 1, found);
    else found.push(full);
  }
  return found;
}

const isFirstPart = (name: string) => /-0*1-of-\d+\.gguf$/i.test(name);
const isLaterPart = (name: string) => /-\d+-of-\d+\.gguf$/i.test(name) && !isFirstPart(name);

/** The best match among files: a first part of a split Q4_K_M model, else a single Q4_K_M file. */
export function pickCoderGguf(files: string[]): string | null {
  const matches = files.filter((file) => {
    const lower = file.toLowerCase();
    return lower.endsWith('.gguf') && lower.includes(MODEL) && lower.includes(QUANT);
  });
  const sorted = [...matches].sort();
  return sorted.find((file) => isFirstPart(path.basename(file))) ?? sorted.find((file) => !isLaterPart(path.basename(file))) ?? null;
}

/** The first match from the three places, or null. */
export function findCoderGguf(options: GgufSearchOptions = {}): string | null {
  const env = options.env ?? process.env;
  const readdir = options.readdir ?? defaultReaddir;
  const home = homeOf(options);
  const localAppData = env.AIEMBODIED_HOST_LOCALAPPDATA?.trim() || env.LOCALAPPDATA?.trim();
  const modelsDirectory = env.LOCAL_LLM_MODELS_DIR?.trim() || path.join(home, '.cache', 'aiembodied', 'llm-models');
  const places: Array<{ dir: string; recursive: boolean }> = [
    { dir: path.join(home, '.cache', 'huggingface', 'hub', 'models--Qwen--Qwen3-Coder-Next-GGUF'), recursive: true },
    ...(localAppData ? [{ dir: path.join(localAppData, 'llama.cpp'), recursive: false }] : []),
    { dir: modelsDirectory, recursive: true },
  ];
  for (const { dir, recursive } of places) {
    const files = recursive ? walk(dir, readdir) : readdir(dir).filter((entry) => !entry.isDirectory()).map((entry) => path.join(dir, entry.name));
    const picked = pickCoderGguf(files);
    if (picked) return picked;
  }
  return null;
}
