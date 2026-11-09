import * as THREE from 'three';

interface BoneSource {
  getNormalizedBoneNode(name: string): THREE.Object3D | null | undefined;
}

export type Side = 'left' | 'right';

/** Curl per joint, degrees: knuckle, middle and tip joints of a finger, and the three thumb joints. */
const FINGER_CURL = [55, 60, 50];
const THUMB_CURL = [12, 25, 25];
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
const FINGER_JOINTS = ['Proximal', 'Intermediate', 'Distal'] as const;
const THUMB_JOINTS = ['Metacarpal', 'Proximal', 'Distal'] as const;
const DOWN = new THREE.Vector3(0, -1, 0);
/** Seconds to close or open the hand. */
const BLEND_SECONDS = 0.25;

interface Joint {
  bone: THREE.Object3D;
  rest: THREE.Quaternion;
  axis: THREE.Vector3;
  radians: number;
}

/**
 * Closes one hand around a held object by curling its finger bones. It runs after the animation
 * mixer each frame and writes the finger bones absolutely (the motion clips never animate fingers),
 * easing in and out. The curl axis is worked out from the bones themselves: each finger bends
 * towards the floor from its rest direction, which is the palm side of a hand at rest, so it is
 * right for either hand and for VRM 0.x models whose rig is mirrored.
 */
export class GripPose {
  private readonly joints: Joint[] = [];
  private target = 0;
  private weight = 0;
  private applied = false;

  constructor(humanoid: BoneSource, side: Side) {
    for (const finger of FINGERS) {
      this.collect(humanoid, FINGER_JOINTS.map((joint) => `${side}${finger}${joint}`), FINGER_CURL);
    }
    this.collect(humanoid, THUMB_JOINTS.map((joint) => `${side}Thumb${joint}`), THUMB_CURL);
  }

  /** False when the avatar has no finger bones, so there is nothing to curl. */
  get available(): boolean {
    return this.joints.length > 0;
  }

  /** True while the hand is closed or still easing open. */
  get active(): boolean {
    return this.target > 0 || this.weight > 0;
  }

  get closed(): boolean {
    return this.target > 0;
  }

  get currentWeight(): number {
    return this.weight;
  }

  setGripped(on: boolean): void {
    this.target = on ? 1 : 0;
  }

  update(deltaSeconds: number): void {
    if (this.joints.length === 0) return;
    const step = Math.max(0, deltaSeconds) / BLEND_SECONDS;
    this.weight = this.weight < this.target ? Math.min(this.target, this.weight + step) : Math.max(this.target, this.weight - step);
    if (this.weight <= 0) {
      if (this.applied) {
        for (const joint of this.joints) joint.bone.quaternion.copy(joint.rest);
        this.applied = false;
      }
      return;
    }
    const curl = new THREE.Quaternion();
    for (const joint of this.joints) {
      curl.setFromAxisAngle(joint.axis, joint.radians * this.weight);
      joint.bone.quaternion.copy(joint.rest).multiply(curl);
    }
    this.applied = true;
  }

  private collect(humanoid: BoneSource, names: string[], curl: number[]): void {
    const bones = names.map((name) => humanoid.getNormalizedBoneNode(name) ?? null);
    let direction: THREE.Vector3 | null = null;
    for (let i = 0; i < bones.length; i += 1) {
      const bone = bones[i];
      if (!bone) continue;
      // The bone points at its child; the last joint has no child bone, so it keeps the previous direction.
      const child = bones[i + 1];
      if (child && child.position.lengthSq() > 1e-12) direction = child.position.clone().normalize();
      if (!direction) continue;
      const axis = new THREE.Vector3().crossVectors(direction, DOWN);
      if (axis.lengthSq() < 1e-9) continue;
      this.joints.push({
        bone,
        rest: bone.quaternion.clone(),
        axis: axis.normalize(),
        radians: THREE.MathUtils.degToRad(curl[i] ?? 0),
      });
    }
  }
}
