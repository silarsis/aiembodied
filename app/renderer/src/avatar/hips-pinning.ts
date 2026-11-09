import * as THREE from 'three';

/**
 * Live motion clips carry the generated root translation. On a 2D backdrop the avatar must stay
 * on its spot, so the hips' horizontal translation is flattened to zero while the height is kept.
 * In a 3D room the translation is left alone (a later step turns it into root motion).
 *
 * Mutates and returns the clip. `hipsNodeName` is the name of the animated hips node.
 */
export function pinHipsHorizontal(clip: THREE.AnimationClip, hipsNodeName: string | undefined | null): THREE.AnimationClip {
  if (!hipsNodeName) return clip;
  const trackName = `${hipsNodeName}.position`;
  for (const track of clip.tracks) {
    if (track.name !== trackName) continue;
    const values = track.values;
    for (let i = 0; i + 2 < values.length; i += 3) {
      values[i] = 0;
      values[i + 2] = 0;
    }
  }
  return clip;
}
