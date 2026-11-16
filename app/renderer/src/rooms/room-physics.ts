import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import { objectShapes, type LocalShape } from './room-shapes.js';
import { WALL_THICKNESS, colliderObjects, degToRad, wallPieces, windowBlockers, type WallName } from './room-geometry.js';

export const AVATAR_RADIUS = 0.25;
export const AVATAR_HEIGHT = 1.6;
const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_CALL = 5;
const WALLS: WallName[] = ['north', 'south', 'east', 'west'];

let initialised: Promise<void> | null = null;
/** Rapier's WASM is loaded once for the whole page. */
export function initPhysics(): Promise<void> {
  initialised ??= RAPIER.init().catch((error: unknown) => {
    initialised = null;
    throw error;
  });
  return initialised;
}

/** The deepest overlap between a query shape and fixed geometry. */
export interface PenetrationHit {
  /** The room object that was hit, or null for the shell (floor, walls, ceiling). */
  objectId: string | null;
  /** Metres the shapes overlap (>0). */
  depth: number;
  /** Direction to push the query shape to get out. */
  normal: { x: number; y: number; z: number };
  /** Contact point on the fixed collider. */
  point: { x: number; y: number; z: number };
}

interface DynamicBody {
  id: string;
  body: RAPIER.RigidBody;
  node: THREE.Object3D;
  halfHeight: number;
}

export class RoomPhysics {
  private readonly world: RAPIER.World;
  private readonly avatar: RAPIER.RigidBody;
  /** Capsules of the other avatars in the room, by id (made on first use). Kinematic: they never collide with each other. */
  private readonly otherAvatars = new Map<string, RAPIER.RigidBody>();
  private readonly dynamics: DynamicBody[] = [];
  private readonly bodies = new Map<string, RAPIER.RigidBody>();
  private readonly held = new Set<string>();
  /** Fixed colliders (shell and furniture) by handle: the owning object's id, or null for the shell. */
  private readonly fixedOwners = new Map<number, string | null>();
  /** The body and colliders of each fixed object, so a loaded model can swap its shapes. */
  private readonly fixedObjects = new Map<string, { body: RAPIER.RigidBody; colliders: RAPIER.Collider[] }>();
  /** Colliders were added since the last step; Rapier's query structures only see them after a step. */
  private queriesStale = true;
  private accumulator = 0;
  private disposed = false;

  private constructor(room: RoomFile, nodes: Map<string, THREE.Object3D>) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const { shell } = room;
    const fixed = (center: readonly number[], size: readonly number[], yaw = 0) => {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(center[0], center[1], center[2])
          .setRotation(yawQuaternion(yaw)),
      );
      const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2).setFriction(0.8), body);
      this.fixedOwners.set(collider.handle, null);
    };

    fixed([0, -0.25, 0], [shell.width + 2 * WALL_THICKNESS, 0.5, shell.depth + 2 * WALL_THICKNESS]);
    fixed([0, shell.height + 0.25, 0], [shell.width + 2 * WALL_THICKNESS, 0.5, shell.depth + 2 * WALL_THICKNESS]);
    // Wall pieces leave door openings empty, so doors are passable. Windows are closed off.
    for (const wall of WALLS) for (const piece of wallPieces(shell, wall)) fixed(piece.center, piece.size);
    for (const blocker of windowBlockers(shell)) fixed(blocker.center, blocker.size);

    for (const object of colliderObjects(room, () => true)) {
      const yaw = degToRad(object.rotationY ?? 0);
      const [width, height, depth] = object.size;
      const center: [number, number, number] = [object.position[0], object.position[1] + height / 2, object.position[2]];
      if (object.dynamic) {
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(...center)
            .setRotation(yawQuaternion(yaw))
            .setLinearDamping(0.1)
            .setAngularDamping(0.5),
        );
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2).setDensity(400).setFriction(0.8).setRestitution(0.05),
          body,
        );
        this.bodies.set(object.id, body);
        const node = nodes.get(object.id);
        if (node) this.dynamics.push({ id: object.id, body, node, halfHeight: height / 2 });
      } else {
        // The body sits at the object's origin so its shapes keep their object-local placement.
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(...object.position).setRotation(yawQuaternion(yaw)),
        );
        const entry = { body, colliders: [] as RAPIER.Collider[] };
        this.fixedObjects.set(object.id, entry);
        this.addShapes(object.id, entry, objectShapes(object));
      }
    }

    // The avatar is driven by animation, so it is a kinematic capsule that can shove props.
    this.avatar = this.createAvatarBody();
  }

  private addShapes(id: string, entry: { body: RAPIER.RigidBody; colliders: RAPIER.Collider[] }, shapes: readonly LocalShape[]): void {
    for (const shape of shapes) {
      let desc: RAPIER.ColliderDesc | null;
      switch (shape.kind) {
        case 'cuboid':
          desc = RAPIER.ColliderDesc.cuboid(...shape.halfExtents);
          break;
        case 'cylinder':
          desc = RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
          break;
        case 'ball':
          desc = RAPIER.ColliderDesc.ball(shape.radius);
          break;
        case 'trimesh':
          desc = RAPIER.ColliderDesc.trimesh(shape.vertices, shape.indices);
          break;
      }
      if (!desc) continue;
      desc.setTranslation(...shape.translation).setRotation(shape.rotation).setFriction(0.8);
      const collider = this.world.createCollider(desc, entry.body);
      entry.colliders.push(collider);
      this.fixedOwners.set(collider.handle, id);
    }
  }

  /**
   * Swaps the colliders of a fixed object for new shapes (e.g. a loaded model's mesh). Does nothing for
   * dynamic objects, `collider: 'none'` objects and unknown ids. Returns whether the swap happened.
   */
  replaceObjectColliders(objectId: string, shapes: readonly LocalShape[]): boolean {
    const entry = this.fixedObjects.get(objectId);
    if (!entry || this.disposed || shapes.length === 0) return false;
    for (const collider of entry.colliders) {
      this.fixedOwners.delete(collider.handle);
      this.world.removeCollider(collider, false);
    }
    entry.colliders = [];
    this.addShapes(objectId, entry, shapes);
    this.queriesStale = true;
    return true;
  }

  /** The object a fixed collider belongs to (null for the shell or an unknown handle). */
  objectOfCollider(handle: number): string | null {
    return this.fixedOwners.get(handle) ?? null;
  }

  /**
   * Height of the first fixed surface straight below (x, fromY, z), or null if none. Start above the thing
   * being measured: a start inside a collider answers `fromY`. `objectId` limits it to that object.
   */
  surfaceAt(x: number, z: number, fromY: number, objectId?: string): number | null {
    if (this.disposed) return null;
    this.refreshQueries();
    const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, fromY + 10, true, undefined, undefined, undefined, undefined, (collider) =>
      this.isFixedOf(collider.handle, objectId),
    );
    return hit ? fromY - hit.timeOfImpact : null;
  }

  /**
   * Deepest overlap of `shape` (e.g. a capsule) at a pose with the fixed furniture, walls, floor and ceiling.
   * Avatars and props are never considered. `exclude` skips those objects. Null when nothing overlaps.
   */
  penetration(
    shape: RAPIER.Shape,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number } = { x: 0, y: 0, z: 0, w: 1 },
    exclude?: string | readonly string[],
  ): PenetrationHit | null {
    if (this.disposed) return null;
    this.refreshQueries();
    const skipped = typeof exclude === 'string' ? [exclude] : (exclude ?? []);
    let best: PenetrationHit | null = null;
    this.world.intersectionsWithShape(
      position,
      rotation,
      shape,
      (collider) => {
        const owner = this.fixedOwners.get(collider.handle) ?? null;
        if (owner !== null && skipped.includes(owner)) return true;
        const contact = collider.contactShape(shape, position, rotation, 0);
        if (contact && contact.distance < 0 && (!best || -contact.distance > best.depth)) {
          best = {
            objectId: owner,
            depth: -contact.distance,
            normal: { x: contact.normal1.x, y: contact.normal1.y, z: contact.normal1.z },
            point: { x: contact.point1.x, y: contact.point1.y, z: contact.point1.z },
          };
        }
        return true;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      (collider) => this.fixedOwners.has(collider.handle),
    );
    return best;
  }

  /** Brings the broadphase up to date with a zero-length step, so queries before the first real step still see the colliders. */
  private refreshQueries(): void {
    if (!this.queriesStale) return;
    this.queriesStale = false;
    const timestep = this.world.timestep;
    this.world.timestep = 0;
    this.world.step();
    this.world.timestep = timestep;
  }

  private isFixedOf(handle: number, objectId?: string): boolean {
    if (!this.fixedOwners.has(handle)) return false;
    return objectId === undefined || this.fixedOwners.get(handle) === objectId;
  }

  /** Every collider as line segments (x, y, z pairs) with an RGBA colour per vertex, for the developer overlay. */
  debugLines(): { vertices: Float32Array; colors: Float32Array } {
    if (this.disposed) return { vertices: new Float32Array(0), colors: new Float32Array(0) };
    const { vertices, colors } = this.world.debugRender();
    return { vertices, colors };
  }

  private createAvatarBody(): RAPIER.RigidBody {
    const halfSegment = Math.max(0.01, (AVATAR_HEIGHT - 2 * AVATAR_RADIUS) / 2);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, AVATAR_HEIGHT / 2, 0));
    this.world.createCollider(RAPIER.ColliderDesc.capsule(halfSegment, AVATAR_RADIUS), body);
    return body;
  }

  static async create(room: RoomFile, nodes: Map<string, THREE.Object3D>): Promise<RoomPhysics> {
    await initPhysics();
    return new RoomPhysics(room, nodes);
  }

  /**
   * Where an avatar stands, from the hips' horizontal position; y is the floor. Echo (the default id)
   * has the capsule made with the world; any other id gets its own, made on first use.
   */
  setAvatarPosition(x: number, z: number, id = 'echo'): void {
    if (this.disposed) return;
    let body = id === 'echo' ? this.avatar : this.otherAvatars.get(id);
    if (!body) {
      body = this.createAvatarBody();
      this.otherAvatars.set(id, body);
    }
    body.setNextKinematicTranslation({ x, y: AVATAR_HEIGHT / 2, z });
  }

  /** Takes an extra avatar's capsule out of the world (it left). Echo's stays. */
  removeAvatar(id: string): void {
    const body = this.otherAvatars.get(id);
    if (!body || this.disposed) return;
    this.world.removeRigidBody(body);
    this.otherAvatars.delete(id);
  }

  /** Ids of the extra avatars that have a capsule. */
  get avatarIds(): string[] {
    return [...this.otherAvatars.keys()];
  }

  step(dt: number): void {
    if (this.disposed || !(dt > 0)) return;
    this.accumulator += Math.min(dt, MAX_STEPS_PER_CALL * FIXED_STEP);
    this.world.timestep = FIXED_STEP;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP - 1e-9 && steps < MAX_STEPS_PER_CALL) {
      this.world.step();
      this.accumulator -= FIXED_STEP;
      steps += 1;
      this.queriesStale = false;
    }
    this.syncNodes();
  }

  /** World position of a dynamic object's floor-contact origin, or null if it isn't dynamic. */
  dynamicPosition(id: string): [number, number, number] | null {
    const entry = this.dynamics.find((candidate) => candidate.id === id);
    if (!entry) return null;
    const p = entry.body.translation();
    return [p.x, p.y - entry.halfHeight, p.z];
  }

  /**
   * A held object follows the avatar's hand, not physics: its body turns kinematic (so it neither
   * falls nor pushes the avatar's capsule) and its node is left to whoever carries it.
   */
  setHeld(id: string, held: boolean): void {
    const body = this.bodies.get(id);
    if (!body || this.disposed) return;
    if (held) {
      this.held.add(id);
      body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    } else {
      this.held.delete(id);
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    }
  }

  isHeld(id: string): boolean {
    return this.held.has(id);
  }

  /** Moves a held object's body to where its carried node is (floor-contact origin and orientation). */
  moveHeld(id: string, origin: THREE.Vector3, orientation: THREE.Quaternion): void {
    const body = this.bodies.get(id);
    const entry = this.dynamics.find((candidate) => candidate.id === id);
    if (!body || !entry || this.disposed) return;
    const centre = new THREE.Vector3(0, entry.halfHeight, 0).applyQuaternion(orientation).add(origin);
    body.setNextKinematicTranslation({ x: centre.x, y: centre.y, z: centre.z });
    body.setNextKinematicRotation({ x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w });
  }

  /** Puts a dynamic object down: upright at `origin` (floor contact) with the given yaw, at rest, and live again. */
  place(id: string, origin: readonly [number, number, number], yaw: number): void {
    const body = this.bodies.get(id);
    const entry = this.dynamics.find((candidate) => candidate.id === id);
    if (!body || !entry || this.disposed) return;
    this.held.delete(id);
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    body.setTranslation({ x: origin[0], y: origin[1] + entry.halfHeight, z: origin[2] }, true);
    body.setRotation(yawQuaternion(yaw), true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  private syncNodes(): void {
    const offset = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    for (const { id, body, node, halfHeight } of this.dynamics) {
      if (this.held.has(id)) continue;
      const t = body.translation();
      const r = body.rotation();
      rotation.set(r.x, r.y, r.z, r.w);
      offset.set(0, halfHeight, 0).applyQuaternion(rotation);
      node.position.set(t.x - offset.x, t.y - offset.y, t.z - offset.z);
      node.quaternion.copy(rotation);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dynamics.length = 0;
    this.bodies.clear();
    this.fixedOwners.clear();
    this.fixedObjects.clear();
    this.otherAvatars.clear();
    this.world.free();
  }
}

function yawQuaternion(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

