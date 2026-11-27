import * as THREE from 'three';
import { ContactBody } from '../rooms/contact-body.js';
import type { Quat, Vec3 } from './pose-math.js';
import type { Pose } from './types.js';

/** The bones the motion model drives. Fingers, eyes and the jaw are never animated by it. */
const TRACKED_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToes',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToes',
] as const;

export interface RigSource {
  /** The avatar root: its position, yaw and scale are the root pose. */
  scene: THREE.Object3D;
  humanoid: { getNormalizedBoneNode(name: string): THREE.Object3D | null | undefined };
  /** Standing pelvis height in the avatar's own metres. */
  restHipsHeight: number;
}

const TMP = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The avatar as the lab sees it: poses in and out as plain data, bone positions in the world, and the root
 * moved as a whole (a shift and a turn about a pivot) from where it stood when the lab took it over.
 */
export class LabRig {
  readonly scene: THREE.Object3D;
  readonly restHipsHeight: number;
  /** Tracked bones this avatar has. */
  readonly bones: readonly string[];
  private readonly nodes = new Map<string, THREE.Object3D>();
  private readonly source: RigSource;
  private readonly measuring: ContactBody;
  private base = { position: new THREE.Vector3(), yaw: 0 };

  constructor(source: RigSource) {
    this.source = source;
    this.scene = source.scene;
    this.restHipsHeight = source.restHipsHeight;
    for (const name of TRACKED_BONES) {
      const node = source.humanoid.getNormalizedBoneNode(name);
      if (node) this.nodes.set(name, node);
    }
    this.bones = [...this.nodes.keys()];
    this.measuring = new ContactBody(source.humanoid);
    this.captureBase();
  }

  /** World size of the avatar relative to its own metres. */
  get scale(): number {
    return this.scene.scale.x || 1;
  }

  /** Takes the root's current pose as the one offsets are measured from. */
  captureBase(): void {
    this.base = { position: this.scene.position.clone(), yaw: this.scene.rotation.y };
  }

  node(name: string): THREE.Object3D | null {
    return this.nodes.get(name) ?? null;
  }

  readPose(): Pose {
    const bones: Record<string, Quat> = {};
    for (const [name, node] of this.nodes) {
      bones[name] = [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w];
    }
    const hips = this.nodes.get('hips');
    return { bones, hips: hips ? [hips.position.x, hips.position.y, hips.position.z] : [0, 0, 0] };
  }

  writePose(pose: Pose): void {
    for (const [name, node] of this.nodes) {
      const q = pose.bones[name];
      if (q) node.quaternion.set(q[0], q[1], q[2], q[3]);
    }
    this.nodes.get('hips')?.position.set(pose.hips[0], pose.hips[1], pose.hips[2]);
  }

  updateWorld(): void {
    this.scene.updateWorldMatrix(true, true);
  }

  /** World position of a bone as the pose and root are now. Call `updateWorld` after changing either. */
  world(name: string): Vec3 {
    const node = this.nodes.get(name) ?? this.source.humanoid.getNormalizedBoneNode(name);
    if (!node) throw new Error(`The avatar has no ${name} bone.`);
    node.getWorldPosition(TMP);
    return [TMP.x, TMP.y, TMP.z];
  }

  /** Where the hips would be with `local` as their position and the root at its base pose. */
  hipsWorldAtBase(local: Vec3): Vec3 {
    TMP.set(local[0] * this.scale, local[1] * this.scale, local[2] * this.scale)
      .applyAxisAngle(UP, this.base.yaw)
      .add(this.base.position);
    return [TMP.x, TMP.y, TMP.z];
  }

  /** The root's move from its base pose: the shift of the pivot-free position, in world metres. */
  rootShift(): Vec3 {
    return [
      this.scene.position.x - this.base.position.x,
      this.scene.position.y - this.base.position.y,
      this.scene.position.z - this.base.position.z,
    ];
  }

  /**
   * Puts the root at its base pose, turned `yawDeg` about the vertical line through `pivot` (world) and then shifted by
   * `shift`. Absolute, not cumulative.
   */
  placeRoot(shift: Vec3, yawDeg = 0, pivot: Vec3 = [0, 0, 0]): void {
    const yaw = (yawDeg * Math.PI) / 180;
    const turned = new THREE.Vector3(
      this.base.position.x - pivot[0],
      0,
      this.base.position.z - pivot[2],
    ).applyAxisAngle(UP, yaw);
    this.scene.position.set(
      pivot[0] + turned.x + shift[0],
      this.base.position.y + shift[1],
      pivot[2] + turned.z + shift[2],
    );
    this.scene.rotation.y = this.base.yaw + yaw;
    this.updateWorld();
  }

  /** The body capsules (pelvis, chest, limb segments) as the bones are now. */
  capsules(): Array<{ name: string; p0: Vec3; p1: Vec3; radius: number }> {
    this.updateWorld();
    return this.measuring
      .capsulesNow({ scene: this.scene, restHipsHeight: this.restHipsHeight })
      .map((c) => ({
        name: c.name,
        p0: [c.p0.x, c.p0.y, c.p0.z],
        p1: [c.p1.x, c.p1.y, c.p1.z],
        radius: c.radius,
      }));
  }
}
