/**
 * Pose control for the front image: SD1.5 and SDXL models ignore "A-pose" in a prompt often enough
 * to break the rig, so their front is drawn through an OpenPose ControlNet holding a fixed A-pose
 * skeleton. Qwen-Image follows the pose from the prompt; Z-Image has no ControlNet here yet.
 */
import { PNG } from 'pngjs';
import type { ComfyGraph } from './comfyui-client.js';
import type { ImageFamily } from './image-workflows.js';
import type { DownloadPlan } from './model-downloads.js';

/** How a family's front image gets its pose. */
export type PoseSupport = 'controlnet' | 'prompt' | 'none';

export function poseSupport(family: ImageFamily): PoseSupport {
  if (family === 'sd1' || family === 'sdxl') return 'controlnet';
  return family === 'qwen-image-2.1' ? 'prompt' : 'none';
}

interface PoseControlNet {
  /** Saved under this name in ComfyUI's controlnet folder. */
  filename: string;
  title: string;
  baseModel: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** The OpenPose ControlNet the app installs for each family that needs one. */
export const POSE_CONTROLNETS: Record<'sd1' | 'sdxl', PoseControlNet> = {
  sd1: {
    filename: 'control_v11p_sd15_openpose_fp16.safetensors',
    title: 'OpenPose ControlNet (SD 1.5)',
    baseModel: 'SD 1.5',
    url: 'https://huggingface.co/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11p_sd15_openpose_fp16.safetensors',
    sha256: '4003c1da17b0e4ba444e02140e1c0d83bb24b79e4dcfd613c3a554d38f0f89c7',
    bytes: 722_601_100,
  },
  sdxl: {
    filename: 'xinsir_controlnet_openpose_sdxl.safetensors',
    title: 'OpenPose ControlNet (SDXL, xinsir)',
    baseModel: 'SDXL 1.0',
    url: 'https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0/resolve/main/diffusion_pytorch_model.safetensors',
    sha256: 'b8524e557a7df60d081f5d4a0eb109967d107df217943bf88c2d99b9ebcc06c5',
    bytes: 2_502_139_104,
  },
};

export function poseControlNetPlan(family: 'sd1' | 'sdxl'): DownloadPlan {
  const net = POSE_CONTROLNETS[family];
  return {
    title: net.title,
    folder: 'controlnet',
    file: { name: net.filename, downloadUrl: net.url, sha256: net.sha256, sizeKB: net.bytes / 1024 },
    info: { name: net.title, type: 'Controlnet', baseModel: net.baseModel, family },
  };
}

/**
 * The 18 OpenPose (COCO) keypoints of a front-facing adult A-pose, arms 45° from the body. x is
 * from the body's centre line and y down from the top of the head, both as fractions of the
 * figure's height; the figure's right side is on the image's left.
 */
const A_POSE: [number, number][] = [
  [0, 0.085], // nose
  [0, 0.17], // neck
  [-0.105, 0.18], // right shoulder
  [-0.225, 0.3], // right elbow
  [-0.331, 0.406], // right wrist
  [0.105, 0.18], // left shoulder
  [0.225, 0.3], // left elbow
  [0.331, 0.406], // left wrist
  [-0.06, 0.5], // right hip
  [-0.075, 0.72], // right knee
  [-0.085, 0.96], // right ankle
  [0.06, 0.5], // left hip
  [0.075, 0.72], // left knee
  [0.085, 0.96], // left ankle
  [-0.022, 0.065], // right eye
  [0.022, 0.065], // left eye
  [-0.045, 0.072], // right ear
  [0.045, 0.072], // left ear
];
/** OpenPose's limb pairs (keypoint indices) and its colour order, as its annotator draws them. */
const LIMBS: [number, number][] = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10],
  [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
];
const COLOURS: [number, number, number][] = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0],
  [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
  [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
];

/**
 * Where each keypoint lands in a width × height image: centred, up to 88% of the height, and small
 * enough that the hands (about 0.06 of the figure past the wrists) stay inside a 5% margin.
 */
export function poseKeypoints(width: number, height: number): [number, number][] {
  const reach = Math.max(...A_POSE.map(([x]) => Math.abs(x))) + 0.06;
  const figure = Math.min(height * 0.88, (width * 0.9) / (2 * reach));
  const top = (height - figure) * 0.4;
  return A_POSE.map(([x, y]) => [width / 2 + x * figure, top + y * figure]);
}

/** The A-pose skeleton as an OpenPose image (coloured limbs and joints on black). */
export function drawPoseSkeleton(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  const points = poseKeypoints(width, height);
  const stroke = Math.max(4, Math.round(Math.min(width, height) / 128));
  const paint = (x0: number, y0: number, x1: number, y1: number, radius: number, colour: number[]) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSquared = dx * dx + dy * dy || 1;
    for (let y = Math.floor(Math.min(y0, y1) - radius); y <= Math.ceil(Math.max(y0, y1) + radius); y++) {
      for (let x = Math.floor(Math.min(x0, x1) - radius); x <= Math.ceil(Math.max(x0, x1) + radius); x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / lengthSquared));
        if (Math.hypot(x - x0 - t * dx, y - y0 - t * dy) > radius) continue;
        const index = (y * width + x) * 4;
        png.data[index] = colour[0];
        png.data[index + 1] = colour[1];
        png.data[index + 2] = colour[2];
      }
    }
  };
  // Limbs at 60% brightness under full-colour joints, as the OpenPose annotator draws them.
  LIMBS.forEach(([a, b], index) => {
    const [x0, y0] = points[a];
    const [x1, y1] = points[b];
    paint(x0, y0, x1, y1, stroke, COLOURS[index].map((channel) => Math.floor(channel * 0.6)));
  });
  points.forEach(([x, y], index) => paint(x, y, x, y, stroke, COLOURS[index]));
  return PNG.sync.write(png);
}

/** How hard the skeleton holds the pose; released before the end so clothing and detail stay free. */
export const POSE_STRENGTH = 1;
export const POSE_END = 0.65;

/** Route the sampler's conditioning through an OpenPose ControlNet fed the uploaded skeleton image. */
export function applyPoseControl(graph: ComfyGraph, controlNet: string, image: string): ComfyGraph {
  const sampler = Object.values(graph).find((node) => node.class_type === 'KSampler');
  if (!sampler) return graph;
  const result: ComfyGraph = {
    ...graph,
    poseImage: { class_type: 'LoadImage', inputs: { image } },
    poseControlNet: { class_type: 'ControlNetLoader', inputs: { control_net_name: controlNet } },
    poseApply: {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: sampler.inputs.positive,
        negative: sampler.inputs.negative,
        control_net: ['poseControlNet', 0],
        image: ['poseImage', 0],
        strength: POSE_STRENGTH,
        start_percent: 0,
        end_percent: POSE_END,
      },
    },
  };
  sampler.inputs.positive = ['poseApply', 0];
  sampler.inputs.negative = ['poseApply', 1];
  return result;
}
