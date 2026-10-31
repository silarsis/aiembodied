import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundService } from '../src/backgrounds/background-service.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'background-service-'));
  directories.push(directory);
  const values = new Map<string, string>();
  const store = {
    getValue: (key: string) => values.get(key) ?? null,
    setValue: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const png = PNG.sync.write(new PNG({ width: 64, height: 36 }));
  const comfy = {
    isAvailable: vi.fn().mockResolvedValue(true),
    run: vi.fn().mockResolvedValue(png),
  };
  const options = {
    store,
    comfy,
    backgroundsDirectory: directory,
    assetsDirectory: path.resolve('assets/backgrounds'),
  };
  return { service: new BackgroundService(options), options, values, comfy, directory };
}

describe('background library', () => {
  it('waits for the shared ComfyUI startup before generating', async () => {
    const { options, comfy } = await setup();
    comfy.isAvailable.mockResolvedValue(false);
    const ensureComfyReady = vi.fn(async () => {
      comfy.isAvailable.mockResolvedValue(true);
    });
    await new BackgroundService({ ...options, ensureComfyReady }).generate('A sunny courtyard');
    expect(ensureComfyReady).toHaveBeenCalledOnce();
    expect(comfy.run).toHaveBeenCalledOnce();
  });
  it('ships five readable scenes and remembers selection across service restarts', async () => {
    const { service, options } = await setup();
    const scenes = await service.list();
    expect(scenes.map((scene) => scene.name)).toEqual([
      'Garden terrace',
      'Reading lounge',
      'Beach promenade',
      'Rainy city arcade',
      'Mountain cabin deck',
    ]);
    for (const scene of scenes) {
      expect(scene.builtIn).toBe(true);
      expect(scene.thumbnailDataUrl).toMatch(/^data:image\/webp;base64,/);
      expect(await service.load(scene.id)).toMatch(/^data:image\/webp;base64,/);
      await expect(service.delete(scene.id)).rejects.toThrow('cannot be deleted');
    }
    service.setActive('builtin:beach');
    expect(new BackgroundService(options).getActive()).toBe('builtin:beach');
    service.setActive(null);
    expect(new BackgroundService(options).getActive()).toBeNull();
    expect(() => service.setActive('../../secret')).toThrow('not available');
    await expect(service.load('../../secret')).rejects.toThrow('not available');
  });

  it('generates a ground-aware landscape, persists it, and leaves the active scene unchanged', async () => {
    const { service, options, comfy, directory } = await setup();
    service.setActive('builtin:city');
    const result = await service.generate('A peaceful forest clearing');
    const graph = comfy.run.mock.calls[0][0];
    expect(graph.latent.inputs).toMatchObject({ width: 1536, height: 864 });
    expect(graph.encode.inputs.prompt).toContain('feet 86 percent');
    expect(graph.encode.inputs.negative_prompt).not.toContain('background scenery');
    expect(result.builtIn).toBe(false);
    expect(service.getActive()).toBe('builtin:city');
    const restarted = new BackgroundService(options);
    expect((await restarted.list()).map((item) => item.id)).toContain(result.id);
    expect(await restarted.load(result.id)).toMatch(/^data:image\/png;base64,/);
    const thumbnail = PNG.sync.read(await readFile(path.join(directory, `${result.id}-thumb.png`)));
    expect([thumbnail.width, thumbnail.height]).toEqual([320, 180]);
    restarted.setActive(result.id);
    await restarted.delete(result.id);
    expect(restarted.getActive()).toBe('builtin:garden');
    expect(await restarted.list()).toHaveLength(5);
  });

  it('reports offline failures and unlocks generation for a retry', async () => {
    const { service, comfy } = await setup();
    comfy.isAvailable.mockResolvedValueOnce(false);
    await expect(service.generate('A room')).rejects.toThrow('Start ComfyUI');
    expect(comfy.run).not.toHaveBeenCalled();
    await expect(service.generate('A room')).resolves.toMatchObject({ name: 'A room' });
    await expect(service.generate('')).rejects.toThrow('1–1000');
    await expect(service.generate('a'.repeat(1001))).rejects.toThrow('1–1000');
  });

  it('prevents overlapping generation and does not save failed images', async () => {
    const { service, comfy } = await setup();
    let reject!: (error: Error) => void;
    comfy.run.mockImplementationOnce(
      () =>
        new Promise((_, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const pending = service.generate('A rainy garden');
    await vi.waitFor(() => expect(comfy.run).toHaveBeenCalled());
    await expect(service.generate('Another garden')).rejects.toThrow('already being generated');
    reject(new Error('Generation failed'));
    await expect(pending).rejects.toThrow('Generation failed');
    expect(await service.list()).toHaveLength(5);
  });
});
