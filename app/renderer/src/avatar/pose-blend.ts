import * as THREE from 'three';

const TMP = new THREE.Quaternion();

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Eases the body out of a pose that is about to be dropped. `capture` remembers the bones' current
 * rotations; for `duration` seconds after that, `apply` (called once per frame after the mixer and
 * idle motion have written their pose) blends from the remembered rotations to what they wrote,
 * so the arms don't snap from the last frame of a motion to the standing pose in one frame.
 */
export class PoseBlend {
  private from = new Map<THREE.Object3D, THREE.Quaternion>();
  private elapsed = 0;
  private duration = 0;

  get active(): boolean {
    return this.from.size > 0;
  }

  capture(nodes: Iterable<THREE.Object3D | null | undefined>, duration: number): void {
    this.from.clear();
    for (const node of nodes) if (node) this.from.set(node, node.quaternion.clone());
    this.elapsed = 0;
    this.duration = duration;
    if (!(duration > 0)) this.from.clear();
  }

  cancel(): void {
    this.from.clear();
  }

  apply(delta: number): void {
    if (this.from.size === 0) return;
    this.elapsed += Math.max(0, delta);
    const weight = smoothstep(this.elapsed / this.duration);
    if (weight >= 1) {
      this.from.clear();
      return;
    }
    for (const [node, start] of this.from) {
      TMP.copy(node.quaternion);
      node.quaternion.copy(start).slerp(TMP, weight);
    }
  }
}
