import * as THREE from 'three';
import type { Vec3 } from '../../../main/src/rooms/types.js';
import { companionHome, measureAvatarHeight, measureSoleLift, placeAtHome } from './avatar-placement.js';

interface Companion {
  root: THREE.Object3D;
  base: { position: THREE.Vector3; rotationY: number; scale: number };
  soleLift: number;
  naturalHeight: number;
}

/**
 * The other avatars standing in a room beside Echo. They only stand: each is put at its slot next to the
 * home point (see companionHome) at the same real-world height as Echo, and put back to its 2D transform
 * when the room goes away. Owned by RoomSceneController.
 */
export class RoomCompanions {
  private readonly entries = new Map<string, Companion>();

  attach(id: string, root: THREE.Object3D | null): void {
    if (!root) {
      this.entries.delete(id);
      return;
    }
    this.entries.set(id, {
      root,
      base: { position: root.position.clone(), rotationY: root.rotation.y, scale: root.scale.x },
      // Measured before placement, while the avatar still stands at its normalised spot.
      soleLift: measureSoleLift(root),
      naturalHeight: measureAvatarHeight(root),
    });
  }

  /** Forgets the avatar; the caller re-places the rest because their slots shift. */
  detach(id: string): void {
    this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Puts every companion at its slot, `targetHeight` metres tall. */
  place(home: { position: Vec3; facing: number }, targetHeight: number): void {
    let index = 0;
    for (const entry of this.entries.values()) {
      const factor = entry.naturalHeight > 0.3 ? targetHeight / entry.naturalHeight : 1;
      const [bx, by, bz] = entry.base.position.toArray();
      const slot = companionHome(home, index++);
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
      entry.root.updateWorldMatrix(true, true);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
