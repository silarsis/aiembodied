import * as THREE from 'three';
import type { Vec3 } from '../../../main/src/rooms/types.js';
import { GripPose, type Side } from './grip-pose.js';
import type { Hand, PlanWorld, StreamEvent } from './scene-actions.js';
import type { SceneEnv } from './scene-executor.js';
import type { RootPose } from './scene-frames.js';
import type { RoomStage } from './room-stage.js';
import type { RoomOccupancy } from './room-occupancy.js';
import { easeOffset, seatOffsetTarget, seatedContactY } from './seat-fit.js';

/** The parts of the loaded avatar that scene actions need. */
export interface AvatarRig {
  /** The VRM scene root: its x/z, yaw and scale are the avatar's root pose. */
  scene: THREE.Object3D;
  /** The scene's yaw before it was placed in the room (a VRM 0.x model is turned half a circle). */
  baseRotationY: number;
  humanoid: { getNormalizedBoneNode(name: string): THREE.Object3D | null | undefined };
  /** Standing pelvis height in the avatar's own metres. */
  restHipsHeight: number;
}

export interface SceneEnvHost {
  stage(): RoomStage | null;
  rig(): AvatarRig | null;
  /** Width over height of the room view. */
  aspect?(): number;
  /**
   * The room's occupancy while there is more than one avatar in it; null or absent when this avatar is
   * alone, which keeps planning exactly as it is for a single avatar.
   */
  occupancy?(): RoomOccupancy | null;
  /** This avatar's id in the occupancy (default 'echo'). */
  avatarId?: string;
}

interface Carried {
  hand: Hand;
  /** Where the object was picked up from, so it can be put back. */
  origin: Vec3;
  yaw: number;
  /** Where the object's node is easing to in the hand bone's space, so its grab point sits in the palm. */
  snap?: THREE.Vector3;
}

const FALLBACK_HIPS_HEIGHT = 0.95;
/** The palm centre is this fraction of the way from the hand bone to the middle finger's knuckle. */
const PALM_FRACTION = 0.5;
/** Easing rate of the object into the palm, 1/seconds (settles in about 0.2 s). */
const GRIP_SNAP_RATE = 15;
/** The snap is finished when the node is closer than this to its place (metres). */
const GRIP_SNAP_EPSILON = 0.0005;
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();

/**
 * The real `SceneEnv`: the avatar's root, hands and grip, and the props of the active room. The
 * controller owns one and keeps it pointed at the current stage and avatar.
 */
export class RoomSceneEnv implements SceneEnv {
  private readonly carried = new Map<string, Carried>();
  private readonly grips = new Map<Side, GripPose>();
  private gripRig: AvatarRig | null = null;
  /** The object the avatar sits on while its sit clip is held; the fit below keeps the pelvis above it. */
  private seatId: string | null = null;
  /** The vertical offset currently added to the avatar root's y by the seat fit (metres). */
  private seatOffset = 0;
  private seatRig: AvatarRig | null = null;

  constructor(private readonly host: SceneEnvHost) {}

  planWorld(): PlanWorld | null {
    const stage = this.host.stage();
    const rig = this.host.rig();
    if (!stage || !rig) return null;
    const occupancy = this.occupancyOf();
    const id = this.host.avatarId ?? 'echo';
    if (occupancy) occupancy.standing(id, { x: rig.scene.position.x, z: rig.scene.position.z });
    return {
      room: stage.room,
      hasNavigation: stage.hasNavigation,
      findPath: (from, to) => stage.findPath(from, to),
      closestWalkable: (p) => stage.closestWalkable(p),
      objectPosition: (id) => stage.objectPosition(id),
      seatSurfaceY: (objectId, x, z) => {
        const tag = stage.worldTag(objectId, 'sit');
        return tag ? stage.surfaceHeightAt(objectId, x, z, tag.position[1]) : null;
      },
      frame: {
        origin: { x: rig.scene.position.x, z: rig.scene.position.z, yaw: rig.scene.rotation.y - rig.baseRotationY },
        scale: rig.scene.scale.x || 1,
      },
      restHipsHeight: rig.restHipsHeight > 0 ? rig.restHipsHeight : FALLBACK_HIPS_HEIGHT,
      cameraAspect: this.host.aspect?.(),
      ...(occupancy ? { others: occupancy.others(id), occupancy: occupancy.forAvatar(id) } : {}),
    };
  }

  private occupancyOf(): RoomOccupancy | null {
    return this.host.occupancy?.() ?? null;
  }

  setRootPose(pose: RootPose): void {
    const rig = this.host.rig();
    if (!rig) return;
    rig.scene.position.x = pose.x;
    rig.scene.position.z = pose.z;
    rig.scene.rotation.y = rig.baseRotationY + pose.yaw;
    rig.scene.updateWorldMatrix(true, true);
    this.occupancyOf()?.standing(this.host.avatarId ?? 'echo', { x: pose.x, z: pose.z });
  }

  attach(objectId: string, hand: Hand): boolean {
    const stage = this.host.stage();
    const rig = this.host.rig();
    const node = stage?.objectNode(objectId);
    const bone = rig?.humanoid.getNormalizedBoneNode(`${hand}Hand`);
    if (!stage || !rig || !node || !bone || this.carried.has(objectId)) return false;
    const origin = stage.objectPosition(objectId) ?? [0, 0, 0];
    this.carried.set(objectId, { hand, origin, yaw: stage.objectYaw(objectId) });
    rig.scene.updateWorldMatrix(true, true);
    bone.attach(node); // keeps its world transform, then follows the hand
    stage.setHeld(objectId, true);
    this.grip(rig, hand).setGripped(true);
    const entry = this.carried.get(objectId);
    const snap = entry ? this.palmSnap(stage, rig, bone, node, objectId, hand) : null;
    if (entry && snap) entry.snap = snap;
    return true;
  }

  /**
   * Where the carried node should sit, in the hand bone's space, to put its grab point (the `grab` tag, or
   * the middle of its bounding box) in the palm. Null when it already does.
   */
  private palmSnap(
    stage: RoomStage,
    rig: AvatarRig,
    bone: THREE.Object3D,
    node: THREE.Object3D,
    objectId: string,
    hand: Hand,
  ): THREE.Vector3 | null {
    const palm = bone.getWorldPosition(TMP_A);
    const knuckle = rig.humanoid.getNormalizedBoneNode(`${hand}MiddleProximal`);
    if (knuckle) {
      knuckle.updateWorldMatrix(true, false);
      palm.lerp(knuckle.getWorldPosition(TMP_B), PALM_FRACTION);
    }
    node.updateWorldMatrix(true, true);
    const tag = stage.room.objects.find((object) => object.id === objectId)?.tags?.grab;
    const grab = tag
      ? node.localToWorld(new THREE.Vector3(tag.position[0], tag.position[1], tag.position[2]))
      : new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
    const target = bone.worldToLocal(node.getWorldPosition(new THREE.Vector3()).add(palm.sub(grab)));
    return target.distanceTo(node.position) < GRIP_SNAP_EPSILON ? null : target;
  }

  setSeat(objectId: string): void {
    this.seatId = objectId;
  }

  clearSeat(): void {
    this.seatId = null;
  }

  detach(event: StreamEvent): void {
    const stage = this.host.stage();
    const rig = this.host.rig();
    const entry = this.carried.get(event.objectId);
    const node = stage?.objectNode(event.objectId);
    if (!stage || !node || !entry) return;
    const bone = rig?.humanoid.getNormalizedBoneNode(`${entry.hand}Hand`);
    let target: Vec3 = entry.origin;
    if (bone && event.surface) {
      bone.updateWorldMatrix(true, false);
      const p = bone.getWorldPosition(new THREE.Vector3());
      const [x, z] = event.surface.clamp(p.x, p.z);
      target = [x, event.surface.y, z];
    } else if (bone) {
      const p = bone.getWorldPosition(new THREE.Vector3());
      target = [p.x, 0, p.z];
    }
    const yaw = stage.objectYaw(event.objectId);
    this.putDown(stage, event.objectId, node, target, yaw, entry.hand);
  }

  releaseHeld(): void {
    const stage = this.host.stage();
    for (const [objectId, entry] of [...this.carried]) {
      const node = stage?.objectNode(objectId);
      if (stage && node) this.putDown(stage, objectId, node, entry.origin, entry.yaw, entry.hand);
      else this.carried.delete(objectId);
    }
    for (const grip of this.grips.values()) grip.setGripped(false);
  }

  /** Advances the grip blend. Call once per frame after the animation mixer has run. */
  step(deltaSeconds: number): void {
    const rig = this.host.rig();
    const occupancy = this.occupancyOf();
    if (rig && occupancy) occupancy.standing(this.host.avatarId ?? 'echo', { x: rig.scene.position.x, z: rig.scene.position.z });
    for (const grip of this.grips.values()) if (grip.active) grip.update(deltaSeconds);
    this.easeCarried(deltaSeconds);
    this.fitSeat(rig, deltaSeconds);
  }

  /** Eases each freshly grabbed object into the palm. */
  private easeCarried(deltaSeconds: number): void {
    const stage = this.host.stage();
    for (const [objectId, entry] of this.carried) {
      const node = entry.snap ? stage?.objectNode(objectId) : undefined;
      if (!entry.snap || !node) continue;
      node.position.lerp(entry.snap, 1 - Math.exp(-GRIP_SNAP_RATE * Math.max(0, deltaSeconds)));
      if (node.position.distanceTo(entry.snap) < GRIP_SNAP_EPSILON) {
        node.position.copy(entry.snap);
        entry.snap = undefined;
      }
    }
  }

  /**
   * While seated, lifts or lowers the avatar root so its lowest seated contact rests on the measured seat
   * surface under the pelvis (see seat-fit.ts); eases back to the plain floor when the seat is cleared. The
   * offset is applied to the root's y as a delta, so everything else (walking, standing up) sees the floor.
   */
  private fitSeat(rig: AvatarRig | null, deltaSeconds: number): void {
    if (this.seatRig !== rig) {
      this.seatRig = rig;
      this.seatOffset = 0;
    }
    if (!rig) return;
    let target = 0;
    if (this.seatId) {
      const stage = this.host.stage();
      const hips = rig.humanoid.getNormalizedBoneNode('hips');
      const tag = stage?.worldTag(this.seatId, 'sit');
      if (!stage || !hips || !tag) return;
      rig.scene.updateWorldMatrix(true, true);
      const p = hips.getWorldPosition(TMP_A);
      const surface = stage.surfaceHeightAt(this.seatId, p.x, p.z, tag.position[1]);
      if (surface === null) return;
      const contact = seatedContactY(p.y, rig.restHipsHeight, rig.scene.scale.x || 1);
      target = seatOffsetTarget(contact, surface, this.seatOffset);
    } else if (this.seatOffset === 0) {
      return;
    }
    const next = easeOffset(this.seatOffset, target, deltaSeconds);
    if (next === this.seatOffset) return;
    rig.scene.position.y += next - this.seatOffset;
    this.seatOffset = next;
    rig.scene.updateWorldMatrix(true, true);
  }

  get carriedIds(): string[] {
    return [...this.carried.keys()];
  }

  private putDown(stage: RoomStage, objectId: string, node: THREE.Object3D, origin: Vec3, yaw: number, hand: Hand): void {
    stage.propParent.add(node); // the physics sync and placeObject set its pose in room space
    stage.placeObject(objectId, origin, yaw);
    this.carried.delete(objectId);
    this.grips.get(hand)?.setGripped(false);
  }

  private grip(rig: AvatarRig, hand: Hand): GripPose {
    if (this.gripRig !== rig) {
      this.grips.clear();
      this.gripRig = rig;
    }
    let grip = this.grips.get(hand);
    if (!grip) {
      grip = new GripPose(rig.humanoid, hand);
      this.grips.set(hand, grip);
    }
    return grip;
  }
}
