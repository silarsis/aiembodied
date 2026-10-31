import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarGenerationService } from '../src/avatar/generation/avatar-generation-service.js';
import {
  characterMeshGraph,
  characterConceptPrompt,
} from '../src/avatar/generation/character/graphs.js';
import type { ComfyUIClient } from '../src/avatar/generation/comfyui-client.js';
import { PNG } from 'pngjs';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(failRig = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'new-character-'));
  directories.push(directory);
  const comfy = {
    baseUrl: 'http://127.0.0.1:8188',
    isAvailable: vi.fn().mockResolvedValue(true),
    run: vi
      .fn()
      .mockResolvedValueOnce(Buffer.from('concept'))
      .mockResolvedValueOnce(Buffer.from('NEW-GEOMETRY')),
    uploadImage: vi.fn().mockResolvedValue('reference.png'),
    interrupt: vi.fn(),
  };
  const models = {
    uploadModel: vi.fn().mockResolvedValue({ model: { id: 'new-model' } }),
    setActiveModel: vi.fn(),
  };
  const characterRunner = {
    assertAvailable: vi.fn().mockResolvedValue(undefined),
    build: vi.fn(async (input: { meshPath: string; outputPath: string }) => {
      expect(await readFile(input.meshPath, 'utf8')).toBe('NEW-GEOMETRY');
      if (failRig) throw new Error('Limbs are fused');
      const result = Buffer.from('NEW-RIGGED-VRM');
      await writeFile(input.outputPath, result);
      return result;
    }),
  };
  const runner = { prepare: vi.fn(), score: vi.fn(), assemble: vi.fn() };
  const service = new AvatarGenerationService({
    comfy: comfy as unknown as ComfyUIClient,
    characterRunner,
    models,
    runner,
    baseModelPath: path.join(directory, 'DOES-NOT-EXIST.vrm'),
    workDirectory: directory,
  });
  return { service, comfy, models, characterRunner, runner };
}

describe('new character generation', () => {
  it('reviews an uploaded image offline and uses those exact bytes for geometry only after approval', async () => {
    const { service, comfy, characterRunner } = await setup();
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    comfy.isAvailable.mockResolvedValue(false);
    const { jobId } = await service.startJob({
      referenceImage: { mimeType: 'image/png', data: png.toString('base64') },
    });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    expect(service.getStatus(jobId).previewDataUrl).toBe(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(comfy.isAvailable).not.toHaveBeenCalled();
    expect(comfy.run).not.toHaveBeenCalled();
    expect(characterRunner.build).not.toHaveBeenCalled();
    comfy.isAvailable.mockResolvedValue(true);
    comfy.run.mockReset().mockResolvedValue(Buffer.from('NEW-GEOMETRY'));
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    expect(comfy.uploadImage).toHaveBeenCalledWith(`${jobId}-concept.png`, png);
    expect(comfy.run).toHaveBeenCalledTimes(1);
    expect(comfy.run.mock.calls[0][1]).toMatchObject({ output: 'mesh' });
  });

  it('rejects invalid uploaded image bytes without queuing work', async () => {
    const { service, comfy } = await setup();
    await expect(
      service.startJob({
        referenceImage: {
          mimeType: 'image/png',
          data: Buffer.from('not an image').toString('base64'),
        },
      }),
    ).rejects.toThrow('reference image');
    expect(comfy.run).not.toHaveBeenCalled();
  });
  it('can discard the concept without generating geometry or requiring Blender', async () => {
    const { service, comfy, characterRunner, models } = await setup();
    characterRunner.assertAvailable.mockRejectedValue(new Error('Blender not installed'));
    const { jobId } = await service.startJob({ prompt: 'An explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    await expect(service.confirmConcept(jobId)).rejects.toThrow('Blender not installed');
    expect(service.getStatus(jobId).status).toBe('awaiting_confirmation');
    expect(comfy.run).toHaveBeenCalledTimes(1);
    await service.reject(jobId);
    await expect(service.confirmConcept(jobId)).rejects.toThrow('Unknown avatar');
    expect(characterRunner.build).not.toHaveBeenCalled();
    expect(models.uploadModel).not.toHaveBeenCalled();
  });
  it('defaults to new geometry and rigs that output, never the bundled avatar', async () => {
    const { service, comfy, characterRunner, runner, models } = await setup();
    const { jobId } = await service.startJob({ prompt: 'An auburn-haired explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    expect(comfy.run).toHaveBeenCalledTimes(1);
    expect(comfy.uploadImage).not.toHaveBeenCalled();
    expect(characterRunner.assertAvailable).not.toHaveBeenCalled();
    expect(characterRunner.build).not.toHaveBeenCalled();
    await expect(service.accept(jobId)).rejects.toThrow('not finished');
    await service.confirmConcept(jobId);
    await expect(service.confirmConcept(jobId)).rejects.toThrow('not awaiting confirmation');
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    expect(characterRunner.assertAvailable).toHaveBeenCalledOnce();
    expect(comfy.run.mock.calls[1][1]).toMatchObject({ output: 'mesh' });
    expect(runner.prepare).not.toHaveBeenCalled();
    expect(models.setActiveModel).not.toHaveBeenCalled();
    expect(await service.loadPreview(jobId)).toEqual(Buffer.from('NEW-RIGGED-VRM'));
    await service.accept(jobId);
    expect(models.uploadModel).toHaveBeenCalledWith(
      expect.objectContaining({ data: Buffer.from('NEW-RIGGED-VRM').toString('base64') }),
    );
    expect(models.setActiveModel).toHaveBeenCalledWith('new-model');
    await expect(service.loadPreview(jobId)).rejects.toThrow('Unknown avatar');
  });

  it('does not replace the current avatar or fall back to recolouring if rigging fails', async () => {
    const { service, models, runner } = await setup(true);
    const { jobId } = await service.startJob({ prompt: 'An explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('failed'));
    expect(service.getStatus(jobId).errorMessage).toBe('Limbs are fused');
    await expect(service.accept(jobId)).rejects.toThrow('not finished');
    await expect(service.loadPreview(jobId)).rejects.toThrow('not finished');
    expect(models.uploadModel).not.toHaveBeenCalled();
    expect(runner.prepare).not.toHaveBeenCalled();
  });

  it('builds an independent, seeded textured mesh graph and an animation-friendly reference', () => {
    const first = characterMeshGraph('one.png', 123),
      second = characterMeshGraph('two.png', 456);
    expect(first.image.inputs.image).toBe('one.png');
    expect(second.image.inputs.image).toBe('two.png');
    expect(first.s_struct.inputs.seed).toBe(123);
    expect(second.s_tex.inputs.seed).toBe(456);
    expect(first.save.class_type).toBe('SaveGLB');
    expect(characterConceptPrompt('An explorer')).toContain('NO eyes, eyebrows or mouth');
  });
});
