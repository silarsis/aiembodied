import * as THREE from 'three';
import type { RoomCamera, RoomFile, Vec3 } from '../../../main/src/shared/rooms/types.js';
import { buildRoom, type BuildRoomOptions, type BuiltRoom } from './room-builder.js';
import { RoomNavMesh } from './room-navmesh.js';
import { RoomPhysics } from './room-physics.js';
import { modelShapes, objectShapes, type LocalShape } from './room-shapes.js';
import {
  applySeatOverrides,
  seatGeometryLocal,
  seatGeometryToWorld,
  shapeSampler,
  type SurfaceSampler,
  type WorldSeatGeometry,
} from './seat-geometry.js';
import { worldTag, type PositionalTag, type WorldTag } from './room-tags.js';

const TMP = new THREE.Vector3();
const TMP_ORIGIN = new THREE.Vector3();
const TMP_ORIENTATION = new THREE.Quaternion();

/** How far above or below a tag height a measured surface may be (metres): keeps backrests and arms out. */
const SURFACE_BAND = 0.25;

/**
 * Everything a loaded room needs at run time: scene objects, physics and a navmesh. It never
 * touches a WebGL renderer, so it can be created and stepped in tests. If the physics or navmesh
 * WASM fails to start the room still renders and that feature is simply off.
 */
/** Far outside any room; where a capsule waits while its avatar is away. */
const PARKED_AT = 10_000;

export class RoomStage {
  private debugOn = false;
  private navOverlay: THREE.Object3D | null = null;
  private colliderLines: THREE.LineSegments | null = null;

  private constructor(
    readonly room: RoomFile,
    private readonly built: BuiltRoom,
    private physics: RoomPhysics | null,
    private navmesh: RoomNavMesh | null,
  ) {}

  static async create(room: RoomFile, options: BuildRoomOptions = {}): Promise<RoomStage> {
    // A loaded model's mesh becomes the object's collider. The model can arrive before or after the physics world exists.
    let stage: RoomStage | null = null;
    const early = new Map<string, LocalShape[]>();
    const apply = (id: string, shapes: LocalShape[]) => {
      if (stage) stage.physics?.replaceObjectColliders(id, shapes);
      else early.set(id, shapes);
    };
    const { loadModel } = options;
    const built = buildRoom(room, {
      ...options,
      loadModel: loadModel
        ? async (object) => {
            const model = await loadModel(object);
            if (!object.parts?.length && !object.dynamic) {
              const shapes = modelShapes(model);
              if (shapes) apply(object.id, shapes);
            }
            return model;
          }
        : undefined,
    });
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
    stage = new RoomStage(room, built, physics, navmesh);
    for (const [id, shapes] of early) physics?.replaceObjectColliders(id, shapes);
    return stage;
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

  /** The physics world for geometry queries (the contact solver's), or null when it failed to start. */
  get collision(): RoomPhysics | null {
    return this.physics;
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

  /**
   * The height of an object's rendered top surface at world (x, z), measured by casting a ray straight
   * down onto the object's own meshes (nothing else, so an avatar on it is ignored).
   *
   * With `nearY` (a tag height such as a seat's) the ray starts `band` above it and a hit more than `band`
   * below it is rejected, so a backrest or an armrest cannot be taken for the cushion; the result is null
   * when nothing is hit in that band. Without `nearY` the ray starts above the whole bounding box and the
   * first hit wins, falling back to the box top (position.y + size[1]) when the object has no meshes or
   * the point misses them.
   */
  surfaceHeightAt(id: string, x: number, z: number, nearY?: number, band = SURFACE_BAND): number | null {
    const node = this.built.objectNodes.get(id);
    const object = this.room.objects.find((candidate) => candidate.id === id);
    if (!node || !object) return null;
    const boxTop = object.position[1] + object.size[1];
    const from = nearY !== undefined ? nearY + band : boxTop + 0.5;
    node.updateWorldMatrix(true, true);
    const ray = new THREE.Raycaster(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(node, true).find((candidate) => candidate.object instanceof THREE.Mesh);
    if (nearY !== undefined) return hit && hit.point.y >= nearY - band ? hit.point.y : null;
    return hit ? hit.point.y : boxTop;
  }

  /**
   * The seat of an object with a sit tag, in the world as it is now (the object may have been moved or turned).
   * Parts are measured exactly; a model is sampled with rays against its meshes. Null without a sit tag.
   */
  seatGeometry(id: string): WorldSeatGeometry | null {
    const object = this.room.objects.find((candidate) => candidate.id === id);
    const tag = object?.tags?.sit;
    const node = this.built.objectNodes.get(id);
    if (!object || !tag || !node) return null;
    let sample: SurfaceSampler;
    if (object.parts?.length || !object.model) {
      sample = shapeSampler(objectShapes(object));
    } else {
      // Ray-cast in the node's space so the object's pose does not matter.
      node.updateWorldMatrix(true, true);
      const raycaster = new THREE.Raycaster();
      const down = new THREE.Vector3(0, -1, 0);
      const start = new THREE.Vector3();
      sample = (x, z, fromY) => {
        raycaster.set(node.localToWorld(start.set(x, fromY, z)), down.set(0, -1, 0).transformDirection(node.matrixWorld));
        const hit = raycaster.intersectObject(node, true).find((candidate) => candidate.object instanceof THREE.Mesh);
        return hit ? node.worldToLocal(hit.point.clone()).y : null;
      };
    }
    const local = applySeatOverrides(seatGeometryLocal(tag, sample), tag.seat);
    const position = this.objectPosition(id) ?? object.position;
    return seatGeometryToWorld(local, tag, { position, yawDegrees: (this.objectYaw(id) * 180) / Math.PI });
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
    this.refreshColliderLines();
  }

  /** Echo is in another place: her capsule (which cannot be removed) waits far outside the room, out of everyone's way. */
  parkEcho(): void {
    this.physics?.setAvatarPosition(PARKED_AT, PARKED_AT);
  }

  /** An extra avatar left: its physics capsule goes with it. */
  removeAvatar(id: string): void {
    this.physics?.removeAvatar(id);
  }

  setDebugNavmesh(on: boolean): void {
    this.debugOn = on;
    this.navOverlay ??= this.navmesh?.debugMesh() ?? null;
    if (on) {
      if (this.navOverlay) this.built.group.add(this.navOverlay);
      this.refreshColliderLines();
    } else {
      this.navOverlay?.removeFromParent();
      this.colliderLines?.removeFromParent();
    }
  }

  /** The colliders as wireframe, rebuilt every step while the debug overlay is on (props and avatars move). */
  private refreshColliderLines(): void {
    if (!this.debugOn || !this.physics) return;
    const { vertices, colors } = this.physics.debugLines();
    if (!this.colliderLines) {
      const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false });
      this.colliderLines = new THREE.LineSegments(new THREE.BufferGeometry(), material);
      this.colliderLines.name = 'debug:colliders';
      this.colliderLines.frustumCulled = false;
      this.colliderLines.renderOrder = 999;
    }
    const geometry = this.colliderLines.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geometry.computeBoundingSphere();
    if (!this.colliderLines.parent) this.built.group.add(this.colliderLines);
  }

  get debugNavmesh(): boolean {
    return this.debugOn;
  }

  dispose(): void {
    this.colliderLines?.removeFromParent();
    this.colliderLines?.geometry.dispose();
    (this.colliderLines?.material as THREE.Material | undefined)?.dispose();
    this.colliderLines = null;
    this.physics?.dispose();
    this.physics = null;
    this.navmesh?.dispose();
    this.navmesh = null;
    this.built.dispose();
  }
}
