/**
 * Leg proportions of an avatar, measured from the offsets between its normalized leg bones (which keep their rest
 * offsets whatever the animation does), in the avatar's own metres.
 */
import type { RestLegLengths } from './scene-actions.js';

interface BoneNode {
  position: { x: number; y: number; z: number };
}

export interface LegBones {
  getNormalizedBoneNode(name: string): BoneNode | null | undefined;
}

const MIN_ANKLE_HEIGHT = 0.03;
const MAX_ANKLE_HEIGHT = 0.15;

const length = (p: BoneNode['position']): number => Math.hypot(p.x, p.y, p.z);

/**
 * Thigh (hip to knee), shin (knee to ankle) and ankle height. The ankle height is what is left of the standing
 * hips height once the hip's drop below the pelvis and both leg segments are taken off, clamped to a plausible
 * range. Null when the bones are missing or give nonsense.
 */
export function measureRestLegLengths(humanoid: LegBones, restHipsHeight: number): RestLegLengths | null {
  const upper = humanoid.getNormalizedBoneNode('leftUpperLeg');
  const lower = humanoid.getNormalizedBoneNode('leftLowerLeg');
  const foot = humanoid.getNormalizedBoneNode('leftFoot');
  if (!upper || !lower || !foot) return null;
  const thigh = length(lower.position);
  const shin = length(foot.position);
  if (!(thigh > 0.1 && thigh < 1.5 && shin > 0.1 && shin < 1.5)) return null;
  const hipDrop = Math.max(0, -upper.position.y);
  const rawAnkle = restHipsHeight - hipDrop - thigh - shin;
  const ankleHeight = Math.min(MAX_ANKLE_HEIGHT, Math.max(MIN_ANKLE_HEIGHT, Number.isFinite(rawAnkle) ? rawAnkle : 0));
  return { thigh, shin, ankleHeight };
}
