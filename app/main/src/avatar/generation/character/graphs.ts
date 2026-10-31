import template from './trellis2.graph.json' with { type: 'json' };
import type { ComfyGraph } from '../comfyui-client.js';

/** A neutral, separated-limb reference makes this constrained automatic rig possible. */
export function characterConceptPrompt(description: string): string {
  return `Full-body front-view 3D stylised humanoid character design: ${description.trim()}.
One character, adult proportions, head occupies about one sixth of total height. Short or swept-back hair leaving the entire face uncovered.
Smooth blank featureless face with a small nose, NO eyes, eyebrows or mouth: animated facial parts will be added in 3D later.
Standing straight in a symmetric A-pose, arms straight at 45 degrees away from the body, hands open and separated from hips, legs straight slightly apart with a clear gap.
Close-fitting clothing with separate sleeves and trouser legs, no skirt, cape, long coat, props or accessories bridging limbs.
Clean matte toy-like surfaces. Entire character including feet in frame with margin, pure white background, no shadow, no scenery, no lettering, no turnaround or second view.`;
}

export function characterMeshGraph(image: string, seed: number): ComfyGraph {
  const graph: ComfyGraph = structuredClone(template);
  graph.image.inputs.image = image;
  for (const node of Object.values(graph)) {
    if (node.class_type === 'KSampler') node.inputs.seed = seed;
  }
  return graph;
}
