import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarGenerationService } from '../src/avatar/generation/avatar-generation-service.js';
import {
  AvatarCharacterModelService,
  BLENDER_FACE_FIT_RIG,
} from '../src/avatar/generation/character-model-service.js';
import type { ComfyUIClient } from '../src/avatar/generation/comfyui-client.js';
import type { ImageModelFile } from '../src/avatar/generation/image-model-service.js';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(run = vi.fn().mockResolvedValue(Buffer.from('bytes'))) {
  const directory = await mkdtemp(path.join(tmpdir(), 'avatar-takes-'));
  directories.push(directory);
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
    prepareReference: vi.fn().mockResolvedValue(path.join(directory, 'face-landmarks.json')),
    build: vi.fn(async (input: { outputPath: string }) => {
      await writeFile(input.outputPath, 'VRM');
      return Buffer.from('VRM');
    }),
  };
  const characterModels = {
    resolveGeometry: vi.fn(async (id?: string) => ({
      id: id ?? 'trellis_2_int8_convrot.safetensors',
      name: id === 'trellis_2_bf16.safetensors' ? 'TRELLIS.2 (bf16)' : 'TRELLIS.2 (int8 convrot)',
      unet: id ?? 'trellis_2_int8_convrot.safetensors',
      shapeVae: 'shape.safetensors',
      textureVae: 'texture.safetensors',
    })),
    resolveRig: vi.fn(async () => ({ id: BLENDER_FACE_FIT_RIG, name: 'Blender rig' })),
  };
  const service = new AvatarGenerationService({
    comfy: comfy as unknown as ComfyUIClient,
    characterRunner,
    characterModels,
    models: { uploadModel: vi.fn(), setActiveModel: vi.fn() },
    runner: { prepare: vi.fn(), score: vi.fn(), assemble: vi.fn() },
    baseModelPath: path.join(directory, 'base.vrm'),
    workDirectory: directory,
  });
  return { service, comfy, characterModels, characterRunner };
}

describe('avatar studio takes', () => {
  it('keeps an image awaiting review while another take is generated, and lists both', async () => {
    const { service } = await setup();
    const first = await service.startJob({ prompt: 'Auburn explorer' });
    await vi.waitFor(() =>
      expect(service.getStatus(first.jobId).status).toBe('awaiting_confirmation'),
    );
    const second = await service.startJob({ prompt: 'Silver-haired pilot' });
    await vi.waitFor(() =>
      expect(service.getStatus(second.jobId).status).toBe('awaiting_confirmation'),
    );
    const jobs = service.listJobs();
    expect(jobs.map((job) => job.prompt)).toEqual(['Auburn explorer', 'Silver-haired pilot']);
    expect(jobs[0]).toMatchObject({ source: 'text', mode: 'new-character' });
    expect(typeof jobs[0].createdAt).toBe('number');
  });

  it('allows only one running job across takes', async () => {
    const never = new Promise<Buffer>(() => undefined);
    const run = vi.fn().mockResolvedValueOnce(Buffer.from('concept')).mockReturnValue(never);
    const { service } = await setup(run);
    const first = await service.startJob({ prompt: 'First' });
    await vi.waitFor(() =>
      expect(service.getStatus(first.jobId).status).toBe('awaiting_confirmation'),
    );
    const second = await service.startJob({ prompt: 'Second' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await expect(service.confirmConcept(first.jobId)).rejects.toThrow(/Another avatar/);
    await expect(service.startJob({ prompt: 'Third' })).rejects.toThrow(/already being generated/);
    service.cancel(second.jobId);
    expect(service.getStatus(second.jobId).status).toBe('cancelled');
    await expect(service.confirmConcept(first.jobId)).resolves.toBeUndefined();
  });

  it('builds with the chosen 3D model and records which models were used', async () => {
    const { service, comfy, characterModels } = await setup();
    const { jobId } = await service.startJob({ prompt: 'Explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    await service.confirmConcept(jobId, {
      geometryModelId: 'trellis_2_bf16.safetensors',
      rigModelId: BLENDER_FACE_FIT_RIG,
    });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    expect(characterModels.resolveGeometry).toHaveBeenCalledWith('trellis_2_bf16.safetensors');
    expect(characterModels.resolveRig).toHaveBeenCalledWith(BLENDER_FACE_FIT_RIG);
    const graph = comfy.run.mock.calls[1][0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph.unet.inputs.unet_name).toBe('trellis_2_bf16.safetensors');
    expect(graph.shape_vae.inputs.vae_name).toBe('shape.safetensors');
    expect(graph.tex_vae.inputs.vae_name).toBe('texture.safetensors');
    expect(service.getStatus(jobId)).toMatchObject({
      geometryModelName: 'TRELLIS.2 (bf16)',
      rigModelName: 'Blender rig',
    });
    expect(typeof service.getStatus(jobId).buildSeconds).toBe('number');
  });

  it('rebuilds a finished or cancelled take from its image with a different model', async () => {
    const never = new Promise<Buffer>(() => undefined);
    const run = vi
      .fn()
      .mockResolvedValueOnce(Buffer.from('concept'))
      .mockReturnValueOnce(never)
      .mockResolvedValue(Buffer.from('mesh'));
    const { service, comfy } = await setup(run);
    const { jobId } = await service.startJob({ prompt: 'Explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    service.cancel(jobId);
    expect(service.getStatus(jobId).previewDataUrl).toMatch(/^data:image\/png;base64,/);
    await service.confirmConcept(jobId, { geometryModelId: 'trellis_2_bf16.safetensors' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    expect(comfy.run).toHaveBeenCalledTimes(4);
    expect(await service.loadPreview(jobId)).toEqual(Buffer.from('VRM'));
  });

  it('refuses to cancel a take that is not running', async () => {
    const { service } = await setup();
    const { jobId } = await service.startJob({ prompt: 'Explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    expect(() => service.cancel(jobId)).toThrow(/not being generated/);
  });
});

describe('3D avatar model choices', () => {
  const files: ImageModelFile[] = [
    { folder: 'diffusion_models', name: 'trellis_2_bf16.safetensors', kind: 'trellis2' },
    { folder: 'diffusion_models', name: 'trellis_2_int8_convrot.safetensors', kind: 'trellis2' },
    { folder: 'vae', name: 'trellis_2_shape_vae_bf16.safetensors', kind: 'trellis2-shape-vae' },
    { folder: 'vae', name: 'trellis_2_texture_vae_bf16.safetensors', kind: 'trellis2-texture-vae' },
    { folder: 'diffusion_models', name: 'qwen.safetensors', kind: 'qwen-image-2.1' },
  ];
  const store = () => {
    const values = new Map<string, string>();
    return {
      getValue: vi.fn((key: string) => values.get(key) ?? null),
      setValue: vi.fn((key: string, value: string) => void values.set(key, value)),
    };
  };

  it('lists installed TRELLIS.2 variants with the workflow default first, and the rig', async () => {
    const service = new AvatarCharacterModelService(
      vi.fn().mockResolvedValue(files),
      vi.fn().mockResolvedValue(undefined),
      store(),
    );
    const selection = await service.list();
    expect(selection.geometry.map((model) => model.id)).toEqual([
      'trellis_2_int8_convrot.safetensors',
      'trellis_2_bf16.safetensors',
    ]);
    expect(selection.geometry[0]).toMatchObject({
      name: 'TRELLIS.2 (int8 convrot)',
      available: true,
    });
    expect(selection.selectedGeometryId).toBe('trellis_2_int8_convrot.safetensors');
    expect(selection.rig).toEqual([
      expect.objectContaining({ id: BLENDER_FACE_FIT_RIG, available: true }),
    ]);
    expect(selection.selectedRigId).toBe(BLENDER_FACE_FIT_RIG);
  });

  it('remembers a choice and resolves it to the weights the workflow loads', async () => {
    const memory = store();
    const service = new AvatarCharacterModelService(
      vi.fn().mockResolvedValue(files),
      vi.fn().mockResolvedValue(undefined),
      memory,
    );
    await service.select('geometry', 'trellis_2_bf16.safetensors');
    expect(memory.setValue).toHaveBeenCalledWith(
      'avatar.geometryModel',
      'trellis_2_bf16.safetensors',
    );
    expect((await service.list()).selectedGeometryId).toBe('trellis_2_bf16.safetensors');
    await expect(service.resolveGeometry()).resolves.toEqual({
      id: 'trellis_2_bf16.safetensors',
      name: 'TRELLIS.2 (bf16)',
      unet: 'trellis_2_bf16.safetensors',
      shapeVae: 'trellis_2_shape_vae_bf16.safetensors',
      textureVae: 'trellis_2_texture_vae_bf16.safetensors',
    });
    await expect(service.select('geometry', 'missing.safetensors')).rejects.toThrow(
      /no longer available/,
    );
  });

  it('explains missing weights and an unavailable rig instead of offering them', async () => {
    const service = new AvatarCharacterModelService(
      vi.fn().mockResolvedValue(files.slice(0, 2)),
      vi.fn().mockRejectedValue(new Error('Local face fitting needs setup.')),
    );
    const selection = await service.list();
    expect(selection.geometry.every((model) => !model.available)).toBe(true);
    expect(selection.geometry[0].unavailableReason).toMatch(/VAEs/);
    expect(selection.rig[0]).toMatchObject({
      available: false,
      unavailableReason: 'Local face fitting needs setup.',
    });
    expect(selection.selectedGeometryId).toBeNull();
    await expect(service.resolveRig()).rejects.toThrow('Local face fitting needs setup.');
  });

  it('reports TRELLIS.2 as not installed when ComfyUI has none', async () => {
    const service = new AvatarCharacterModelService(
      vi.fn().mockResolvedValue(files.slice(4)),
      vi.fn().mockResolvedValue(undefined),
    );
    const [only] = (await service.list()).geometry;
    expect(only).toMatchObject({ available: false });
    expect(only.unavailableReason).toMatch(/not found in ComfyUI/);
  });

  it('falls back to the workflow defaults when the models cannot be listed', async () => {
    const service = new AvatarCharacterModelService(
      vi.fn().mockRejectedValue(new Error('needs ComfyUI on this computer')),
      vi.fn().mockResolvedValue(undefined),
    );
    await expect(service.resolveGeometry()).resolves.toMatchObject({
      unet: 'trellis_2_int8_convrot.safetensors',
      shapeVae: 'trellis_2_shape_vae_bf16.safetensors',
    });
  });
});
