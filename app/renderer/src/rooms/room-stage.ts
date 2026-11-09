import * as THREE from 'three';
import type { RoomCamera, RoomFile, Vec3 } from '../../../main/src/rooms/types.js';
import { buildRoom, type BuildRoomOptions, type BuiltRoom } from './room-builder.js';
import { RoomNavMesh } from './room-navmesh.js';
import { RoomPhysics } from './room-physics.js';
import { worldTag, type PositionalTag, type WorldTag } from './room-tags.js';

const TMP = new THREE.Vector3();

/**
 * Everything a loaded room needs at run time: scene objects, physics and a navmesh. It never
 * touches a WebGL renderer, so it can be created and stepped in tests. If the physics or navmesh
 * WASM fails to start the room still renders and that feature is simply off.
 */
export class RoomStage {
  private debugOn = false;

  private constructor(
    readonly room: RoomFile,
    private readonly built: BuiltRoom,
    private physics: RoomPhysics | null,
    private navmesh: RoomNavMesh | null,
  ) {}

  static async create(room: RoomFile, options: BuildRoomOptions = {}): Promise<RoomStage> {
    const built = buildRoom(room, options);
    const [physics, navmesh] = await Promise.all([
      RoomPhysics.create(room, built.objectNodes).catch((error: unknown) => {
        console.warn('[rooms] physics is unavailable for this room', error);
        return null;
      }),
      RoomNavMesh.create(room).catch((error: unknown) => {
        console.warn('[rooms] navigation is unavailable for this room', error);
        return null;
      }),
    ]);
    return new RoomStage(room, built, physics, navmesh);
  }

  get group(): THREE.Group {
    return this.built.group;
  }

  get camera(): RoomCamera {
    return this.room.camera;
  }

  get hasPhysics(): boolean {
    return this.physics !== null;
  }

  get hasNavigation(): boolean {
    return this.navmesh !== null;
  }

  homePose(): { position: Vec3; facing: number } {
    return this.room.home;
  }

  findPath(from: Vec3, to: Vec3): Vec3[] | null {
    return this.navmesh?.findPath(from, to) ?? null;
  }

  closestWalkable(p: Vec3): Vec3 {
    return this.navmesh?.closestWalkable(p) ?? p;
  }

  isWalkable(p: Vec3): boolean {
    return this.navmesh?.isWalkable(p) ?? false;
  }

  worldTag(objectId: string, kind: PositionalTag): WorldTag | null {
    return worldTag(this.room, objectId, kind);
  }

  /** Advances physics. The avatar's capsule follows the avatar root's world position. */
  step(dt: number, avatarRoot?: THREE.Object3D | null): void {
    if (!this.physics) return;
    if (avatarRoot) {
      avatarRoot.getWorldPosition(TMP);
      this.physics.setAvatarPosition(TMP.x, TMP.z);
    }
    this.physics.step(dt);
  }

  setDebugNavmesh(on: boolean): void {
    this.debugOn = on;
    if (!this.navmesh) return;
    const overlay = this.navmesh.debugMesh();
    if (on) this.built.group.add(overlay);
    else overlay.removeFromParent();
  }

  get debugNavmesh(): boolean {
    return this.debugOn;
  }

  dispose(): void {
    this.physics?.dispose();
    this.physics = null;
    this.navmesh?.dispose();
    this.navmesh = null;
    this.built.dispose();
  }
}
