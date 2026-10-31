import { randomInt, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { MemoryStore } from '../memory/memory-store.js';
import type { ComfyUIClient } from '../avatar/generation/comfyui-client.js';
import { backgroundGraph, buildBackgroundPrompt } from '../avatar/generation/graphs.js';
import { BACKGROUND_GROUND_Y, DEFAULT_BACKGROUNDS } from './defaults.js';
import type { BackgroundSummary } from './types.js';

const LIBRARY_KEY = 'stage.backgrounds';
const ACTIVE_KEY = 'stage.activeBackground';
interface SavedBackground {
  id: string;
  name: string;
  prompt: string;
}
interface Options {
  store: Pick<MemoryStore, 'getValue' | 'setValue'>;
  assetsDirectory: string;
  backgroundsDirectory: string;
  comfy: Pick<ComfyUIClient, 'isAvailable' | 'run'>;
  ensureComfyReady?: () => Promise<void>;
}

/** Main-process ownership keeps file paths and generation off the renderer bridge. */
export class BackgroundService {
  private generating = false;
  constructor(private readonly options: Options) {}

  private saved(): SavedBackground[] {
    const raw = this.options.store.getValue(LIBRARY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.some((item: unknown) => {
        if (!item || typeof item !== 'object') return true;
        const record = item as Record<string, unknown>;
        return (
          typeof record.id !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(record.id) ||
          typeof record.name !== 'string' ||
          typeof record.prompt !== 'string'
        );
      })
    ) {
      throw new Error('The saved background library could not be read.');
    }
    return parsed as SavedBackground[];
  }

  async list(): Promise<BackgroundSummary[]> {
    const builtIn = await Promise.all(
      DEFAULT_BACKGROUNDS.map(async (entry) => ({
        id: entry.id,
        name: entry.name,
        builtIn: true,
        groundY: BACKGROUND_GROUND_Y,
        thumbnailDataUrl: await this.imageData(
          path.join(this.options.assetsDirectory, `${entry.asset}-thumb.webp`),
          'image/webp',
        ),
      })),
    );
    const saved = await Promise.all(this.saved().map((entry) => this.summary(entry)));
    return [...builtIn, ...saved];
  }

  getActive(): string | null {
    const saved = this.options.store.getValue(ACTIVE_KEY);
    if (saved === 'none') return null;
    if (saved && this.exists(saved)) return saved;
    return DEFAULT_BACKGROUNDS[0].id;
  }

  setActive(id: string | null): void {
    if (id !== null && !this.exists(id)) throw new Error('This background is not available.');
    this.options.store.setValue(ACTIVE_KEY, id ?? 'none');
  }

  async load(id: string): Promise<string> {
    const builtIn = DEFAULT_BACKGROUNDS.find((entry) => entry.id === id);
    if (builtIn)
      return this.imageData(
        path.join(this.options.assetsDirectory, `${builtIn.asset}.webp`),
        'image/webp',
      );
    if (!this.saved().some((entry) => entry.id === id))
      throw new Error('This background is not available.');
    return this.imageData(path.join(this.options.backgroundsDirectory, `${id}.png`), 'image/png');
  }

  async generate(description: string): Promise<BackgroundSummary> {
    if (
      typeof description !== 'string' ||
      !description.trim() ||
      description.trim().length > 1000
    ) {
      throw new Error('Describe a background in 1–1000 characters.');
    }
    if (this.generating) throw new Error('A background is already being generated.');
    this.generating = true;
    let id: string | undefined;
    try {
      await this.options.ensureComfyReady?.();
      if (!(await this.options.comfy.isAvailable()))
        throw new Error('Start ComfyUI to generate a background, then try again.');
      const prompt = description.trim();
      const bytes = await this.options.comfy.run(
        backgroundGraph(buildBackgroundPrompt(prompt), randomInt(0, 2 ** 47)),
      );
      if (
        bytes.length > 25 * 1024 * 1024 ||
        bytes.length < 24 ||
        bytes.readUInt32BE(16) > 4096 ||
        bytes.readUInt32BE(20) > 4096
      ) {
        throw new Error('The generated background is too large or invalid.');
      }
      const decoded = PNG.sync.read(bytes);
      const thumbnail = new PNG({ width: 320, height: 180 });
      for (let y = 0; y < 180; y++)
        for (let x = 0; x < 320; x++) {
          const source =
            (Math.floor((y * decoded.height) / 180) * decoded.width +
              Math.floor((x * decoded.width) / 320)) *
            4;
          decoded.data.copy(thumbnail.data, (y * 320 + x) * 4, source, source + 4);
        }
      id = randomUUID();
      const record = { id, name: prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt, prompt };
      await mkdir(this.options.backgroundsDirectory, { recursive: true });
      await writeFile(path.join(this.options.backgroundsDirectory, `${id}.png`), bytes);
      await writeFile(
        path.join(this.options.backgroundsDirectory, `${id}-thumb.png`),
        PNG.sync.write(thumbnail),
      );
      const summary = await this.summary(record);
      this.options.store.setValue(LIBRARY_KEY, JSON.stringify([...this.saved(), record]));
      return summary;
    } catch (error) {
      if (id) await this.removeFiles(id);
      throw error;
    } finally {
      this.generating = false;
    }
  }

  async delete(id: string): Promise<void> {
    if (DEFAULT_BACKGROUNDS.some((entry) => entry.id === id))
      throw new Error('Included backgrounds cannot be deleted.');
    const saved = this.saved();
    if (!saved.some((entry) => entry.id === id))
      throw new Error('This background is not available.');
    if (this.getActive() === id) this.setActive(DEFAULT_BACKGROUNDS[0].id);
    this.options.store.setValue(
      LIBRARY_KEY,
      JSON.stringify(saved.filter((entry) => entry.id !== id)),
    );
    await this.removeFiles(id);
  }

  private exists(id: string): boolean {
    return (
      DEFAULT_BACKGROUNDS.some((entry) => entry.id === id) ||
      this.saved().some((entry) => entry.id === id)
    );
  }
  private async summary(entry: SavedBackground): Promise<BackgroundSummary> {
    return {
      id: entry.id,
      name: entry.name,
      builtIn: false,
      groundY: BACKGROUND_GROUND_Y,
      thumbnailDataUrl: await this.imageData(
        path.join(this.options.backgroundsDirectory, `${entry.id}-thumb.png`),
        'image/png',
      ),
    };
  }
  private async imageData(file: string, mime: string): Promise<string> {
    return `data:${mime};base64,${(await readFile(file)).toString('base64')}`;
  }
  private async removeFiles(id: string): Promise<void> {
    await Promise.all(
      [`${id}.png`, `${id}-thumb.png`].map((file) =>
        rm(path.join(this.options.backgroundsDirectory, file), { force: true }),
      ),
    );
  }
}
