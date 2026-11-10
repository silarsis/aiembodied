import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JumpDetector } from '../../src/rooms/jump-detector';

function rig() {
  const root = new THREE.Object3D();
  const hips = new THREE.Object3D();
  hips.position.set(0, 0.9, 0);
  const hand = new THREE.Object3D();
  hand.position.set(0.3, -0.1, 0);
  root.add(hips);
  hips.add(hand);
  root.updateMatrixWorld(true);
  return { root, hips, hand };
}

describe('JumpDetector', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stays quiet while the avatar walks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, hips, hand } = rig();
    const detector = new JumpDetector(() => 0);
    detector.track(root, hips, [hand]);
    for (let i = 0; i < 60; i += 1) {
      root.position.z = i * 0.025;
      root.updateMatrixWorld(true);
      expect(detector.check({ clip: 'live-a-0' })).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a one-frame teleport of the pelvis with what was playing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, hips, hand } = rig();
    const detector = new JumpDetector(() => 0);
    detector.track(root, hips, [hand]);
    detector.check({ clip: 'live-a-0', clipTime: 1.9 });
    hips.position.x = 0.8;
    root.updateMatrixWorld(true);
    expect(detector.check({})).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    const detail = JSON.parse(message.slice(message.indexOf('{'))) as { hipsMove: number; before: { clip?: string } };
    expect(detail.hipsMove).toBeCloseTo(0.8, 3);
    expect(detail.before.clip).toBe('live-a-0');
  });

  it('reports a sudden pose change of the hands', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, hips, hand } = rig();
    const detector = new JumpDetector(() => 0);
    detector.track(root, hips, [hand]);
    detector.check();
    hand.position.set(0.3, 0.5, 0.2);
    root.updateMatrixWorld(true);
    expect(detector.check()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores the frame after a reset and caps the reports', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, hips, hand } = rig();
    const detector = new JumpDetector(() => 0);
    detector.track(root, hips, [hand]);
    detector.check();
    detector.reset();
    root.position.x = 5;
    root.updateMatrixWorld(true);
    expect(detector.check()).toBe(false);
    for (let i = 0; i < 30; i += 1) {
      root.position.x = i % 2 === 0 ? 0 : 5;
      root.updateMatrixWorld(true);
      detector.check();
    }
    expect(warn).toHaveBeenCalledTimes(20);
  });
});
