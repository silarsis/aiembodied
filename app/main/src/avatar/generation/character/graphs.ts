import template from './trellis2.graph.json' with { type: 'json' };
import type { ComfyGraph } from '../comfyui-client.js';
import type { GeometryModel } from '../character-model-service.js';
import { templatePromptGuidance } from '../template-compatibility.js';

/** Image-level hints for a simpler replacement surface, not a mesh-topology guarantee. */
export const faceSurfaceGuidance =
  'Smooth continuous forehead, cheeks, jaw and chin, clearly separated from hair. ' +
  'Hair swept behind the ears and away from cheeks and jaw, fully visible facial contours. ' +
  'Open eyes with shallow natural eye sockets, lips fully closed. ' +
  'Clear unobstructed facial features. Soft even diffuse lighting';

export const faceSurfaceExclusions =
  'hair strands crossing the face, hair covering cheeks or jaw, visible teeth, open mouth, mouth cavity, ' +
  'deep eye sockets, glasses, face jewellery, face paint, harsh facial shadows';

/** A neutral, separated-limb reference makes this constrained automatic rig possible. */
export function characterConceptPrompt(description: string): string {
  return `Full-body front-view 3D stylised humanoid character design: ${description.trim()}.
One character. ${templatePromptGuidance}. Short or swept-back hair leaving the entire face uncovered.
Clearly visible front-facing human face, neutral expression, open eyes and closed lips. Defined eyelids, eyebrows, nose and lips. Preserve the described facial identity; the face will be fitted for animation locally.
${faceSurfaceGuidance}. Avoid ${faceSurfaceExclusions}.
Standing straight in a symmetric A-pose, arms straight at 45 degrees away from the body, hands open and separated from hips, legs straight slightly apart with a clear gap.
Follow the description for the character's appearance. Keep arms and legs clearly separated, with clear gaps between adjacent body parts.
Clean matte toy-like surfaces. Entire character including feet in frame with margin, pure white background, no shadow, no scenery, no lettering, no turnaround or second view.`;
}

/** The approved front image plus, for multi-view models, the drawn side and back views (uploaded names). */
export interface CharacterViewImages {
  front: string;
  /** The character's left side: it faces the left edge of the image. */
  left?: string;
  back?: string;
}

export function characterMeshGraph(
  images: CharacterViewImages,
  seed: number,
  geometry?: GeometryModel,
): ComfyGraph {
  if (geometry?.kind === 'hunyuan3d-2mv') return hunyuanMultiViewGraph(images, seed, geometry.checkpoint);
  // TRELLIS.2 takes one image, so it is only ever given the front.
  const graph: ComfyGraph = structuredClone(template);
  graph.image.inputs.image = images.front;
  if (geometry) {
    graph.unet.inputs.unet_name = geometry.unet;
    graph.shape_vae.inputs.vae_name = geometry.shapeVae;
    graph.tex_vae.inputs.vae_name = geometry.textureVae;
  }
  for (const node of Object.values(graph)) {
    if (node.class_type === 'KSampler') node.inputs.seed = seed;
  }
  return graph;
}

/**
 * Hunyuan3D 2mv in ComfyUI core: each view is cut out and centred on white with a margin (as
 * Hunyuan's own preprocessing does), encoded by the checkpoint's image encoder, and the views are
 * combined by position (front, left, back). The result is an untextured shape; the views are
 * painted onto it afterwards.
 */
export function hunyuanMultiViewGraph(
  images: CharacterViewImages,
  seed: number,
  checkpoint: string,
): ComfyGraph {
  const graph: ComfyGraph = {
    checkpoint: { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: checkpoint } },
    bg_model: {
      class_type: 'LoadBackgroundRemovalModel',
      inputs: { bg_removal_name: 'birefnet.safetensors' },
    },
  };
  const views: Partial<Record<'front' | 'left' | 'back', [string, number]>> = {};
  for (const view of ['front', 'left', 'back'] as const) {
    const image = images[view];
    if (!image) continue;
    graph[`${view}_image`] = { class_type: 'LoadImage', inputs: { image } };
    graph[`${view}_mask`] = {
      class_type: 'RemoveBackground',
      inputs: { bg_removal_model: ['bg_model', 0], image: [`${view}_image`, 0] },
    };
    graph[`${view}_crop`] = {
      class_type: 'ImageCropToMask',
      inputs: {
        images: [`${view}_image`, 0],
        masks: [`${view}_mask`, 0],
        width: 512,
        height: 512,
        // Hunyuan leaves 15% of the frame empty around the object.
        pad_factor: 1.18,
        grow_mask: 0,
        background: '#FFFFFF',
      },
    };
    graph[`${view}_encode`] = {
      class_type: 'CLIPVisionEncode',
      inputs: { clip_vision: ['checkpoint', 1], image: [`${view}_crop`, 0], crop: 'none' },
    };
    views[view] = [`${view}_encode`, 0];
  }
  return {
    ...graph,
    cond: { class_type: 'Hunyuan3Dv2ConditioningMultiView', inputs: views },
    latent: { class_type: 'EmptyLatentHunyuan3Dv2', inputs: { resolution: 3072, batch_size: 1 } },
    sample: {
      class_type: 'KSampler',
      inputs: {
        model: ['checkpoint', 0],
        positive: ['cond', 0],
        negative: ['cond', 1],
        latent_image: ['latent', 0],
        seed,
        steps: 30,
        cfg: 5,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
      },
    },
    decode: {
      class_type: 'VAEDecodeHunyuan3D',
      inputs: { samples: ['sample', 0], vae: ['checkpoint', 2], num_chunks: 8000, octree_resolution: 256 },
    },
    voxels: {
      class_type: 'VoxelToMesh',
      inputs: { voxel: ['decode', 0], algorithm: 'surface net', threshold: 0.6 },
    },
    decimate: {
      class_type: 'DecimateMesh',
      inputs: { mesh: ['voxels', 0], target_face_count: 60000, placement_mode: 'midpoint' },
    },
    save: {
      class_type: 'SaveGLB',
      inputs: { mesh: ['decimate', 0], filename_prefix: 'aiembodied/new-character' },
    },
  };
}

const VIEW_FRAMING =
  'Keep the exact same character: same face, hair, outfit, colours, materials, proportions and art style. ' +
  'Same symmetric A-pose, arms straight and held away from the body, legs straight and slightly apart. ' +
  'Orthographic camera at the same height and distance, whole body from the top of the head to the feet with margin, ' +
  'centred, pure white background, no shadow, no scenery, one character only, no text.';

/** What to draw for each extra view, as an edit of the approved front image. */
export const CHARACTER_VIEW_PROMPTS: Record<'left' | 'back', { prompt: string; negative: string }> = {
  left: {
    prompt:
      'Turn this character 90 degrees to show their left side: a strict side profile view, the character facing the left edge of the image. ' +
      VIEW_FRAMING,
    negative:
      'front view, back view, three-quarter view, facing the viewer, facing right, turnaround sheet, multiple views, multiple characters, cropped, cut off feet, scenery, floor shadow, text, watermark',
  },
  back: {
    prompt:
      'Turn this character around to show them from directly behind: a back view showing the back of the head, hair and outfit, no face visible. ' +
      VIEW_FRAMING,
    negative:
      'front view, side view, face, eyes, facing the viewer, turnaround sheet, multiple views, multiple characters, cropped, cut off feet, scenery, floor shadow, text, watermark',
  },
};
