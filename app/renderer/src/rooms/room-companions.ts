import * as THREE from 'three';
import type { Vec3 } from '../../../main/src/rooms/types.js';
import type { AvatarRig } from './scene-env.js';
import { companionHome, measureAvatarHeight, measureSoleLift, placeAtHome } from './avatar-placement.js';

interface Companion {
  root: THREE.Object3D;
  base: { position: THREE.Vector3; rotationY: number; scale: number };
  soleLift: number;
  naturalHeight: number;
  /** The hands and pelvis for scene actions; absent when the model gave no humanoid. */
  rig: AvatarRig | null;
  /** Which place beside the home point is this avatar's; kept while it is attached so others do not shift. */
  slot: number;
  /** True once it has been put at its slot in the current room; it may have walked off since. */
  placed: boolean;
}

/**
 * The other avatars standing in a room beside Echo. They only stand: each is put at its slot next to the
 * home point (see companionHome) at the same real-world height as Echo, and put back to its 2D transform
 * when the room goes away. Owned by RoomSceneController.
 */
export class RoomCompanions {
  private readonly entries = new Map<string, Companion>();

  attach(id: string, root: THREE.Object3D | null, humanoid?: AvatarRig['humanoid'] | null, restHipsHeight = 0): void {
    if (!root) {
      this.entries.delete(id);
      return;
    }
    const taken = new Set([...this.entries].filter(([other]) => other !== id).map(([, entry]) => entry.slot));
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    this.entries.set(id, {
      slot,
      placed: false,
      root,
      base: { position: root.position.clone(), rotationY: root.rotation.y, scale: root.scale.x },
      // Measured before placement, while the avatar still stands at its normalised spot.
      soleLift: measureSoleLift(root),
      naturalHeight: measureAvatarHeight(root),
      rig: humanoid ? { scene: root, baseRotationY: root.rotation.y, humanoid, restHipsHeight } : null,
    });
  }

  rigOf(id: string): AvatarRig | null {
    return this.entries.get(id)?.rig ?? null;
  }

  /**
   * Stands the avatar at a world point turned to a world yaw (radians), as the executor's bake does. It counts
   * as placed, so a later `place(..., false)` does not pull it back to its slot.
   */
  placeAtPoint(id: string, x: number, z: number, yaw: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.placed = true;
    entry.root.position.x = x;
    entry.root.position.z = z;
    entry.root.rotation.y = entry.base.rotationY + yaw;
    entry.root.updateWorldMatrix(true, true);
    return true;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** The scene root and (when the model has one) the hips of each companion, for the physics capsules. */
  bodies(): Array<{ id: string; root: THREE.Object3D }> {
    return [...this.entries].map(([id, entry]) => ({
      id,
      root: entry.rig?.humanoid.getNormalizedBoneNode('hips') ?? entry.root,
    }));
  }

  /** Forgets the avatar; the others keep their slots and stay where they are. */
  detach(id: string): void {
    this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Puts companions at their slots, `targetHeight` metres tall. Without `all`, only those not yet placed in
   * this room (a late arrival), so one that has walked somewhere is not pulled back.
   */
  place(home: { position: Vec3; facing: number }, targetHeight: number, all = true): void {
    for (const entry of this.entries.values()) {
      if (entry.placed && !all) continue;
      entry.placed = true;
      const factor = entry.naturalHeight > 0.3 ? targetHeight / entry.naturalHeight : 1;
      const [bx, by, bz] = entry.base.position.toArray();
      const slot = companionHome(home, entry.slot);
      const placed = placeAtHome(
        { position: [bx * factor, by * factor, bz * factor], rotationY: entry.base.rotationY },
        { position: [slot.position[0], slot.position[1] + entry.soleLift * factor, slot.position[2]], facing: slot.facing },
      );
      entry.root.scale.setScalar(entry.base.scale * factor);
      entry.root.position.set(...placed.position);
      entry.root.rotation.y = placed.rotationY;
      entry.root.updateWorldMatrix(true, true);
    }
  }

  /** Back to the 2D transform recorded when each was attached. */
  restore(): void {
    for (const entry of this.entries.values()) {
      entry.root.position.copy(entry.base.position);
      entry.root.rotation.y = entry.base.rotationY;
      entry.root.scale.setScalar(entry.base.scale);
      entry.placed = false;
      entry.root.updateWorldMatrix(true, true);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
