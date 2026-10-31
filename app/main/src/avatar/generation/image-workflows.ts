/** Each supported family owns a workflow; model variants supply filenames, not custom UI. */
import type { ComfyGraph } from './comfyui-client.js';
import { buildConceptPrompt, conceptGraph, CONCEPT_NEGATIVE } from './graphs.js';
import { characterConceptPrompt } from './character/graphs.js';

export type ImageFamily = 'qwen-image-2.1' | 'z-image-turbo' | 'sdxl' | 'sd1';
export interface ImageWorkflowModel {
  id: string;
  name: string;
  family: ImageFamily;
  model: string;
  clip?: string;
  vae?: string;
}

function checkpointWorkflow(model: ImageWorkflowModel, prompt: string, seed: number): ComfyGraph {
  return {
    checkpoint: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model.model } },
    positive: { class_type: 'CLIPTextEncode', inputs: { clip: ['checkpoint', 1], text: prompt } },
    negative: {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['checkpoint', 1], text: CONCEPT_NEGATIVE },
    },
    latent: {
      class_type: 'EmptyLatentImage',
      inputs: {
        width: model.family === 'sd1' ? 512 : 1024,
        height: model.family === 'sd1' ? 768 : 1024,
        batch_size: 1,
      },
    },
    sample: {
      class_type: 'KSampler',
      inputs: {
        model: ['checkpoint', 0],
        positive: ['positive', 0],
        negative: ['negative', 0],
        latent_image: ['latent', 0],
        seed,
        steps: 25,
        cfg: model.family === 'sd1' ? 7 : 6,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
      },
    },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['checkpoint', 2] } },
    save: {
      class_type: 'SaveImage',
      inputs: { images: ['decode', 0], filename_prefix: 'aiembodied/concept' },
    },
  };
}

const workflows: Record<
  ImageFamily,
  (model: ImageWorkflowModel, prompt: string, seed: number) => ComfyGraph
> = {
  'qwen-image-2.1': (model, prompt, seed) => {
    if (!model.clip || !model.vae)
      throw new Error('Required image-model components are unavailable.');
    return conceptGraph(prompt, seed, {
      models: { unet: model.model, clip: model.clip, vae: model.vae },
    });
  },
  'z-image-turbo': (model, prompt, seed) => {
    if (!model.clip || !model.vae)
      throw new Error('Required image-model components are unavailable.');
    return {
      model: {
        class_type: 'UNETLoader',
        inputs: { unet_name: model.model, weight_dtype: 'default' },
      },
      sampling: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['model', 0], shift: 3 } },
      clip: {
        class_type: 'CLIPLoader',
        inputs: { clip_name: model.clip, type: 'lumina2', device: 'default' },
      },
      vae: { class_type: 'VAELoader', inputs: { vae_name: model.vae } },
      positive: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: prompt } },
      negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive', 0] } },
      latent: {
        class_type: 'EmptySD3LatentImage',
        inputs: { width: 1024, height: 1024, batch_size: 1 },
      },
      sample: {
        class_type: 'KSampler',
        inputs: {
          model: ['sampling', 0],
          positive: ['positive', 0],
          negative: ['negative', 0],
          latent_image: ['latent', 0],
          seed,
          steps: 8,
          cfg: 1,
          sampler_name: 'res_multistep',
          scheduler: 'simple',
          denoise: 1,
        },
      },
      decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
      save: {
        class_type: 'SaveImage',
        inputs: { images: ['decode', 0], filename_prefix: 'aiembodied/concept' },
      },
    };
  },
  sdxl: checkpointWorkflow,
  sd1: checkpointWorkflow,
};

export function buildImageWorkflow(
  model: ImageWorkflowModel,
  prompt: string,
  seed: number,
): ComfyGraph {
  return workflows[model.family](model, prompt, seed);
}

/** CLIP models need positive framing and explicit negatives instead of prose negations. */
export function buildAvatarImageWorkflow(
  model: ImageWorkflowModel,
  description: string,
  mode: 'new-character' | 'restyle',
  seed: number,
): ComfyGraph {
  if (model.family === 'sdxl' || model.family === 'sd1') {
    const compact = `solo, one adult humanoid, full body, front view, symmetrical A-pose, arms straight and spread, legs apart, plain white background, ${description}, ${mode === 'new-character' ? 'close-fitting clothes, short hair, smooth featureless face, matte 3D character render' : 'clean cel shading, character reference'}`;
    const graph = buildImageWorkflow(model, compact, seed);
    graph.negative.inputs.text = `${CONCEPT_NEGATIVE}, multiple characters, character sheet, turnaround, back view, side view, ${mode === 'new-character' ? 'cape, skirt, long coat, long hair, eyes, eyebrows, mouth, ' : ''}props, scenery, ground shadow`;
    return graph;
  }
  return buildImageWorkflow(
    model,
    mode === 'new-character'
      ? characterConceptPrompt(description)
      : buildConceptPrompt(description),
    seed,
  );
}
