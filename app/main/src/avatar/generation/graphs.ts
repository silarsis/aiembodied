/**
 * API-format ComfyUI graphs for local avatar generation, built from the Qwen-Image 2.1
 * templates slopcore uses. Model file names match Comfy Desktop's defaults on Kevin's machine.
 */
import type { ComfyGraph } from './comfyui-client.js';

export interface QwenImageModels {
  unet: string;
  clip: string;
  vae: string;
}

export const DEFAULT_QWEN_IMAGE_MODELS: QwenImageModels = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_int8_convrot.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
};

export const CONCEPT_NEGATIVE =
  'cropped, cut off feet, cut off head, partial body, close-up, multiple views, multiple characters, ' +
  'background scenery, floor shadow, text, watermark, dynamic pose, crossed arms, hands in pockets, blurry';

const TEXTURE_NEGATIVE = 'character, person, face, background scene, text, watermark';

/** Wrap the user's description in the framing the retexture step relies on. */
export function buildConceptPrompt(description: string): string {
  return (
    'Full-body character reference, front view, a stylised anime-style character standing in a neutral ' +
    'A-pose, arms held straight down and slightly away from the body, facing the camera. ' +
    `${description.trim().replace(/\.?$/, '.')} ` +
    'Clean cel shading, simple readable shapes, whole body in frame from the top of the head to the feet ' +
    'with margin around it, centred, plain pure white background, no shadow, no props, no text.'
  );
}

function qwenBase(models: QwenImageModels): ComfyGraph {
  return {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
    cache: { class_type: 'QwenImage21Cache', inputs: { model: ['unet', 0], device: 'auto', dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: 'qwen_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
  };
}

/** Text-to-image concept sheet (no reference images). */
export function conceptGraph(
  prompt: string,
  seed: number,
  { width = 1024, height = 1024, steps = 25, models = DEFAULT_QWEN_IMAGE_MODELS } = {},
): ComfyGraph {
  return {
    ...qwenBase(models),
    encode: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['clip', 0],
        vae: ['vae', 0],
        prompt,
        negative_prompt: CONCEPT_NEGATIVE,
        resolution: 1024,
      },
    },
    latent: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    sample: {
      class_type: 'KSampler',
      inputs: {
        model: ['cache', 0],
        positive: ['encode', 0],
        negative: ['encode', 1],
        latent_image: ['latent', 0],
        seed,
        steps,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1.0,
      },
    },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'aiembodied/concept' } },
  };
}

export interface RetextureGraphInput {
  /** Uploaded atlas crop (full resolution). */
  crop: string;
  cropWidth: number;
  cropHeight: number;
  /** Uploaded concept image. */
  concept: string;
  prompt: string;
  seed: number;
  denoise?: number;
  steps?: number;
  models?: QwenImageModels;
}

/** Long side the crop is sampled at; Qwen-Image works best around 1 MP. */
export const RETEXTURE_SAMPLE_SIZE = 1024;

export function sampleSize(width: number, height: number): { width: number; height: number } {
  const scale = RETEXTURE_SAMPLE_SIZE / Math.max(width, height);
  const snap = (value: number) => Math.max(16, Math.round((value * scale) / 16) * 16);
  return { width: snap(width), height: snap(height) };
}

/**
 * Img2img over one texture-atlas crop: the crop is both the starting latent (so the UV layout
 * survives) and reference image 1; the concept is reference image 2. The result is scaled back
 * to the crop's own size so it can be pasted straight into the atlas.
 */
export function retextureGraph(input: RetextureGraphInput): ComfyGraph {
  const models = input.models ?? DEFAULT_QWEN_IMAGE_MODELS;
  const sample = sampleSize(input.cropWidth, input.cropHeight);
  return {
    ...qwenBase(models),
    cropImage: { class_type: 'LoadImage', inputs: { image: input.crop } },
    ref1: {
      class_type: 'ImageScale',
      inputs: {
        image: ['cropImage', 0],
        upscale_method: 'lanczos',
        width: sample.width,
        height: sample.height,
        crop: 'disabled',
      },
    },
    ref2: { class_type: 'LoadImage', inputs: { image: input.concept } },
    encode: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['clip', 0],
        vae: ['vae', 0],
        prompt: input.prompt,
        negative_prompt: TEXTURE_NEGATIVE,
        resolution: 1024,
        'images.image_1': ['ref1', 0],
        'images.image_2': ['ref2', 0],
      },
    },
    latent: { class_type: 'VAEEncode', inputs: { pixels: ['ref1', 0], vae: ['vae', 0] } },
    sample: {
      class_type: 'KSampler',
      inputs: {
        model: ['cache', 0],
        positive: ['encode', 0],
        negative: ['encode', 1],
        latent_image: ['latent', 0],
        seed: input.seed,
        steps: input.steps ?? 25,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        // 0.7 barely changes the atlas; 1.0 restyles it while the latent keeps the layout.
        denoise: input.denoise ?? 1.0,
      },
    },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    resize: {
      class_type: 'ImageScale',
      inputs: {
        image: ['decode', 0],
        upscale_method: 'lanczos',
        width: input.cropWidth,
        height: input.cropHeight,
        crop: 'disabled',
      },
    },
    save: { class_type: 'SaveImage', inputs: { images: ['resize', 0], filename_prefix: 'aiembodied/retexture' } },
  };
}
