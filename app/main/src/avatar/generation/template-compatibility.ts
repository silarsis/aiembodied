import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AvatarGenerationWarning } from '../types.js';

/** Shared with the external Python fitter; packaged assets include this policy. */
export const templatePolicy = JSON.parse(
  readFileSync(
    new URL('../../../assets/avatar-generation/template-policy.json', import.meta.url),
    'utf8',
  ),
) as {
  version: number;
  faceWidthMin: number;
  faceWidthMax: number;
  faceHeightMax: number;
  faceBaseMinHeight: number;
  minimumCutHeight: number;
  headHeightParts: number;
};
export const templatePromptGuidance = `Proportional humanoid anatomy, head about 1/${templatePolicy.headHeightParts} of total height, moderate face width below ${Math.round(templatePolicy.faceWidthMax * 100)}% of full character height, visible neck, shoulders below the neck, clearly separated limbs`;

export async function inspectTemplateCompatibility(
  landmarksPath: string,
): Promise<AvatarGenerationWarning[]> {
  const data = JSON.parse(await readFile(landmarksPath, 'utf8')) as {
    imageSize?: number[];
    bodyBounds?: number[];
    landmarks?: number[][];
  };
  const size = data.imageSize,
    bounds = data.bodyBounds,
    points = data.landmarks?.slice(0, 468);
  if (
    !size ||
    size.length !== 2 ||
    !bounds ||
    bounds.length !== 4 ||
    !points ||
    points.length !== 468 ||
    ![...size, ...bounds].every(Number.isFinite) ||
    size.some((n) => n <= 0) ||
    bounds[3] <= bounds[1] ||
    points.some((point) => point.length !== 3 || !point.every(Number.isFinite))
  )
    throw new Error('Face detection did not return usable reference measurements.');
  const width =
    ((Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]))) * size[0]) /
    (bounds[3] - bounds[1]);
  const height =
    ((Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1]))) * size[1]) /
    (bounds[3] - bounds[1]);
  const warnings: AvatarGenerationWarning[] = [];
  if (width <= templatePolicy.faceWidthMin || width >= templatePolicy.faceWidthMax)
    warnings.push({
      code: 'face-width',
      message: `Detected face width is ${(width * 100).toFixed(1)}% of character height. The tested template range is ${templatePolicy.faceWidthMin * 100}–${templatePolicy.faceWidthMax * 100}%. Head and shoulder placement may be inaccurate.`,
    });
  if (height > templatePolicy.faceHeightMax)
    warnings.push({
      code: 'face-height',
      message: `Detected face height is ${(height * 100).toFixed(1)}% of character height, above the tested ${templatePolicy.faceHeightMax * 100}% limit. The body and head may deform poorly.`,
    });
  const baseHeight =
    (bounds[3] - Math.max(...points.map((p) => p[1])) * size[1]) / (bounds[3] - bounds[1]);
  if (baseHeight < templatePolicy.faceBaseMinHeight)
    warnings.push({
      code: 'face-position',
      message:
        'The face sits lower on the body than the tested template expects. Neck and shoulder joints may be misplaced.',
    });
  return warnings;
}
