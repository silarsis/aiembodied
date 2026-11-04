import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import {
  AvatarImageModelService,
  remoteModelKind,
  type ImageModelFile,
  type PoseControlInstaller,
} from '../src/avatar/generation/image-model-service.js';
import { buildAvatarImageWorkflow } from '../src/avatar/generation/image-workflows.js';
import {
  drawPoseSkeleton,
  POSE_CONTROLNETS,
  poseControlNetPlan,
  poseImageSize,
  poseKeypoints,
  QWEN_POSE_INSTRUCTION,
} from '../src/avatar/generation/pose-control.js';

const checkpoint = (name: string, kind: 'sd1' | 'sdxl'): ImageModelFile => ({
  folder: 'checkpoints',
  name,
  kind,
  embeddedClip: true,
  embeddedClip2: kind === 'sdxl',
  embeddedVae: true,
});
const models: ImageModelFile[] = [
  checkpoint('dreamshaper_8.safetensors', 'sd1'),
  checkpoint('novaFurryXL.safetensors', 'sdxl'),
  { folder: 'diffusion_models', name: 'qwen.safetensors', kind: 'qwen-image-2.1' },
  { folder: 'text_encoders', name: 'vl.safetensors', kind: 'qwen3-vl' },
  { folder: 'vae', name: 'qwen-vae.safetensors', kind: 'qwen-image-vae' },
  { folder: 'diffusion_models', name: 'z_image_turbo.safetensors', kind: 'z-image-turbo' },
  { folder: 'text_encoders', name: 'qwen_3_4b.safetensors', kind: 'qwen3-4b' },
  { folder: 'vae', name: 'ae.safetensors', kind: 'flux-ae' },
];
const sd1Net: ImageModelFile = { folder: 'controlnet', name: POSE_CONTROLNETS.sd1.filename, kind: 'controlnet', family: 'sd1' };

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getValue: (key: string) => values.get(key) ?? null,
    setValue: (key: string, value: string) => void values.set(key, value),
  };
}

function fakeInstaller(canInstall = true) {
  const states: Partial<Record<'sd1' | 'sdxl', 'downloading' | 'done' | 'failed'>> = {};
  const install = vi.fn(async (family: 'sd1' | 'sdxl') => {
    if (canInstall) states[family] = 'downloading';
    return canInstall;
  });
  const installer: PoseControlInstaller = {
    status: (family) => (states[family] ? { state: states[family] } : null),
    install,
  };
  return { installer, install, states };
}

describe('A-pose skeleton', () => {
  it('draws the OpenPose skeleton inside the image at the size the model samples', () => {
    const png = PNG.sync.read(drawPoseSkeleton(512, 768));
    expect([png.width, png.height]).toEqual([512, 768]);
    const points = poseKeypoints(512, 768);
    for (const [x, y] of points) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(512);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(768);
    }
    const pixel = ([x, y]: [number, number]) => {
      const index = (Math.round(y) * png.width + Math.round(x)) * 4;
      return [png.data[index], png.data[index + 1], png.data[index + 2]];
    };
    // Joints carry OpenPose's colours: neck orange, right wrist yellow-green, left ankle violet.
    expect(pixel(points[1])).toEqual([255, 85, 0]);
    expect(pixel(points[4])).toEqual([170, 255, 0]);
    expect(pixel(points[13])).toEqual([85, 0, 255]);
    // Black background, and arms held well clear of the hips.
    expect(pixel([5, 5])).toEqual([0, 0, 0]);
    expect(points[4][0]).toBeLessThan(points[8][0] - 100);
    expect(points[7][0]).toBeGreaterThan(points[11][0] + 100);
  });
});

describe('pose control in the front-image workflow', () => {
  const sd1 = { id: 'checkpoints:a', name: 'A', family: 'sd1' as const, model: 'a.safetensors' };

  it('routes the sampler through the pose ControlNet when the model has one and a skeleton was uploaded', () => {
    const graph = buildAvatarImageWorkflow({ ...sd1, poseControlNet: 'pose.safetensors' }, 'explorer', 'new-character', 7, 'aiembodied/a-pose.png');
    expect(graph.poseControlNet.inputs.control_net_name).toBe('pose.safetensors');
    expect(graph.poseImage.inputs.image).toBe('aiembodied/a-pose.png');
    expect(graph.poseApply.inputs.positive).toEqual(['positive', 0]);
    expect(graph.poseApply.inputs.negative).toEqual(['negative', 0]);
    expect(graph.sample.inputs.positive).toEqual(['poseApply', 0]);
    expect(graph.sample.inputs.negative).toEqual(['poseApply', 1]);
    expect(graph.negative.inputs.text).toContain('arms at sides');
  });

  it('keeps the plain workflow without a ControlNet or skeleton', () => {
    expect(buildAvatarImageWorkflow(sd1, 'x', 'new-character', 7, 'a.png').poseApply).toBeUndefined();
    expect(buildAvatarImageWorkflow({ ...sd1, poseControlNet: 'pose.safetensors' }, 'x', 'new-character', 7).poseApply).toBeUndefined();
  });

  it('gives a new character’s Qwen-Image front the skeleton as its reference image', () => {
    const qwen = { id: 'q', name: 'Q', family: 'qwen-image-2.1' as const, model: 'q', clip: 'c', vae: 'v' };
    expect(poseImageSize(qwen)).toEqual({ width: 1024, height: 1024 });
    const graph = buildAvatarImageWorkflow(qwen, 'explorer', 'new-character', 7, 'aiembodied/a-pose.png');
    expect(graph.poseImage.inputs.image).toBe('aiembodied/a-pose.png');
    expect(graph.encode.inputs['images.image_1']).toEqual(['poseImage', 0]);
    expect(String(graph.encode.inputs.prompt).startsWith(QWEN_POSE_INSTRUCTION)).toBe(true);
    expect(graph.poseApply).toBeUndefined();
    // A restyle keeps the bundled avatar's body, so it isn't posed; nor is a front without a skeleton.
    expect(buildAvatarImageWorkflow(qwen, 'x', 'restyle', 7, 'a.png').poseImage).toBeUndefined();
    expect(buildAvatarImageWorkflow(qwen, 'x', 'new-character', 7).poseImage).toBeUndefined();
    expect(poseImageSize({ family: 'z-image-turbo' })).toBeUndefined();
    expect(poseImageSize({ family: 'sdxl' })).toBeUndefined();
    expect(poseImageSize({ family: 'sd1', poseControlNet: 'p' })).toEqual({ width: 512, height: 768 });
  });

  it('plans the download of each family’s pose ControlNet into the controlnet folder', () => {
    const plan = poseControlNetPlan('sdxl');
    expect(plan.folder).toBe('controlnet');
    expect(plan.file.name).toBe(POSE_CONTROLNETS.sdxl.filename);
    expect(plan.file.downloadUrl).toMatch(/^https:\/\/huggingface\.co\//);
    expect(plan.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.info?.family).toBe('sdxl');
  });
});

describe('pose control for installed image models', () => {
  it('says how each model gets its pose and hands the installed ControlNet to its family’s jobs', async () => {
    const { installer } = fakeInstaller();
    const service = new AvatarImageModelService(async () => [...models, sd1Net], memoryStore(), installer);
    const state = await service.list();
    const pose = Object.fromEntries(state.models.map((model) => [model.id, model.poseControl]));
    expect(pose).toEqual({
      'checkpoints:dreamshaper_8.safetensors': 'guided',
      'checkpoints:novaFurryXL.safetensors': 'installing',
      'diffusion_models:qwen.safetensors': 'guided',
      'diffusion_models:z_image_turbo.safetensors': 'none',
    });
    expect(state.models.every((model) => model.poseNote)).toBe(true);
    expect((await service.resolve('checkpoints:dreamshaper_8.safetensors')).poseControlNet).toBe(POSE_CONTROLNETS.sd1.filename);
    expect((await service.resolve('checkpoints:novaFurryXL.safetensors')).poseControlNet).toBeUndefined();
  });

  it('downloads the pose ControlNet when its model is chosen, once, and shows it arriving', async () => {
    const { installer, install, states } = fakeInstaller();
    let files = models;
    const service = new AvatarImageModelService(async () => files, memoryStore(), installer);
    await service.select('checkpoints:novaFurryXL.safetensors');
    expect(install).toHaveBeenCalledWith('sdxl');
    expect((await service.list()).models.find((model) => model.id.includes('nova'))?.poseControl).toBe('installing');
    await service.select('checkpoints:novaFurryXL.safetensors');
    expect(install).toHaveBeenCalledTimes(1);
    states.sdxl = 'done';
    files = [...models, { folder: 'controlnet', name: POSE_CONTROLNETS.sdxl.filename, kind: 'controlnet', family: 'sdxl' }];
    expect((await service.list()).models.find((model) => model.id.includes('nova'))?.poseControl).toBe('guided');
    expect((await service.resolve()).poseControlNet).toBe(POSE_CONTROLNETS.sdxl.filename);
  });

  it('starts the download for the remembered model on listing, but retries a failure only when chosen again', async () => {
    const { installer, install, states } = fakeInstaller();
    const store = memoryStore();
    store.setValue('avatar.imageModel', 'checkpoints:dreamshaper_8.safetensors');
    const service = new AvatarImageModelService(async () => models, store, installer);
    await service.list();
    expect(install).toHaveBeenCalledWith('sd1');
    states.sd1 = 'failed';
    const listed = await service.list();
    expect(install).toHaveBeenCalledTimes(1);
    expect(listed.models.find((model) => model.id.includes('dreamshaper'))?.poseControl).toBe('failed');
    await service.select('checkpoints:dreamshaper_8.safetensors');
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('flags a server that cannot download it, and uses any OpenPose ControlNet already there', async () => {
    const { installer } = fakeInstaller(false);
    const own: ImageModelFile = { folder: 'controlnet', name: 'my/openpose-sd15.safetensors', kind: 'controlnet', family: 'sd1' };
    const depth: ImageModelFile = { folder: 'controlnet', name: 'depth-xl.safetensors', kind: 'controlnet', family: 'sdxl' };
    const service = new AvatarImageModelService(async () => [...models, own, depth], memoryStore(), installer);
    await service.select('checkpoints:novaFurryXL.safetensors');
    const pose = Object.fromEntries((await service.list()).models.map((model) => [model.id, model.poseControl]));
    expect(pose['checkpoints:novaFurryXL.safetensors']).toBe('unavailable');
    expect(pose['checkpoints:dreamshaper_8.safetensors']).toBe('guided');
    expect((await service.resolve('checkpoints:dreamshaper_8.safetensors')).poseControlNet).toBe('my/openpose-sd15.safetensors');
  });

  it('recognises the app’s pose ControlNets by name on a server without the add-on', () => {
    expect(remoteModelKind('controlnet', POSE_CONTROLNETS.sd1.filename)).toBe('controlnet');
    expect(remoteModelKind('controlnet', 'some_other_controlnet.safetensors')).toBeNull();
  });
});
