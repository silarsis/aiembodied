import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MAX_SOLE_LIFT, measureSoleLift, placeAtHome } from '../../src/rooms/avatar-placement.js';

/** An avatar normalised the 2D way: ankles on y = 0, so the boot box reaches below it. */
function avatar(soleY: number, extra?: (root: THREE.Group) => void): THREE.Group {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.3));
  body.position.y = soleY + 0.8;
  root.add(body);
  extra?.(root);
  return root;
}

describe('measureSoleLift', () => {
  it('raises the avatar by how far its soles sit under y = 0', () => {
    expect(measureSoleLift(avatar(-0.08))).toBeCloseTo(0.08);
  });

  it('never lowers an avatar whose soles are already above the line', () => {
    expect(measureSoleLift(avatar(0.02))).toBe(0);
  });

  it('ignores hidden meshes and clamps stray geometry far below the feet', () => {
    const hidden = avatar(-0.05, (root) => {
      const stray = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
      stray.position.y = -3;
      stray.visible = false;
      root.add(stray);
    });
    expect(measureSoleLift(hidden)).toBeCloseTo(0.05);
    expect(measureSoleLift(avatar(-1))).toBe(MAX_SOLE_LIFT);
  });

  it('follows the root position and scale', () => {
    const root = avatar(-0.1);
    root.scale.setScalar(0.5);
    expect(measureSoleLift(root)).toBeCloseTo(0.05);
  });
});

describe('placeAtHome', () => {
  it('adds the home height to the base offset', () => {
    const placed = placeAtHome({ position: [0, -0.08, 0], rotationY: 0 }, { position: [1, 0.08, 2], facing: 0 });
    expect(placed.position[1]).toBeCloseTo(0);
  });
});
