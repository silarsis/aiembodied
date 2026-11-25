import { writeGlb } from '../../src/furniture/furniture-model.js';

/** A one-mesh GLB whose POSITION accessor spans min..max, under a node translated by `shift`. */
export function boxGlb(min: number[], max: number[], shift = [0, 0, 0]): Buffer {
  return writeGlb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation: shift }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ componentType: 5126, count: 2, type: 'VEC3', min, max }],
    },
    Buffer.alloc(24),
  );
}
