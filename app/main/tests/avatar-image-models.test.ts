import { describe, expect, it, vi } from 'vitest';
import {
  AvatarImageModelService,
  type ImageModelFile,
} from '../src/avatar/generation/image-model-service.js';
import { buildImageWorkflow } from '../src/avatar/generation/image-workflows.js';

const installed: ImageModelFile[] = [
  { folder: 'diffusion_models', name: 'renamed-qwen.safetensors', kind: 'qwen-image-2.1' },
  { folder: 'diffusion_models', name: 'z_image_turbo_bf16.safetensors', kind: 'z-image-turbo' },
  { folder: 'text_encoders', name: 'renamed-vl.safetensors', kind: 'qwen3-vl' },
  { folder: 'vae', name: 'renamed-qwen-vae.safetensors', kind: 'qwen-image-vae' },
  { folder: 'text_encoders', name: 'qwen_3_4b.safetensors', kind: 'qwen3-4b' },
  { folder: 'vae', name: 'ae.safetensors', kind: 'flux-ae' },
  {
    folder: 'checkpoints',
    name: 'folder/variant.safetensors',
    kind: 'sdxl',
    embeddedClip: true,
    embeddedClip2: true,
    embeddedVae: true,
  },
  {
    folder: 'checkpoints',
    name: 'legacy.safetensors',
    kind: 'sd1',
    embeddedClip: true,
    embeddedVae: true,
  },
  { folder: 'checkpoints', name: 'mesh.safetensors', kind: 'trellis' },
];

describe('installed image models', () => {
  it('selects the correct family workflow from detected weights and remembers the model', async () => {
    const values = new Map<string, string>();
    const store = {
      getValue: (key: string) => values.get(key) ?? null,
      setValue: (key: string, value: string) => values.set(key, value),
    };
    const service = new AvatarImageModelService(async () => installed, store);
    const state = await service.list();
    expect(state.models).toHaveLength(4);
    expect(state.models.every((model) => model.available)).toBe(true);
    expect(state.selectedModelId).toBe('diffusion_models:renamed-qwen.safetensors');
    const qwen = buildImageWorkflow(await service.resolve(), 'character', 42);
    expect(qwen.unet.inputs.unet_name).toBe('renamed-qwen.safetensors');
    expect(qwen.clip.inputs.clip_name).toBe('renamed-vl.safetensors');
    const id = 'checkpoints:folder/variant.safetensors';
    await service.select(id);
    const restarted = new AvatarImageModelService(async () => installed, store);
    expect((await restarted.list()).selectedModelId).toBe(id);
    const xl = buildImageWorkflow(await restarted.resolve(), 'character', 42);
    expect(xl.checkpoint.inputs.ckpt_name).toBe('folder/variant.safetensors');
    expect(xl.latent.inputs.width).toBe(1024);
    const z = buildImageWorkflow(
      await service.resolve('diffusion_models:z_image_turbo_bf16.safetensors'),
      'character',
      42,
    );
    expect(z.clip.inputs.type).toBe('lumina2');
    expect(z.sample.inputs).toMatchObject({ steps: 8, cfg: 1 });
    const legacy = buildImageWorkflow(
      await service.resolve('checkpoints:legacy.safetensors'),
      'character',
      42,
    );
    expect(legacy.latent.inputs).toMatchObject({ width: 512, height: 768 });
  });

  it('refreshes variants, rejects removed or unavailable selections, and does not guess unknown families', async () => {
    let files = [...installed];
    const service = new AvatarImageModelService(async () => files);
    const model = await service.resolve('checkpoints:folder/variant.safetensors');
    files = files.filter(
      (file) => file.name !== 'folder/variant.safetensors' && file.kind !== 'qwen3-vl',
    );
    await expect(service.resolve(model.id)).rejects.toThrow('no longer available');
    const state = await service.list();
    expect(
      state.models.find((entry) => entry.id === 'diffusion_models:renamed-qwen.safetensors')
        ?.available,
    ).toBe(false);
    files.push({
      folder: 'checkpoints',
      name: 'new.safetensors',
      kind: 'sdxl',
      embeddedClip: true,
      embeddedClip2: true,
      embeddedVae: true,
    });
    expect(
      (await service.list()).models.some((entry) => entry.id === 'checkpoints:new.safetensors'),
    ).toBe(true);
    // Already queued jobs hold their concrete model, so another refresh cannot mutate them.
    expect(buildImageWorkflow(model, 'character', 42).checkpoint.inputs.ckpt_name).toBe(
      'folder/variant.safetensors',
    );
    await expect(service.select('../other-file')).rejects.toThrow('no longer available');
  });

  it('deduplicates simultaneous scans and allows retry after a scanner error', async () => {
    const scan = vi
      .fn()
      .mockRejectedValueOnce(new Error('scanner unavailable'))
      .mockResolvedValue(installed);
    const service = new AvatarImageModelService(scan);
    await expect(service.list()).rejects.toThrow('scanner unavailable');
    await Promise.all([service.list(), service.list()]);
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
