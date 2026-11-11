import * as THREE from 'three';
import type { RoomCamera, RoomFile, Vec3 } from '../../../main/src/rooms/types.js';
import { buildRoom, type BuildRoomOptions, type BuiltRoom } from './room-builder.js';
import { RoomNavMesh } from './room-navmesh.js';
import { RoomPhysics } from './room-physics.js';
import { worldTag, type PositionalTag, type WorldTag } from './room-tags.js';

const TMP = new THREE.Vector3();
const TMP_ORIGIN = new THREE.Vector3();
const TMP_ORIENTATION = new THREE.Quaternion();

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

  /** The scene node of a room object, or undefined. */
  objectNode(id: string): THREE.Object3D | undefined {
    return this.built.objectNodes.get(id);
  }

  /** Where an object's floor-contact origin is in the world right now (it may have been moved or carried). */
  objectPosition(id: string): Vec3 | null {
    const node = this.built.objectNodes.get(id);
    if (!node) return null;
    node.updateWorldMatrix(true, false);
    node.getWorldPosition(TMP_ORIGIN);
    return [TMP_ORIGIN.x, TMP_ORIGIN.y, TMP_ORIGIN.z];
  }

  /** The yaw of an object's node in the world, radians. */
  objectYaw(id: string): number {
    const node = this.built.objectNodes.get(id);
    if (!node) return 0;
    node.updateWorldMatrix(true, false);
    node.getWorldQuaternion(TMP_ORIENTATION);
    return new THREE.Euler().setFromQuaternion(TMP_ORIENTATION, 'YXZ').y;
  }

  /** Marks an object as carried: its body goes kinematic and follows its node each step. */
  setHeld(id: string, held: boolean): void {
    this.physics?.setHeld(id, held);
  }

  /** Puts a carried object down upright at a floor-contact point and lets physics have it again. */
  placeObject(id: string, origin: Vec3, yaw: number): void {
    const node = this.built.objectNodes.get(id);
    if (node) {
      node.position.set(origin[0], origin[1], origin[2]);
      node.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      node.updateMatrixWorld(true);
    }
    this.physics?.place(id, origin, yaw);
  }

  /** The room group, which props are put back under after being carried. */
  get propParent(): THREE.Object3D {
    return this.built.group;
  }

  /** Advances physics. The avatar's capsule follows the avatar root's world position. */
  step(dt: number, avatarRoot?: THREE.Object3D | null, others: ReadonlyArray<{ id: string; root: THREE.Object3D }> = []): void {
    if (!this.physics) return;
    for (const [id, node] of this.built.objectNodes) {
      if (!this.physics.isHeld(id)) continue;
      node.updateWorldMatrix(true, false);
      node.getWorldPosition(TMP_ORIGIN);
      node.getWorldQuaternion(TMP_ORIENTATION);
      this.physics.moveHeld(id, TMP_ORIGIN, TMP_ORIENTATION);
    }
    if (avatarRoot) {
      avatarRoot.getWorldPosition(TMP);
      this.physics.setAvatarPosition(TMP.x, TMP.z);
    }
    for (const other of others) {
      other.root.getWorldPosition(TMP);
      this.physics.setAvatarPosition(TMP.x, TMP.z, other.id);
    }
    this.physics.step(dt);
  }

  /** An extra avatar left: its physics capsule goes with it. */
  removeAvatar(id: string): void {
    this.physics?.removeAvatar(id);
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
