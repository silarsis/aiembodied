import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { pinHipsHorizontal } from '../../src/avatar/hips-pinning.js';
import { placeAtHome } from '../../src/rooms/avatar-placement.js';

const rounded = (values: ArrayLike<number>) => Array.from(values, (v) => Math.round(v * 1e4) / 1e4);

describe('pinHipsHorizontal', () => {
  const clip = () =>
    new THREE.AnimationClip('walk', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0.2, 0.9, 0.5, 1.5, 0.95, -2]),
      new THREE.VectorKeyframeTrack('Spine.position', [0, 1], [1, 1, 1, 2, 2, 2]),
      new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);

  it('zeroes x and z on the hips position track and keeps y', () => {
    const pinned = pinHipsHorizontal(clip(), 'Hips');
    expect(rounded(pinned.tracks[0].values)).toEqual([0, 0.9, 0, 0, 0.95, 0]);
  });

  it('leaves other tracks alone', () => {
    const pinned = pinHipsHorizontal(clip(), 'Hips');
    expect(rounded(pinned.tracks[1].values)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(rounded(pinned.tracks[2].values)).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('does nothing without a hips node name or a matching track', () => {
    const untouched = pinHipsHorizontal(clip(), undefined);
    expect(rounded(untouched.tracks[0].values)).toEqual([0.2, 0.9, 0.5, 1.5, 0.95, -2]);
    const other = pinHipsHorizontal(clip(), 'Pelvis');
    expect(rounded(other.tracks[0].values)).toEqual([0.2, 0.9, 0.5, 1.5, 0.95, -2]);
  });
});

describe('placeAtHome', () => {
  it('moves the body to home and turns the pivot offset with the facing', () => {
    const base = { position: [0.1, 0, 0.2] as [number, number, number], rotationY: Math.PI };
    const same = placeAtHome(base, { position: [1, 0, -2], facing: 0 });
    expect(same.position[0]).toBeCloseTo(1.1);
    expect(same.position[2]).toBeCloseTo(-1.8);
    expect(same.rotationY).toBeCloseTo(Math.PI);
    const turned = placeAtHome(base, { position: [0, 0, 0], facing: 90 });
    expect(turned.position[0]).toBeCloseTo(0.2);
    expect(turned.position[2]).toBeCloseTo(-0.1);
    expect(turned.rotationY).toBeCloseTo(Math.PI + Math.PI / 2);
  });
});
