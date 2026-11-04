import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarGenerationService } from '../src/avatar/generation/avatar-generation-service.js';
import type { FrontCheck } from '../src/avatar/generation/character/rig-runner.js';
import type { ComfyUIClient } from '../src/avatar/generation/comfyui-client.js';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Each drawn front is "front-<n>"; checks and face results are scripted per call. */
async function setup(checks: FrontCheck[], faces: (string | null)[]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'avatar-front-'));
  directories.push(directory);
  let drawn = 0;
  const run = vi.fn(async () => Buffer.from(`front-${++drawn}`));
  const comfy = {
    baseUrl: 'http://127.0.0.1:8188',
    isAvailable: vi.fn().mockResolvedValue(true),
    run,
    uploadImage: vi.fn().mockResolvedValue('reference.png'),
    interrupt: vi.fn(),
  };
  const characterRunner = {
    assertAvailable: vi.fn().mockResolvedValue(undefined),
    inspectReference: vi.fn().mockResolvedValue([]),
    checkFront: vi.fn(async () => checks.shift() ?? { backgroundOk: true, figures: 1 }),
    removeBackground: vi.fn(async (input: { imagePath: string; outputPath: string }) => {
      await writeFile(input.outputPath, `${await readFile(input.imagePath, 'utf8')}-cutout`);
    }),
    prepareReference: vi.fn(async () => {
      const problem = faces.shift();
      if (problem) throw new Error(`The reference face could not be fitted: ${problem}`);
      return path.join(directory, 'face-landmarks.json');
    }),
    build: vi.fn(),
  };
  const service = new AvatarGenerationService({
    comfy: comfy as unknown as ComfyUIClient,
    characterRunner,
    models: { uploadModel: vi.fn(), setActiveModel: vi.fn() },
    runner: { prepare: vi.fn(), score: vi.fn(), assemble: vi.fn() },
    baseModelPath: path.join(directory, 'base.vrm'),
    workDirectory: directory,
  });
  return { service, run, characterRunner };
}

async function review(service: AvatarGenerationService, jobId: string) {
  await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
  const status = service.getStatus(jobId);
  return { status, image: Buffer.from(status.previewDataUrl!.split(',')[1], 'base64').toString() };
}

describe('checks on a new front', () => {
  it('cuts a grey background away and finds the face once, for the build to reuse', async () => {
    const { service, run, characterRunner } = await setup([{ backgroundOk: false, figures: null }], [null]);
    const { jobId } = await service.startJob({ prompt: 'Chef' });
    const { status, image } = await review(service, jobId);
    expect(image).toBe('front-1-cutout');
    expect(status).toMatchObject({ backgroundRemoved: true, frontCheck: { attempts: 1, problem: null } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(characterRunner.checkFront).toHaveBeenCalledTimes(2);
    const directory = path.dirname(characterRunner.removeBackground.mock.calls[0][0].imagePath);
    expect(await readFile(path.join(directory, 'concept-original.png'), 'utf8')).toBe('front-1');
    await service.confirmConcept(jobId);
    // The face found while checking is the one the build uses.
    expect(characterRunner.prepareReference).toHaveBeenCalledTimes(1);
  });

  it('draws again with another seed when a front shows several characters or no face', async () => {
    const { service, run } = await setup(
      [{ backgroundOk: true, figures: 3 }, { backgroundOk: true, figures: 1 }, { backgroundOk: true, figures: 1 }],
      ['Need one clearly visible human face.', null],
    );
    const { jobId } = await service.startJob({ prompt: 'Explorer' });
    const { status, image } = await review(service, jobId);
    expect(image).toBe('front-3');
    expect(status.frontCheck).toEqual({ attempts: 3, problem: null });
    const seeds = run.mock.calls.map((call) => (call[0] as Record<string, { inputs: { seed?: number } }>).sample?.inputs.seed);
    expect(new Set(seeds).size).toBe(3);
  });

  it('stops after three fronts and says what is still wrong', async () => {
    const { service, run } = await setup(
      [1, 2, 3].map(() => ({ backgroundOk: true, figures: 2 })),
      [],
    );
    const { jobId } = await service.startJob({ prompt: 'Explorer' });
    const { status } = await review(service, jobId);
    expect(run).toHaveBeenCalledTimes(3);
    expect(status.frontCheck).toEqual({ attempts: 3, problem: 'It shows 2 characters instead of one.' });
  });

  it('checks an upload but never redraws it', async () => {
    const { service, run } = await setup([], ['Use a front-facing face rather than a profile.']);
    const { PNG } = await import('pngjs');
    const png = new PNG({ width: 8, height: 8 });
    const { jobId } = await service.startJob({
      referenceImage: { mimeType: 'image/png', data: PNG.sync.write(png).toString('base64') },
    });
    const { status } = await review(service, jobId);
    expect(run).not.toHaveBeenCalled();
    expect(status.frontCheck).toEqual({ attempts: 1, problem: 'Use a front-facing face rather than a profile.' });
  });

  it('goes on to review unchecked when the check tools fail', async () => {
    const { service, characterRunner } = await setup([], []);
    characterRunner.checkFront.mockRejectedValueOnce(new Error('python missing'));
    const { jobId } = await service.startJob({ prompt: 'Explorer' });
    const { status, image } = await review(service, jobId);
    expect(image).toBe('front-1');
    expect(status.frontCheck).toBeUndefined();
  });
});
