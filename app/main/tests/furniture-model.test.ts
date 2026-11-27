import { describe, expect, it } from 'vitest';
import { glbBounds, parseGlb } from '../src/rooms/asset-library/gltf-bounds.js';
import { bakeTransform, fitBounds, fitGlb } from '../src/furniture/furniture-model.js';
import { boxGlb } from './fixtures/box-glb.js';

describe('fitBounds', () => {
  it('scales uniformly to the height and grounds and centres the footprint', () => {
    const fit = fitBounds({ min: [1, 2, 3], max: [3, 6, 4], size: [2, 4, 1] }, 2);
    expect(fit.scale).toBe(0.5);
    expect(fit.dimensions).toEqual([1, 2, 0.5]);
    expect(fit.offset).toEqual([-1, -1, -1.75]);
  });

  it('refuses a flat model', () => {
    expect(() => fitBounds({ min: [0, 0, 0], max: [1, 0, 1], size: [1, 0, 1] }, 1)).toThrow(
      'no height',
    );
  });
});

describe('fitGlb', () => {
  it('bakes the scale so the file itself measures real metres on y=0', () => {
    const fitted = fitGlb(boxGlb([-1, 1, -2], [1, 3, 2], [0, 5, 0]), 1);
    expect(fitted.scale).toBe(0.5);
    expect(fitted.dimensions).toEqual([1, 1, 2]);
    const bounds = glbBounds(fitted.glb);
    expect(bounds?.size.map((n) => Math.round(n * 1000) / 1000)).toEqual([1, 1, 2]);
    expect(bounds?.min.map((n) => Math.round(n * 1000) / 1000)).toEqual([-0.5, 0, -1]);
    expect(bounds?.max.map((n) => Math.round(n * 1000) / 1000)).toEqual([0.5, 1, 1]);
  });

  it('keeps the binary chunk and the original nodes', () => {
    const fitted = fitGlb(boxGlb([0, 0, 0], [1, 1, 1]), 2);
    const parsed = parseGlb(fitted.glb);
    expect(parsed?.bin?.length).toBe(24);
    const json = parsed?.json as {
      scenes: Array<{ nodes: number[] }>;
      nodes: Array<{ children?: number[] }>;
    };
    expect(json.nodes).toHaveLength(2);
    expect(json.scenes[0].nodes).toEqual([1]);
    expect(json.nodes[1].children).toEqual([0]);
  });

  it('throws on something that is not a model', () => {
    expect(() => fitGlb(Buffer.from('nope'), 1)).toThrow('usable model');
    expect(() => bakeTransform(Buffer.from('nope'), { scale: 1, offset: [0, 0, 0] })).toThrow(
      'valid model',
    );
  });
});
