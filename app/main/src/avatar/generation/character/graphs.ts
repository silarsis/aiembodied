import template from './trellis2.graph.json' with { type: 'json' };
import type { ComfyGraph } from '../comfyui-client.js';
import { templatePromptGuidance } from '../template-compatibility.js';

/** Image-level hints for a simpler replacement surface, not a mesh-topology guarantee. */
export const faceSurfaceGuidance =
  'Smooth continuous forehead, cheeks, jaw and chin, clearly separated from hair. ' +
  'Hair swept behind the ears and away from cheeks and jaw, with no strands crossing the face. ' +
  'Open eyes with shallow natural eye sockets, lips fully closed with no visible teeth or mouth cavity. ' +
  'Unobstructed face without glasses, face jewellery or face paint. Soft even diffuse lighting without harsh facial shadows';

/** A neutral, separated-limb reference makes this constrained automatic rig possible. */
export function characterConceptPrompt(description: string): string {
  return `Full-body front-view 3D stylised humanoid character design: ${description.trim()}.
One character. ${templatePromptGuidance}. Short or swept-back hair leaving the entire face uncovered.
Clearly visible front-facing human face, neutral expression, open eyes and closed lips. Defined eyelids, eyebrows, nose and lips. Preserve the described facial identity; the face will be fitted for animation locally.
${faceSurfaceGuidance}.
Standing straight in a symmetric A-pose, arms straight at 45 degrees away from the body, hands open and separated from hips, legs straight slightly apart with a clear gap.
Follow the description for clothing or lack of clothing. Keep arms and legs clearly separated; no garments, props or accessories bridging limbs.
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
