import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarGenerationService } from '../src/avatar/generation/avatar-generation-service.js';
import {
  AvatarCharacterModelService,
  BLENDER_FACE_FIT_RIG,
  BLENDER_STYLISED_FACE_RIG,
  DEFAULT_FACE_VISION_MODEL,
  DEFAULT_HUNYUAN_MV,
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
      kind: 'trellis2' as const,
      id: id ?? 'trellis_2_int8_convrot.safetensors',
      name: id === 'trellis_2_bf16.safetensors' ? 'TRELLIS.2 (bf16)' : 'TRELLIS.2 (int8 convrot)',
      unet: id ?? 'trellis_2_int8_convrot.safetensors',
      shapeVae: 'shape.safetensors',
      textureVae: 'texture.safetensors',
    })),
    resolveRig: vi.fn(async () => ({ id: BLENDER_FACE_FIT_RIG, name: 'Blender rig', face: 'fitted' as const })),
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
    expect(jobs.map((job) => job.takeNumber)).toEqual([1, 2]);
    await service.reject(first.jobId);
    expect(service.listJobs().map((job) => job.takeNumber)).toEqual([2]);
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

  it('builds a stylised face from the vision model instead of MediaPipe', async () => {
    const { service, characterModels, characterRunner } = await setup();
    characterModels.resolveRig.mockImplementation(async (id?: string) =>
      id === BLENDER_STYLISED_FACE_RIG
        ? {
            id: BLENDER_STYLISED_FACE_RIG,
            name: 'Stylised rig',
            face: 'stylised' as const,
            visionModel: DEFAULT_FACE_VISION_MODEL,
          }
        : { id: BLENDER_FACE_FIT_RIG, name: 'Blender rig', face: 'fitted' as const },
    );
    const { jobId } = await service.startJob({ prompt: 'Fox adventurer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    await service.confirmConcept(jobId, { rigModelId: BLENDER_STYLISED_FACE_RIG });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    // MediaPipe isn't run (it would reject a drawn or animal face), nor its human-face warnings.
    expect(characterRunner.prepareReference).not.toHaveBeenCalled();
    expect(characterRunner.inspectReference).not.toHaveBeenCalled();
    expect(characterRunner.build).toHaveBeenCalledWith(
      expect.objectContaining({
        faceStyle: 'stylised',
        landmarksPath: undefined,
        vision: { comfyUrl: 'http://127.0.0.1:8188', model: DEFAULT_FACE_VISION_MODEL },
      }),
    );
    // Rebuilding the same take with the fitted face finds MediaPipe landmarks first.
    await service.confirmConcept(jobId, { rigModelId: BLENDER_FACE_FIT_RIG });
    await vi.waitFor(() => expect(characterRunner.build).toHaveBeenCalledTimes(2));
    expect(characterRunner.prepareReference).toHaveBeenCalledTimes(1);
    expect(characterRunner.build).toHaveBeenLastCalledWith(
      expect.objectContaining({
        faceStyle: 'fitted',
        landmarksPath: expect.stringMatching(/face-landmarks\.json$/),
      }),
    );
    expect(characterRunner.build.mock.lastCall?.[0]).not.toHaveProperty('vision');
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
    { folder: 'text_encoders', name: DEFAULT_FACE_VISION_MODEL, kind: 'qwen3-vl' },
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
      DEFAULT_HUNYUAN_MV,
      'trellis_2_int8_convrot.safetensors',
      'trellis_2_bf16.safetensors',
    ]);
    // Hunyuan3D 2mv comes first but isn't installed here, so TRELLIS.2 is picked.
    expect(selection.geometry[0]).toMatchObject({ available: false });
    expect(selection.geometry[0].unavailableReason).toMatch(/checkpoints folder/);
    expect(selection.geometry[1]).toMatchObject({
      name: 'TRELLIS.2 (int8 convrot)',
      available: true,
    });
    expect(selection.selectedGeometryId).toBe('trellis_2_int8_convrot.safetensors');
    expect(selection.rig).toEqual([
      expect.objectContaining({ id: BLENDER_FACE_FIT_RIG, available: true }),
      expect.objectContaining({ id: BLENDER_STYLISED_FACE_RIG, available: true }),
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
      'avatar.geometryModel.v2',
      'trellis_2_bf16.safetensors',
    );
    expect((await service.list()).selectedGeometryId).toBe('trellis_2_bf16.safetensors');
    await expect(service.resolveGeometry()).resolves.toEqual({
      kind: 'trellis2',
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
    expect(selection.geometry[1].unavailableReason).toMatch(/VAEs/);
    for (const rig of selection.rig)
      expect(rig).toMatchObject({
        available: false,
        unavailableReason: 'Local face fitting needs setup.',
      });
    expect(selection.selectedGeometryId).toBeNull();
    await expect(service.resolveRig()).rejects.toThrow('Local face fitting needs setup.');
  });

  it('offers the stylised face only with Qwen3-VL installed, and resolves it with its vision model', async () => {
    const memory = store();
    const service = new AvatarCharacterModelService(
      vi.fn().mockResolvedValue(files),
      vi.fn().mockResolvedValue(undefined),
      memory,
    );
    await service.select('rig', BLENDER_STYLISED_FACE_RIG);
    expect((await service.list()).selectedRigId).toBe(BLENDER_STYLISED_FACE_RIG);
    await expect(service.resolveRig()).resolves.toEqual({
      id: BLENDER_STYLISED_FACE_RIG,
      name: 'Blender auto-rig with stylised face',
      face: 'stylised',
      visionModel: DEFAULT_FACE_VISION_MODEL,
    });
    await expect(service.resolveRig(BLENDER_FACE_FIT_RIG)).resolves.toMatchObject({ face: 'fitted' });

    const without = new AvatarCharacterModelService(
      vi.fn().mockResolvedValue(files.slice(0, 5)),
      vi.fn().mockResolvedValue(undefined),
      memory,
    );
    const selection = await without.list();
    expect(selection.rig[1]).toMatchObject({ id: BLENDER_STYLISED_FACE_RIG, available: false });
    expect(selection.rig[1].unavailableReason).toMatch(/Qwen3-VL/);
    // The saved stylised choice can't run here, so the fitted face is used.
    expect(selection.selectedRigId).toBe(BLENDER_FACE_FIT_RIG);
    await expect(without.resolveRig(BLENDER_STYLISED_FACE_RIG)).rejects.toThrow(/Qwen3-VL/);
  });

  it('reports TRELLIS.2 as not installed when ComfyUI has none', async () => {
    const service = new AvatarCharacterModelService(
      vi.fn().mockResolvedValue(files.slice(4)),
      vi.fn().mockResolvedValue(undefined),
    );
    const geometry = (await service.list()).geometry;
    expect(geometry).toHaveLength(2);
    for (const model of geometry) {
      expect(model).toMatchObject({ available: false });
      expect(model.unavailableReason).toMatch(/not found in ComfyUI/);
    }
  });

  it('falls back to the workflow defaults when the models cannot be listed', async () => {
    const service = new AvatarCharacterModelService(
      vi.fn().mockRejectedValue(new Error('needs ComfyUI on this computer')),
      vi.fn().mockResolvedValue(undefined),
    );
    await expect(service.resolveGeometry()).resolves.toMatchObject({
      kind: 'hunyuan3d-2mv',
      checkpoint: DEFAULT_HUNYUAN_MV,
    });
    await expect(service.resolveGeometry('trellis_2_int8_convrot.safetensors')).resolves.toMatchObject({
      unet: 'trellis_2_int8_convrot.safetensors',
      shapeVae: 'trellis_2_shape_vae_bf16.safetensors',
    });
  });

  it('makes an installed Hunyuan3D 2mv the default, ahead of an older saved TRELLIS.2 choice', async () => {
    const memory = store();
    memory.setValue('avatar.geometryModel', 'trellis_2_bf16.safetensors');
    const service = new AvatarCharacterModelService(
      vi.fn().mockResolvedValue([
        ...files,
        { folder: 'checkpoints', name: 'hunyuan3d-dit-v2-mv-turbo.safetensors', kind: 'hunyuan3d-2mv' },
        { folder: 'checkpoints', name: DEFAULT_HUNYUAN_MV, kind: 'hunyuan3d-2mv' },
      ]),
      vi.fn().mockResolvedValue(undefined),
      memory,
    );
    const selection = await service.list();
    expect(selection.geometry.slice(0, 2).map((model) => model.name)).toEqual([
      'Hunyuan3D 2mv',
      'Hunyuan3D 2mv (turbo)',
    ]);
    expect(selection.selectedGeometryId).toBe(DEFAULT_HUNYUAN_MV);
    await expect(service.resolveGeometry()).resolves.toEqual({
      kind: 'hunyuan3d-2mv',
      id: DEFAULT_HUNYUAN_MV,
      name: 'Hunyuan3D 2mv',
      checkpoint: DEFAULT_HUNYUAN_MV,
    });
  });
});

describe('removing an image background on request', () => {
  it('cuts the character out, makes the next build find the face again, and can restore the original', async () => {
    const { service, characterRunner } = await setup();
    const removeBackground = vi.fn(async (input: { imagePath: string; outputPath: string }) => {
      expect(path.basename(input.imagePath)).toBe('concept-original.png');
      await writeFile(input.outputPath, 'cutout');
    });
    Object.assign(characterRunner, { removeBackground });
    const { jobId } = await service.startJob({ prompt: 'Neon pilot' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    expect(characterRunner.prepareReference).toHaveBeenCalledTimes(1);

    await service.removeConceptBackground(jobId);
    expect(service.getStatus(jobId)).toMatchObject({
      backgroundRemoved: true,
      previewDataUrl: `data:image/png;base64,${Buffer.from('cutout').toString('base64')}`,
    });
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    expect(characterRunner.prepareReference).toHaveBeenCalledTimes(2);

    // Removing again starts from the original, not the cut-out.
    await service.removeConceptBackground(jobId);
    expect(removeBackground).toHaveBeenCalledTimes(2);

    await service.restoreConceptBackground(jobId);
    expect(service.getStatus(jobId)).toMatchObject({
      backgroundRemoved: false,
      previewDataUrl: `data:image/png;base64,${Buffer.from('bytes').toString('base64')}`,
    });
  });

  it('keeps the image when removal fails', async () => {
    const { service, characterRunner } = await setup();
    Object.assign(characterRunner, {
      removeBackground: vi.fn(async () => {
        throw new Error('The background could not be removed: No character was found to cut out.');
      }),
    });
    const { jobId } = await service.startJob({ prompt: 'Neon pilot' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    const before = service.getStatus(jobId).previewDataUrl;
    await expect(service.removeConceptBackground(jobId)).rejects.toThrow('No character');
    expect(service.getStatus(jobId)).toMatchObject({ previewDataUrl: before, status: 'awaiting_confirmation' });
    expect(service.getStatus(jobId).backgroundRemoved).toBeUndefined();
  });
});

describe('side and back views for multi-view 3D models', () => {
  const qwen = {
    id: 'diffusion_models:qwen.safetensors',
    name: 'Qwen',
    family: 'qwen-image-2.1' as const,
    model: 'qwen.safetensors',
    clip: 'qwen3vl.safetensors',
    vae: 'qwen-vae.safetensors',
  };
  const hunyuan = {
    kind: 'hunyuan3d-2mv' as const,
    id: DEFAULT_HUNYUAN_MV,
    name: 'Hunyuan3D 2mv',
    checkpoint: DEFAULT_HUNYUAN_MV,
  };

  const xl = {
    id: 'checkpoints:xl.safetensors',
    name: 'Custom XL',
    family: 'sdxl' as const,
    model: 'xl.safetensors',
  };

  async function viewSetup(withQwen = true, front: typeof qwen | typeof xl = qwen) {
    const directory = await mkdtemp(path.join(tmpdir(), 'avatar-views-'));
    directories.push(directory);
    let image = 0;
    const comfy = {
      baseUrl: 'http://127.0.0.1:8188',
      isAvailable: vi.fn().mockResolvedValue(true),
      run: vi.fn(async (_graph: Record<string, { class_type: string }>, options?: { output?: string }) =>
        Buffer.from(options?.output === 'mesh' ? 'SHAPE' : `image-${++image}`),
      ),
      uploadImage: vi.fn(async (name: string) => `up-${name}`),
      interrupt: vi.fn(),
    };
    const characterRunner = {
      assertAvailable: vi.fn().mockResolvedValue(undefined),
      inspectReference: vi.fn().mockResolvedValue([]),
      prepareReference: vi.fn().mockResolvedValue(path.join(directory, 'face-landmarks.json')),
      removeBackground: vi.fn(async (input: { outputPath: string }) => {
        await writeFile(input.outputPath, 'cut');
      }),
      paintViews: vi.fn(async (input: { outputPath: string }) => {
        await writeFile(input.outputPath, 'PAINTED');
      }),
      build: vi.fn(async (input: { outputPath: string }) => {
        await writeFile(input.outputPath, 'VRM');
        return Buffer.from('VRM');
      }),
    };
    const imageModels = {
      resolve: vi.fn().mockResolvedValue(front),
      resolveViewModel: vi.fn().mockResolvedValue(withQwen ? qwen : undefined),
    };
    const characterModels = {
      resolveGeometry: vi.fn(async (id?: string) =>
        id === 'trellis'
          ? {
              kind: 'trellis2' as const,
              id: 'trellis',
              name: 'TRELLIS.2',
              unet: 'trellis.safetensors',
              shapeVae: 'shape.safetensors',
              textureVae: 'texture.safetensors',
            }
          : hunyuan,
      ),
      resolveRig: vi.fn(async () => ({ id: BLENDER_FACE_FIT_RIG, name: 'Blender rig', face: 'fitted' as const })),
    };
    const service = new AvatarGenerationService({
      comfy: comfy as unknown as ComfyUIClient,
      characterRunner,
      characterModels,
      imageModels,
      models: { uploadModel: vi.fn(), setActiveModel: vi.fn() },
      runner: { prepare: vi.fn(), score: vi.fn(), assemble: vi.fn() },
      baseModelPath: path.join(directory, 'base.vrm'),
      workDirectory: directory,
    });
    return { service, comfy, characterRunner, imageModels };
  }

  it('draws the side and back views from the front image with the image', async () => {
    const { service, comfy } = await viewSetup();
    const { jobId } = await service.startJob({ prompt: 'Auburn explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    expect(comfy.run).toHaveBeenCalledTimes(3);
    const [, side, back] = comfy.run.mock.calls.map(([graph]) => graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>);
    expect(side.frontImage.inputs.image).toBe(`up-${jobId}-front.png`);
    expect(side.encode.inputs.prompt).toMatch(/left side/);
    expect(back.encode.inputs.prompt).toMatch(/from directly behind/);
    expect(service.getStatus(jobId).views).toEqual({
      left: `data:image/png;base64,${Buffer.from('image-2').toString('base64')}`,
      back: `data:image/png;base64,${Buffer.from('image-3').toString('base64')}`,
    });
  });

  it('builds Hunyuan3D 2mv from all three views and paints them on; TRELLIS.2 gets the front only', async () => {
    const { service, comfy, characterRunner } = await viewSetup();
    const { jobId } = await service.startJob({ prompt: 'Auburn explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    const mesh = comfy.run.mock.calls[3][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(mesh.cond.class_type).toBe('Hunyuan3Dv2ConditioningMultiView');
    expect(Object.keys(mesh.cond.inputs)).toEqual(['front', 'left', 'back']);
    expect(mesh.checkpoint.inputs.ckpt_name).toBe(DEFAULT_HUNYUAN_MV);
    expect(mesh.back_image.inputs.image).toBe(`up-${jobId}-back.png`);
    expect(characterRunner.paintViews).toHaveBeenCalledWith(
      expect.objectContaining({
        meshPath: expect.stringMatching(/source-shape\.glb$/),
        outputPath: expect.stringMatching(/source\.glb$/),
        front: expect.stringMatching(/paint-front\.png$/),
        left: expect.stringMatching(/paint-left\.png$/),
        back: expect.stringMatching(/paint-back\.png$/),
      }),
    );
    expect(characterRunner.build).toHaveBeenCalledWith(
      expect.objectContaining({ meshPath: expect.stringMatching(/source\.glb$/) }),
    );
    expect(service.getStatus(jobId).geometryModelName).toBe('Hunyuan3D 2mv');

    await service.confirmConcept(jobId, { geometryModelId: 'trellis' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    const trellis = comfy.run.mock.calls[4][0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(trellis.image.inputs.image).toBe(`up-${jobId}-concept.png`);
    expect(JSON.stringify(trellis)).not.toMatch(/-(left|back)\.png/);
    expect(characterRunner.paintViews).toHaveBeenCalledTimes(1);
  });

  it('redraws the views with a new seed on request', async () => {
    const { service, comfy } = await viewSetup();
    const { jobId } = await service.startJob({ prompt: 'Auburn explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    const before = service.getStatus(jobId).views;
    await service.redrawViews(jobId);
    expect(service.getStatus(jobId).status).toBe('concept');
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    expect(comfy.run).toHaveBeenCalledTimes(5);
    const seed = (call: number) => (comfy.run.mock.calls[call][0] as Record<string, { inputs: Record<string, unknown> }>).sample.inputs.seed;
    expect(seed(3)).not.toBe(seed(1));
    expect(service.getStatus(jobId).views).not.toEqual(before);
  });

  it('waits for approval before drawing the views when another model drew the front', async () => {
    const { service, comfy, imageModels } = await viewSetup(true, xl);
    const { jobId } = await service.startJob({ prompt: 'Auburn explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    expect(comfy.run).toHaveBeenCalledTimes(1);
    expect(imageModels.resolveViewModel).not.toHaveBeenCalled();
    expect(service.getStatus(jobId).views).toEqual({});
    expect(service.getStatus(jobId).viewsMessage).toMatch(/after you approve/);
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    expect(comfy.run).toHaveBeenCalledTimes(4);
    const graphs = comfy.run.mock.calls.map(([graph]) => graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>);
    expect(graphs[1].encode.inputs.prompt).toMatch(/left side/);
    expect(graphs[2].encode.inputs.prompt).toMatch(/from directly behind/);
    expect(Object.keys(graphs[3].cond.inputs)).toEqual(['front', 'left', 'back']);
    expect(service.getStatus(jobId).views?.back).toBeTruthy();

    // A rebuild reuses the views already drawn.
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    expect(comfy.run).toHaveBeenCalledTimes(5);
  });

  it('explains when there is no Qwen-Image model to draw the views, and builds from the front', async () => {
    const { service, comfy, characterRunner } = await viewSetup(false);
    const { jobId } = await service.startJob({ prompt: 'Auburn explorer' });
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('awaiting_confirmation'));
    expect(comfy.run).toHaveBeenCalledTimes(1);
    expect(service.getStatus(jobId).viewsMessage).toMatch(/need Qwen-Image/);
    await service.confirmConcept(jobId);
    await vi.waitFor(() => expect(service.getStatus(jobId).status).toBe('completed'));
    const mesh = comfy.run.mock.calls[1][0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(Object.keys(mesh.cond.inputs)).toEqual(['front']);
    expect(characterRunner.paintViews).toHaveBeenCalledWith(
      expect.not.objectContaining({ left: expect.anything() }),
    );
  });
});
