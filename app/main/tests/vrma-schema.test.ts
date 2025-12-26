import { describe, expect, it } from 'vitest';
import { parseVrmaSchema } from '../src/avatar/vrma-schema.js';

describe('vrma schema', () => {
  it('accepts a valid VRMA payload', () => {
    const parsed = parseVrmaSchema({
      meta: {
        name: 'friendly-wave',
        fps: 30,
        loop: true,
        duration: 1.2,
        kind: 'gesture',
      },
      tracks: [
        {
          bone: 'hips',
          keyframes: [
            { t: 0, q: [0, 0, 0, 1] },
            { t: 1, q: [0, 0.1, 0, 0.99] },
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
            { t: 1, v: 0.5 },
          ],
        },
      ],
    });

    expect(parsed.meta.name).toBe('friendly-wave');
    expect(parsed.tracks[0]?.bone).toBe('hips');
  });

  it('rejects non-slug meta names', () => {
    expect(() =>
      parseVrmaSchema({
        meta: { name: 'Friendly Wave', fps: 30, loop: false },
        tracks: [
          {
            bone: 'hips',
            keyframes: [{ t: 0, q: [0, 0, 0, 1] }],
          },
        ],
      }),
    ).toThrow(/slug/i);
  });
});
