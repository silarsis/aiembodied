import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarGenerationService } from '../src/avatar/generation/avatar-generation-service.js';
import type { ComfyUIClient } from '../src/avatar/generation/comfyui-client.js';
import type { RetextureRunner } from '../src/avatar/generation/retexture-tasks.js';

function fakeComfy(overrides: Partial<Record<keyof ComfyUIClient, unknown>> = {}) {
  return {
    baseUrl: 'http://comfy.test',
    isAvailable: vi.fn().mockResolvedValue(true),
    uploadImage: vi.fn(async (name: string) => `aiembodied/${name}`),
    run: vi.fn().mockResolvedValue(Buffer.from('png-bytes')),
    interrupt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ComfyUIClient & Record<string, ReturnType<typeof vi.fn>>;
}

const runner: RetextureRunner = {
  prepare: vi.fn(async () => [
    {
      name: 'outfit',
      prompt: 'Recolour the outfit: "{description}"',
      box: { x: 0, y: 0, width: 64, height: 32 },
      png: Buffer.from('a'),
    },
    {
      name: 'hair',
      prompt: 'Recolour the hair: "{description}"',
      box: { x: 64, y: 0, width: 64, height: 64 },
      png: Buffer.from('b'),
    },
  ]),
  assemble: vi.fn(async () => Buffer.from('vrm-bytes')),
  score: vi.fn(async () => 0.9),
};

async function waitFor(service: AvatarGenerationService, jobId: string, status: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      service.getStatus(jobId).status === 'awaiting_confirmation' &&
      status !== 'awaiting_confirmation'
    ) {
      await service.confirmConcept(jobId);
    }
    if (service.getStatus(jobId).status === status) {
      return service.getStatus(jobId);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job never reached ${status}: ${JSON.stringify(service.getStatus(jobId))}`);
}

describe('AvatarGenerationService', () => {
  let workDirectory: string;
  let baseModelPath: string;
  const models = {
    uploadModel: vi.fn().mockResolvedValue({ model: { id: 'vrm-new' } }),
    setActiveModel: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    workDirectory = await mkdtemp(path.join(os.tmpdir(), 'avatar-gen-'));
    baseModelPath = path.join(workDirectory, 'base.vrm');
    writeFileSync(baseModelPath, 'base-vrm');
  });

  afterEach(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const create = (comfy = fakeComfy()) => ({
    comfy,
    service: new AvatarGenerationService({
      comfy,
      models,
      baseModelPath,
      workDirectory: path.join(workDirectory, 'jobs'),
      runner,
    }),
  });

  it('waits for shared startup and admits only one simultaneous avatar request', async () => {
    const comfy = fakeComfy({ run: vi.fn().mockReturnValue(new Promise(() => {})) });
    const ensureComfyReady = vi.fn().mockResolvedValue(undefined);
    const service = new AvatarGenerationService({
      comfy,
      ensureComfyReady,
      models,
      baseModelPath,
      workDirectory: path.join(workDirectory, 'jobs'),
      runner,
    });
    const results = await Promise.allSettled([
      service.startJob({ mode: 'restyle', prompt: 'A robot' }),
      service.startJob({ mode: 'restyle', prompt: 'Another robot' }),
    ]);
    expect(ensureComfyReady).toHaveBeenCalled();
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await vi.waitFor(() => expect(comfy.run).toHaveBeenCalled());
  });

  it('generates a concept, repaints each region, and builds a VRM', async () => {
    const { comfy, service } = create();
    const { jobId } = await service.startJob({
      mode: 'restyle',
      prompt: 'A cheerful pirate with red hair',
    });

    const status = await waitFor(service, jobId, 'completed');
    expect(status.progress).toBe(1);
    const candidate = await service.loadPreview(jobId);
    expect(candidate).toEqual(Buffer.from('vrm-bytes'));
    expect(models.uploadModel).not.toHaveBeenCalled();
    expect(models.setActiveModel).not.toHaveBeenCalled();
    expect(status.previewDataUrl).toBe(
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
    );

    // concept + one run per region
    expect(comfy.run).toHaveBeenCalledTimes(3);
    const conceptGraph = comfy.run.mock.calls[0][0] as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    expect(conceptGraph.encode.inputs.prompt).toContain('A cheerful pirate with red hair.');
    const hairGraph = comfy.run.mock.calls[2][0] as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    expect(hairGraph.cropImage.inputs.image).toBe(`aiembodied/${jobId}-hair.png`);
    expect(hairGraph.encode.inputs.prompt).toBe(
      'Recolour the hair: "A cheerful pirate with red hair"',
    );
    // the concept is only a preview; the texture edit sees just the crop
    expect(hairGraph.encode.inputs).not.toHaveProperty(['images.image_2']);
    expect(hairGraph.resize.inputs).toMatchObject({ width: 64, height: 64 });
    expect(runner.score).toHaveBeenCalledWith(Buffer.from('b'), Buffer.from('png-bytes'));

    expect(runner.assemble).toHaveBeenCalledWith(
      Buffer.from('base-vrm'),
      [
        { box: { x: 0, y: 0, width: 64, height: 32 }, png: Buffer.from('png-bytes') },
        { box: { x: 64, y: 0, width: 64, height: 64 }, png: Buffer.from('png-bytes') },
      ],
      'A cheerful pirate with red hair',
    );
  });

  it('retries a region whose repaint lost the layout, then keeps the original if it never recovers', async () => {
    const run = vi.fn(async () => Buffer.from(`png-${run.mock.calls.length}`));
    const { comfy, service } = create(fakeComfy({ run }));
    // outfit: bad then good; hair: bad twice
    vi.mocked(runner.score)
      .mockResolvedValueOnce(0.2)
      .mockResolvedValueOnce(0.85)
      .mockResolvedValueOnce(0.1)
      .mockResolvedValueOnce(0.3);
    const { jobId } = await service.startJob({ mode: 'restyle', prompt: 'A robot' });
    await waitFor(service, jobId, 'completed');

    // concept + 2 outfit attempts + 2 hair attempts
    expect(comfy.run).toHaveBeenCalledTimes(5);
    const seeds = run.mock.calls
      .slice(1, 3)
      .map((call) => (call[0] as { sample: { inputs: { seed: number } } }).sample.inputs.seed);
    expect(seeds[1]).toBe(seeds[0] + 1);
    expect(runner.assemble).toHaveBeenCalledWith(
      Buffer.from('base-vrm'),
      [{ box: { x: 0, y: 0, width: 64, height: 32 }, png: Buffer.from('png-3') }],
      'A robot',
    );
  });

  it('fails when no region repaints cleanly', async () => {
    const { service } = create();
    vi.mocked(runner.score).mockResolvedValue(0.1);
    const { jobId } = await service.startJob({ mode: 'restyle', prompt: 'A robot' });
    const status = await waitFor(service, jobId, 'failed');
    expect(status.errorMessage).toMatch(/didn't keep the model's layout/);
    vi.mocked(runner.score).mockResolvedValue(0.9);
  });

  it('accepts a finished avatar into the model library and cleans up', async () => {
    const { service } = create();
    const { jobId } = await service.startJob({ mode: 'restyle', prompt: 'A robot' });
    await waitFor(service, jobId, 'completed');

    await expect(service.accept(jobId)).resolves.toEqual({ vrmId: 'vrm-new' });
    expect(models.uploadModel).toHaveBeenCalledWith({
      name: 'A robot',
      fileName: `generated-${jobId.slice(0, 8)}.vrm`,
      data: Buffer.from('vrm-bytes').toString('base64'),
    });
    expect(models.setActiveModel).toHaveBeenCalledWith('vrm-new');
    expect(await readdir(path.join(workDirectory, 'jobs'))).toEqual([]);
    expect(() => service.getStatus(jobId)).toThrow(/Unknown/);
  });

  it('refuses to start when ComfyUI is not running', async () => {
    const { service } = create(fakeComfy({ isAvailable: vi.fn().mockResolvedValue(false) }));
    await expect(service.startJob({ mode: 'restyle', prompt: 'A robot' })).rejects.toThrow(
      /ComfyUI isn't reachable at http:\/\/comfy.test/,
    );
  });

  it('validates the description and allows one job at a time', async () => {
    const never = new Promise<Buffer>(() => undefined);
    const { comfy, service } = create(fakeComfy({ run: vi.fn().mockReturnValue(never) }));
    await expect(service.startJob({ mode: 'restyle', prompt: '   ' })).rejects.toThrow(
      /Describe the avatar/,
    );

    await service.startJob({ mode: 'restyle', prompt: 'First' });
    await vi.waitFor(() => expect(comfy.run).toHaveBeenCalled());
    await expect(service.startJob({ mode: 'restyle', prompt: 'Second' })).rejects.toThrow(
      /already being generated/,
    );
  });

  it('reports failures with the error message', async () => {
    const { service } = create(
      fakeComfy({ run: vi.fn().mockRejectedValue(new Error('model missing')) }),
    );
    const { jobId } = await service.startJob({ mode: 'restyle', prompt: 'A robot' });
    const status = await waitFor(service, jobId, 'failed');
    expect(status.errorMessage).toBe('model missing');
    await expect(service.accept(jobId)).rejects.toThrow(/not finished/);
  });

  it('cancels a running job when rejected', async () => {
    const never = new Promise<Buffer>(() => undefined);
    const { comfy, service } = create(fakeComfy({ run: vi.fn().mockReturnValue(never) }));
    const { jobId } = await service.startJob({ mode: 'restyle', prompt: 'A robot' });
    await vi.waitFor(() => expect(comfy.run).toHaveBeenCalled());
    await service.reject(jobId);
    expect(comfy.interrupt).not.toHaveBeenCalled();
    expect((comfy.run.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect(() => service.getStatus(jobId)).toThrow(/Unknown/);
    // a new job can start straight away
    await expect(service.startJob({ mode: 'restyle', prompt: 'Another' })).resolves.toHaveProperty(
      'jobId',
    );
    await vi.waitFor(() => expect(comfy.run).toHaveBeenCalledTimes(2));
  });
});
