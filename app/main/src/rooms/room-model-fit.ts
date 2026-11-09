import type { Bounds } from './asset-library/gltf-bounds.js';
import type { Vec3 } from './types.js';

export const MIN_MODEL_SCALE = 0.5;
export const MAX_MODEL_SCALE = 2;

/**
 * One uniform scale that makes the model's height match the requested height (clamped to 0.5-2x),
 * and the model's real size at that scale. The renderer centres the footprint on the object origin.
 */
export function fitModel(bounds: Bounds, requested: Vec3): { scale: number; size: Vec3 } {
  const height = bounds.size[1];
  const raw = height > 1e-6 ? requested[1] / height : 1;
  const scale = Math.round(Math.min(MAX_MODEL_SCALE, Math.max(MIN_MODEL_SCALE, raw)) * 1000) / 1000;
  return { scale, size: bounds.size.map((n) => Math.max(0.02, Math.round(n * scale * 1000) / 1000)) as Vec3 };
}
