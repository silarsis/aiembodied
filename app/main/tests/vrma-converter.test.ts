import { describe, expect, it } from 'vitest';
import { buildVrmAnimation, encodeVrmaGlb } from '../src/avatar/vrma-converter.js';
import type { VrmaSchema } from '../src/avatar/vrma-schema.js';

describe('vrma converter', () => {
  it('builds a VRMAnimation from local bone tracks', () => {
    const definition: VrmaSchema = {
      meta: { name: 'test-wave', fps: 30, loop: true },
      tracks: [
        {
          bone: 'hips',
          keyframes: [
            { t: 0, q: [0, 0, 0, 1] },
            { t: 1, q: [0, 0.2, 0, 0.98] },
          ],
        },
      ],
      hips: {
        position: {
          keyframes: [
            { t: 0, p: [0, 0, 0] },
            { t: 1, p: [0, 0.02, 0] },
          ],
        },
      },
      expressions: [
        {
          name: 'happy',
          keyframes: [
            { t: 0, v: 0 },
            { t: 1, v: 0.4 },
          ],
        },
      ],
    };

    const animation = buildVrmAnimation(definition);
    expect(animation.humanoidTracks.rotation.has('hips')).toBe(true);
    expect(animation.humanoidTracks.translation.has('hips')).toBe(true);
    expect(animation.expressionTracks.preset.has('happy')).toBe(true);
    expect(animation.duration).toBeGreaterThanOrEqual(1);
  });

  it('encodes a VRMA GLB container', () => {
    const definition: VrmaSchema = {
      meta: { name: 'test-wave', fps: 30, loop: true },
      tracks: [
        {
          bone: 'hips',
          keyframes: [
            { t: 0, q: [0, 0, 0, 1] },
            { t: 1, q: [0, 0.2, 0, 0.98] },
          ],
        },
      ],
    };

    const glb = encodeVrmaGlb(definition);
    expect(glb.byteLength).toBeGreaterThan(20);
    expect(glb.subarray(0, 4).toString('utf8')).toBe('glTF');
  });
});
