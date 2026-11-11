import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { RoomFile } from '../../../main/src/rooms/types.js';
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
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2).setFriction(0.8), body);
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
        fixed(center, object.size, yaw);
      }
    }

    // The avatar is driven by animation, so it is a kinematic capsule that can shove props.
    this.avatar = this.createAvatarBody();
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
    this.otherAvatars.clear();
    this.world.free();
  }
}

function yawQuaternion(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

