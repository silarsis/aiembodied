/**
 * The local vision model behind "Describe the avatar" (and Check poses): a small Qwen3-VL GGUF plus
 * its vision projector (mmproj), downloaded from Hugging Face and run by llama-server on demand
 * (see vision-server.ts). The pick is kept in <userData>/local-vision.json.
 *
 * Files go to <LOCAL_LLM_MODELS_DIR or ~/.cache/aiembodied/llm-models>/vision/<owner>--<repo>/ with the
 * same resumable, SHA-256 checked downloader Thinking models use.
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  lookupHuggingFace,
  parseHuggingFaceRef,
  pickDefaultQuant,
  type HfFile,
  type HfLookup,
  type HfQuant,
} from '../local-llm/huggingface.js';
import { LlmLibrary, type LlmDownload } from '../local-llm/llm-library.js';

/** Tried in order when no repo is named. */
export const DEFAULT_VISION_REPOS = ['ggml-org/Qwen3-VL-8B-Instruct-GGUF', 'unsloth/Qwen3-VL-8B-Instruct-GGUF'] as const;
export const VISION_ALIAS = 'qwen3-vl';
/** Shown on the download button. */
export const VISION_SIZE_HINT = '~6 GB';

/** What local-vision.json keeps. model and mmproj are absolute paths. */
export interface VisionPick {
  repo: string;
  model: string;
  mmproj: string;
  alias: string;
}

/** What the Describe the avatar row shows. */
export interface VisionStatus {
  pick: VisionPick | null;
  /** Both files are on disk. */
  ready: boolean;
  sizeBytes: number;
  /** The newest download that is running or failed, if any. */
  download: LlmDownload | null;
  folder: string;
}

export async function readVisionPick(file: string): Promise<VisionPick | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<VisionPick>;
    if (typeof parsed.repo === 'string' && typeof parsed.model === 'string' && typeof parsed.mmproj === 'string') {
      return { repo: parsed.repo, model: parsed.model, mmproj: parsed.mmproj, alias: typeof parsed.alias === 'string' && parsed.alias ? parsed.alias : VISION_ALIAS };
    }
  } catch {
    // Missing or unreadable: nothing downloaded yet.
  }
  return null;
}

export async function writeVisionPick(file: string, pick: VisionPick): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(pick, null, 2), 'utf8');
  await fs.rename(temp, file);
}

/** The vision projector to use: F16 first, then BF16, then Q8_0, then the smallest. */
export function pickMmproj(files: HfFile[]): HfFile | null {
  if (!files.length) return null;
  const rank = (file: HfFile) => {
    const name = file.path.split('/').at(-1) ?? file.path;
    if (/(^|[-_.])f16(?=[-_.]|$)/i.test(name)) return 0;
    if (/bf16/i.test(name)) return 1;
    if (/q8_0/i.test(name)) return 2;
    return 3;
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || a.size - b.size || a.path.localeCompare(b.path))[0];
}

export interface VisionFiles {
  repo: string;
  quant: HfQuant;
  mmproj: HfFile;
}

/** Choose the model GGUF (Q4_K_M unless the reference names another size) and the mmproj from a repo lookup. */
export function chooseVisionFiles(lookup: HfLookup, ref: { quant?: string; file?: string } = {}): VisionFiles {
  if (!lookup.repo || !lookup.quants.length) {
    throw new Error(lookup.note ?? 'That repo has no GGUF files, which is what llama-server runs.');
  }
  const mmproj = pickMmproj(lookup.mmproj ?? []);
  if (!mmproj) {
    throw new Error(`${lookup.repo} has no mmproj file, so it can't read images. Pick a vision GGUF repo such as ${DEFAULT_VISION_REPOS[0]}.`);
  }
  const id = pickDefaultQuant(lookup.quants, ref.quant, ref.file);
  const quant = lookup.quants.find((entry) => entry.id === id) ?? lookup.quants[0];
  return { repo: lookup.repo, quant, mmproj };
}

function slug(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, '--');
}

export interface VisionModelOptions {
  /** <userData>/local-vision.json. */
  file: string;
  /** The same folder Thinking models use; vision files go in its vision/ subfolder. */
  modelsDirectory: string;
  token: () => string | undefined;
  fetchFn?: typeof fetch;
  freeSpace?: (directory: string) => Promise<number | null>;
  logger?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
}

export class VisionModel {
  private readonly library: LlmLibrary;

  constructor(private readonly options: VisionModelOptions) {
    this.library = new LlmLibrary({
      file: path.join(path.dirname(options.file), 'local-vision-downloads.json'),
      modelsDirectory: path.join(options.modelsDirectory, 'vision'),
      folderName: slug,
      fetchFn: options.fetchFn,
      freeSpace: options.freeSpace,
      logger: options.logger,
      persist: async (model) => {
        const [modelPath, mmprojPath] = model.files;
        await writeVisionPick(options.file, { repo: model.repo, model: modelPath, mmproj: mmprojPath, alias: VISION_ALIAS });
      },
    });
  }

  /** The saved pick, if both its files are still on disk. */
  async pick(): Promise<VisionPick | null> {
    const pick = await readVisionPick(this.options.file);
    return pick && existsSync(pick.model) && existsSync(pick.mmproj) ? pick : null;
  }

  async status(): Promise<VisionStatus> {
    const saved = await readVisionPick(this.options.file);
    const ready = Boolean(saved && existsSync(saved.model) && existsSync(saved.mmproj));
    let sizeBytes = 0;
    if (saved && ready) {
      for (const file of [saved.model, saved.mmproj]) sizeBytes += (await fs.stat(file).catch(() => null))?.size ?? 0;
    }
    const download = this.library.list().find((entry) => entry.state !== 'done' && entry.state !== 'cancelled') ?? null;
    return { pick: saved, ready, sizeBytes, download, folder: path.join(this.options.modelsDirectory, 'vision') };
  }

  cancel(): void {
    for (const entry of this.library.list()) this.library.cancel(entry.id);
  }

  /**
   * Download the vision model: the default repos in turn, or the one `ref` names (a link, owner/repo or
   * owner/repo:QUANT). Returns once the download has started; poll status().
   */
  async download(ref?: string): Promise<void> {
    const token = this.options.token();
    const attempts: Array<{ repo: string; quant?: string; file?: string }> = [];
    if (ref?.trim()) {
      const parsed = parseHuggingFaceRef(ref);
      if (!parsed || 'search' in parsed) {
        throw new Error('Paste a Hugging Face link or repo name of a vision model (such as ggml-org/Qwen3-VL-8B-Instruct-GGUF).');
      }
      attempts.push(parsed);
    } else {
      for (const repo of DEFAULT_VISION_REPOS) attempts.push({ repo });
    }
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const lookup = await lookupHuggingFace(attempt, token, this.options.fetchFn);
        const chosen = chooseVisionFiles(lookup, attempt);
        const files = [chosen.quant.files[0], chosen.mmproj];
        if (chosen.quant.files.length > 1) throw new Error(`${chosen.repo}'s ${chosen.quant.label} comes in several parts; pick a smaller size such as Q4_K_M.`);
        const combined: HfQuant = {
          id: `vision:${chosen.quant.id}`,
          label: `${chosen.quant.label} + mmproj`,
          files,
          sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
        };
        await this.library.start(chosen.repo, combined, { token, use: false });
        return;
      } catch (error) {
        lastError = error;
        this.options.logger?.warn('Vision model lookup failed.', { repo: attempt.repo, message: error instanceof Error ? error.message : String(error) });
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Could not find the vision model on Hugging Face.');
  }
}
