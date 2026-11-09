import * as THREE from 'three';
import type { Vec3 } from '../../../main/src/rooms/types.js';
import { GripPose, type Side } from './grip-pose.js';
import type { Hand, PlanWorld, StreamEvent } from './scene-actions.js';
import type { SceneEnv } from './scene-executor.js';
import type { RootPose } from './scene-frames.js';
import type { RoomStage } from './room-stage.js';

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
}

interface Carried {
  hand: Hand;
  /** Where the object was picked up from, so it can be put back. */
  origin: Vec3;
  yaw: number;
}

const FALLBACK_HIPS_HEIGHT = 0.95;

/**
 * The real `SceneEnv`: the avatar's root, hands and grip, and the props of the active room. The
 * controller owns one and keeps it pointed at the current stage and avatar.
 */
export class RoomSceneEnv implements SceneEnv {
  private readonly carried = new Map<string, Carried>();
  private readonly grips = new Map<Side, GripPose>();
  private gripRig: AvatarRig | null = null;

  constructor(private readonly host: SceneEnvHost) {}

  planWorld(): PlanWorld | null {
    const stage = this.host.stage();
    const rig = this.host.rig();
    if (!stage || !rig) return null;
    return {
      room: stage.room,
      hasNavigation: stage.hasNavigation,
      findPath: (from, to) => stage.findPath(from, to),
      closestWalkable: (p) => stage.closestWalkable(p),
      objectPosition: (id) => stage.objectPosition(id),
      frame: {
        origin: { x: rig.scene.position.x, z: rig.scene.position.z, yaw: rig.scene.rotation.y - rig.baseRotationY },
        scale: rig.scene.scale.x || 1,
      },
      restHipsHeight: rig.restHipsHeight > 0 ? rig.restHipsHeight : FALLBACK_HIPS_HEIGHT,
    };
  }

  setRootPose(pose: RootPose): void {
    const rig = this.host.rig();
    if (!rig) return;
    rig.scene.position.x = pose.x;
    rig.scene.position.z = pose.z;
    rig.scene.rotation.y = rig.baseRotationY + pose.yaw;
    rig.scene.updateWorldMatrix(true, true);
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
    return true;
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
    for (const grip of this.grips.values()) if (grip.active) grip.update(deltaSeconds);
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
