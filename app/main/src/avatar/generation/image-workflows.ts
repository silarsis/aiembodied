import { templatePromptGuidance } from './template-compatibility.js';
/** Each supported family owns a workflow; model variants supply filenames, not custom UI. */
import type { ComfyGraph } from './comfyui-client.js';
import { buildConceptPrompt, conceptGraph, CONCEPT_NEGATIVE } from './graphs.js';
import { characterConceptPrompt, faceSurfaceGuidance, faceSurfaceExclusions } from './character/graphs.js';
import { applyPoseControl, applyPoseReference } from './pose-control.js';

export type ImageFamily = 'qwen-image-2.1' | 'z-image-turbo' | 'sdxl' | 'sd1';
export interface ImageWorkflowLora {
  /** File name in ComfyUI's loras folder. */
  name: string;
  /** 0–2; 1 is the LoRA as trained. */
  strength: number;
  triggerWords?: string[];
}
export interface ImageWorkflowModel {
  id: string;
  name: string;
  family: ImageFamily;
  model: string;
  clip?: string;
  vae?: string;
  /** LoRAs of the same family, applied in order right after the model loads. */
  loras?: ImageWorkflowLora[];
  /** The installed OpenPose ControlNet that holds the avatar front's A-pose (SD1.5 and SDXL). */
  poseControlNet?: string;
}

/** The size a checkpoint draws at, which the pose skeleton has to match. */
export function checkpointImageSize(family: 'sd1' | 'sdxl'): { width: number; height: number } {
  return family === 'sd1' ? { width: 512, height: 768 } : { width: 1024, height: 1024 };
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
      inputs: { ...checkpointImageSize(model.family === 'sd1' ? 'sd1' : 'sdxl'), batch_size: 1 },
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
  const loras = model.loras ?? [];
  // LoRAs answer to the words they were trained on, so those lead the prompt.
  const triggers = [...new Set(loras.flatMap((lora) => lora.triggerWords ?? []))].join(', ');
  const graph = workflows[model.family](model, triggers ? `${triggers}, ${prompt}` : prompt, seed);
  return loras.length ? applyLoras(graph, loras) : graph;
}

/**
 * Put a chain of LoRA loaders between the model loader and everything that used it. A checkpoint's
 * LoRAs patch both the model and its text encoder (LoraLoader); a diffusion model's patch the model
 * only (LoraLoaderModelOnly), as its text encoder is a separate file.
 */
export function applyLoras(graph: ComfyGraph, loras: ImageWorkflowLora[]): ComfyGraph {
  const loaderId = Object.keys(graph).find((id) => ['CheckpointLoaderSimple', 'UNETLoader'].includes(graph[id].class_type));
  if (!loaderId) return graph;
  const withClip = graph[loaderId].class_type === 'CheckpointLoaderSimple';
  let model: [string, number] = [loaderId, 0];
  let clip: [string, number] = [loaderId, 1];
  const added: ComfyGraph = {};
  loras.forEach((lora, index) => {
    const id = `lora${index}`;
    const strength = Math.min(2, Math.max(0, lora.strength));
    added[id] = withClip
      ? { class_type: 'LoraLoader', inputs: { model, clip, lora_name: lora.name, strength_model: strength, strength_clip: strength } }
      : { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: lora.name, strength_model: strength } };
    model = [id, 0];
    if (withClip) clip = [id, 1];
  });
  for (const node of Object.values(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value[0] !== loaderId) continue;
      if (value[1] === 0) node.inputs[key] = model;
      else if (withClip && value[1] === 1) node.inputs[key] = clip;
    }
  }
  return { ...graph, ...added };
}

/**
 * CLIP models need positive framing and explicit negatives instead of prose negations. poseImage is
 * the uploaded A-pose skeleton: a model with a pose ControlNet is held to it, and a new character's
 * Qwen-Image front takes it as a reference image.
 */
export function buildAvatarImageWorkflow(
  model: ImageWorkflowModel,
  description: string,
  mode: 'new-character' | 'restyle',
  seed: number,
  poseImage?: string,
): ComfyGraph {
  if (model.family === 'sdxl' || model.family === 'sd1') {
    const compact = `solo, one adult humanoid, full body, front view, symmetrical A-pose, arms straight and spread, legs apart, plain white background, ${description}, ${mode === 'new-character' ? `${templatePromptGuidance}, ${faceSurfaceGuidance}, appearance as described, clear gaps between adjacent body parts, short hair, clearly visible neutral humanoid face, open eyes, closed lips, defined eyelids and eyebrows, matte 3D character render` : 'clean cel shading, character reference'}`;
    const graph = buildImageWorkflow(model, compact, seed);
    graph.negative.inputs.text = `${CONCEPT_NEGATIVE}, multiple characters, character sheet, turnaround, back view, side view, ${mode === 'new-character' ? `${faceSurfaceExclusions}, fused limbs, arms at sides, hands touching thighs, hands on hips, long hair, oversized head, chibi proportions, featureless face, ` : ''}props, scenery, ground shadow`;
    return model.poseControlNet && poseImage ? applyPoseControl(graph, model.poseControlNet, poseImage) : graph;
  }
  const graph = buildImageWorkflow(
    model,
    mode === 'new-character'
      ? characterConceptPrompt(description)
      : buildConceptPrompt(description),
    seed,
  );
  return model.family === 'qwen-image-2.1' && mode === 'new-character' && poseImage
    ? applyPoseReference(graph, poseImage)
    : graph;
}
