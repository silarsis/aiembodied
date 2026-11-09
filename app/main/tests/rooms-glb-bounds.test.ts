import { describe, expect, it } from 'vitest';
import { glbBounds, parseGlb } from '../src/rooms/asset-library/gltf-bounds.js';
import { makeGlb } from './rooms-glb-fixture.js';

describe('glbBounds', () => {
  it('reads the box from the accessor range', () => {
    const bounds = glbBounds(makeGlb({ min: [-0.5, 0, -0.25], max: [0.5, 2, 0.25] }));
    expect(bounds?.min).toEqual([-0.5, 0, -0.25]);
    expect(bounds?.size).toEqual([1, 2, 0.5]);
  });

  it('measures the vertices when the accessor has no range', () => {
    const bounds = glbBounds(makeGlb({ min: [-1, -2, -3], max: [1, 2, 3], accessorRange: false }));
    expect(bounds?.min).toEqual([-1, -2, -3]);
    expect(bounds?.max).toEqual([1, 2, 3]);
  });

  it('carries node transforms through', () => {
    const bounds = glbBounds(makeGlb({ min: [0, 0, 0], max: [1, 1, 1], node: { scale: [2, 3, 4], translation: [0, 1, 0] } }));
    expect(bounds?.size).toEqual([2, 3, 4]);
    expect(bounds?.min).toEqual([0, 1, 0]);
  });

  it('refuses things that are not a glb', () => {
    expect(glbBounds(Buffer.from('not a model at all, just text'))).toBeNull();
    expect(parseGlb(Buffer.alloc(40))).toBeNull();
    const good = makeGlb({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(glbBounds(good.subarray(0, 40))).toBeNull();
    const wrongVersion = Buffer.from(good);
    wrongVersion.writeUInt32LE(1, 4);
    expect(glbBounds(wrongVersion)).toBeNull();
  });
});
