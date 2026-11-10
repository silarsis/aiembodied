/**
 * The thinking models downloaded from Hugging Face for this PC's llama-server, and which one it
 * runs. Kept in <userData>/local-llm.json, which pnpm dev:run (scripts/local-services.mjs) also
 * reads so it starts llama-server with the picked model.
 *
 * Downloads go to LOCAL_LLM_MODELS_DIR, default <home>/.cache/aiembodied/llm-models/<owner>/<repo>/.
 * Each file is fetched to a .part file (resumed when a download is tried again), checked against
 * Hugging Face's SHA-256, then renamed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { aliasFor, resolveUrl, type HfFile, type HfQuant } from './huggingface.js';

export interface LocalLlmModel {
  /** <repo>:<quant id>. */
  id: string;
  repo: string;
  quant: string;
  /** The name llama-server serves it as, and the model the Thinking route asks for. */
  alias: string;
  /** The first GGUF file; llama-server finds the other split parts beside it. */
  path: string;
  files: string[];
  sizeBytes: number;
  contextLength?: number;
  downloadedAt: number;
}

export interface LocalLlmLibraryFile {
  /** The model llama-server runs. None: the start script's own default (Qwen Flash-Next). */
  selected?: string;
  models: LocalLlmModel[];
}

/** What the page lists: the downloaded models, the one in use, and where they are kept. */
export interface LocalLlmList extends LocalLlmLibraryFile {
  folder: string;
}

export type LlmDownloadState = 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface LlmDownload {
  id: string;
  repo: string;
  quant: string;
  label: string;
  state: LlmDownloadState;
  received: number;
  total: number;
  /** Switch Thinking to it once it is downloaded. */
  use: boolean;
  error?: string;
  /** What happened when it was put to use (llama-server restarted, or what to do by hand). */
  result?: string;
  startedAt: number;
}

export interface LlmLibraryOptions {
  /** local-llm.json. */
  file: string;
  /** Where downloads go. */
  modelsDirectory: string;
  fetchFn?: typeof fetch;
  /** Free bytes on the drive holding `directory` (null when it can't be told). */
  freeSpace?: (directory: string) => Promise<number | null>;
  /** Folder name for a repo's files under modelsDirectory. Default: <owner>/<repo>. */
  folderName?: (repo: string) => string;
  /** Called instead of recording the model in `file` once a download is verified (for libraries kept elsewhere). */
  persist?: (model: LocalLlmModel) => Promise<void>;
  /** Called after a download that should be put to use; returns what happened, for the page. */
  onDownloaded?: (model: LocalLlmModel) => Promise<string | undefined>;
  logger?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
}

const ACTIVE: LlmDownloadState[] = ['queued', 'downloading', 'verifying'];
/** Room left over after a download, so the drive isn't filled to the brim. */
const SPARE_BYTES = 2 * 1024 ** 3;

async function defaultFreeSpace(directory: string): Promise<number | null> {
  try {
    let probe = directory;
    while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const stats = await fs.statfs(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export class LlmLibrary {
  private readonly downloads = new Map<string, LlmDownload>();
  private readonly cancels = new Map<string, () => void>();

  constructor(private readonly options: LlmLibraryOptions) {}

  get modelsDirectory(): string {
    return this.options.modelsDirectory;
  }

  async read(): Promise<LocalLlmLibraryFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.file, 'utf8')) as Partial<LocalLlmLibraryFile>;
      const models = Array.isArray(parsed.models)
        ? parsed.models.filter((entry): entry is LocalLlmModel => typeof entry?.id === 'string' && typeof entry.path === 'string' && typeof entry.alias === 'string')
        : [];
      const selected = typeof parsed.selected === 'string' && models.some((entry) => entry.id === parsed.selected) ? parsed.selected : undefined;
      return { models, ...(selected ? { selected } : {}) };
    } catch {
      return { models: [] };
    }
  }

  private async write(library: LocalLlmLibraryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.options.file), { recursive: true });
    const temp = `${this.options.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(library, null, 2), 'utf8');
    await fs.rename(temp, this.options.file);
  }

  /** The model llama-server should run, if one was picked and its file is still there. */
  async selected(): Promise<LocalLlmModel | null> {
    const library = await this.read();
    const model = library.models.find((entry) => entry.id === library.selected);
    return model && existsSync(model.path) ? model : null;
  }

  /** Pick a downloaded model (or, with null, go back to the start script's default). */
  async select(id: string | null): Promise<LocalLlmModel | null> {
    const library = await this.read();
    const model = id ? library.models.find((entry) => entry.id === id) : undefined;
    if (id && !model) throw new Error('That model is no longer downloaded.');
    if (model && !existsSync(model.path)) throw new Error(`${model.path} is missing. Download it again.`);
    await this.write({ models: library.models, ...(model ? { selected: model.id } : {}) });
    return model ?? null;
  }

  /** Delete a downloaded model's files. The one in use can't be deleted. */
  async remove(id: string): Promise<void> {
    const library = await this.read();
    const model = library.models.find((entry) => entry.id === id);
    if (!model) return;
    if (library.selected === id) throw new Error('That model is in use. Pick another one first.');
    const root = path.resolve(this.options.modelsDirectory);
    for (const file of model.files) {
      const full = path.resolve(file);
      // Only ever delete inside the downloads folder.
      if (full.startsWith(root + path.sep)) await fs.rm(full, { force: true });
    }
    await this.write({ ...library, models: library.models.filter((entry) => entry.id !== id) });
    this.options.logger?.info('Deleted a downloaded language model.', { id });
  }

  list(): LlmDownload[] {
    return [...this.downloads.values()].sort((a, b) => b.startedAt - a.startedAt).map((entry) => ({ ...entry }));
  }

  cancel(id: string): void {
    this.cancels.get(id)?.();
  }

  /** Where a repo's files go. */
  folderFor(repo: string): string {
    return path.join(this.options.modelsDirectory, ...(this.options.folderName ? [this.options.folderName(repo)] : repo.split('/')));
  }

  /** Start downloading one size of a repo. It carries on in the background; poll list(). */
  async start(
    repo: string,
    quant: HfQuant,
    { token, use, contextLength }: { token?: string; use: boolean; contextLength?: number },
  ): Promise<LlmDownload> {
    const id = `${repo}:${quant.id}`;
    if ([...this.downloads.values()].some((entry) => `${entry.repo}:${entry.quant}` === id && ACTIVE.includes(entry.state))) {
      throw new Error(`${repo} ${quant.label} is already downloading.`);
    }
    const folder = this.folderFor(repo);
    const have = await Promise.all(
      quant.files.map(async (file) => (await fs.stat(path.join(folder, file.path)).catch(() => null))?.size === file.size && file.size > 0),
    );
    const partial = await Promise.all(quant.files.map(async (file) => (await fs.stat(path.join(folder, `${file.path}.part`)).catch(() => null))?.size ?? 0));
    const needed = quant.files.reduce((sum, file, index) => sum + (have[index] ? 0 : file.size - partial[index]), 0);
    const free = await (this.options.freeSpace ?? defaultFreeSpace)(folder);
    if (free !== null && needed + SPARE_BYTES > free) {
      throw new Error(`Not enough disk space: ${quant.label} needs ${gb(needed)} more and ${folder} has ${gb(free)} free. Pick a smaller size or set LOCAL_LLM_MODELS_DIR to another drive.`);
    }
    const download: LlmDownload = {
      id: randomUUID(),
      repo,
      quant: quant.id,
      label: quant.label,
      state: 'queued',
      received: 0,
      total: quant.sizeBytes,
      use,
      startedAt: Date.now(),
    };
    this.downloads.set(download.id, download);
    const abort = new AbortController();
    this.cancels.set(download.id, () => {
      download.state = 'cancelled';
      abort.abort();
    });
    void this.run(download, folder, quant, token, abort.signal)
      .then(async () => {
        if (download.state === 'cancelled') return;
        const model: LocalLlmModel = {
          id,
          repo,
          quant: quant.id,
          alias: aliasFor(repo, quant.label),
          path: path.join(folder, quant.files[0].path),
          files: quant.files.map((file) => path.join(folder, file.path)),
          sizeBytes: quant.sizeBytes,
          ...(contextLength ? { contextLength } : {}),
          downloadedAt: Date.now(),
        };
        if (this.options.persist) {
          await this.options.persist(model);
        } else {
          const library = await this.read();
          await this.write({ ...library, models: [...library.models.filter((entry) => entry.id !== id), model] });
        }
        download.state = 'done';
        if (use && this.options.onDownloaded) {
          download.result = await this.options.onDownloaded(model).catch(
            (error: unknown) => `Downloaded, but it couldn't be switched on: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .catch((error: unknown) => {
        if (download.state === 'cancelled') return;
        download.state = 'failed';
        download.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.cancels.delete(download.id);
        this.options.logger?.info('Language model download finished.', { repo, quant: quant.id, state: download.state, error: download.error });
      });
    return { ...download };
  }

  private async run(download: LlmDownload, folder: string, quant: HfQuant, token: string | undefined, signal: AbortSignal): Promise<void> {
    let done = 0;
    for (const file of quant.files) {
      const target = path.join(folder, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const existing = await fs.stat(target).catch(() => null);
      if (!(existing && existing.size === file.size && file.size > 0)) {
        await this.fetchFile(download, done, target, file, token, signal);
        if (signal.aborted) return;
      }
      done += file.size;
      download.received = done;
    }
  }

  /** One file: resume its .part file if there is one, check it, then move it into place. */
  private async fetchFile(download: LlmDownload, done: number, target: string, file: HfFile, token: string | undefined, signal: AbortSignal): Promise<void> {
    const part = `${target}.part`;
    let offset = (await fs.stat(part).catch(() => null))?.size ?? 0;
    if (file.size && offset > file.size) {
      await fs.rm(part, { force: true });
      offset = 0;
    }
    const hash = createHash('sha256');
    if (offset > 0 && file.sha256) {
      // Resuming: the bytes already on disk count towards the checksum.
      download.state = 'verifying';
      for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    }
    download.state = 'downloading';
    download.received = done + offset;
    if (!file.size || offset < file.size) {
      let response: Response;
      try {
        response = await (this.options.fetchFn ?? fetch)(resolveUrl(download.repo, file.path), {
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(offset ? { Range: `bytes=${offset}-` } : {}) },
          signal,
        });
      } catch (error) {
        if (signal.aborted) return;
        throw new Error(`Could not reach Hugging Face: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Hugging Face refused the download (${response.status}). Gated models need their licence accepted on huggingface.co and a token under Servers → Hugging Face.`,
        );
      }
      if (!response.ok || !response.body) throw new Error(`Hugging Face answered ${response.status} for ${file.path}.`);
      if (offset && response.status !== 206) {
        // The server ignored the range: start this file again.
        await response.body.cancel().catch(() => undefined);
        await fs.rm(part, { force: true });
        return this.fetchFile(download, done, target, file, token, signal);
      }
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          download.received += chunk.length;
          if (file.sha256) hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(part, { flags: offset ? 'a' : 'w' }), { signal });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    }
    if (file.sha256) {
      download.state = 'verifying';
      if (hash.digest('hex') !== file.sha256) {
        await fs.rm(part, { force: true });
        throw new Error(`${file.path} came down damaged (checksum mismatch). Try again.`);
      }
    }
    await fs.rename(part, target);
  }
}
