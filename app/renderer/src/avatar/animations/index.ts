import * as THREE from 'three';
import { VRM } from '@pixiv/three-vrm';
import {
  VRMAnimation,
  createVRMAnimationClip as buildVRMClip,
} from '@pixiv/three-vrm-animation';
import { VRMExpressionPresetName } from '@pixiv/three-vrm';

export type VrmHumanoidBoneName = Parameters<
  NonNullable<VRM['humanoid']>['getNormalizedBoneNode']
>[0];

interface RotationKeyframe {
  time: number;
  rotation: THREE.Euler;
}

function quaternionToArray(quaternion: THREE.Quaternion): [number, number, number, number] {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

export function createMixerForVrm(vrm: VRM): THREE.AnimationMixer {
  return new THREE.AnimationMixer(vrm.scene);
}

export function createHumanoidRotationTrack(
  vrm: VRM,
  bone: VrmHumanoidBoneName,
  keyframes: RotationKeyframe[],
): THREE.QuaternionKeyframeTrack | null {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return null;
  }

  const node = humanoid.getNormalizedBoneNode(bone);
  if (!node) {
    return null;
  }

  const base = node.quaternion.clone();
  const times: number[] = [];
  const values: number[] = [];

  for (const { time, rotation } of keyframes) {
    const offset = new THREE.Quaternion().setFromEuler(rotation);
    const blended = new THREE.Quaternion(base.x, base.y, base.z, base.w).multiply(offset);
    times.push(time);
    values.push(...quaternionToArray(blended));
  }

  if (times.length === 0) {
    return null;
  }

  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
}

export function createExpressionTrack(
  preset: VRMExpressionPresetName,
  times: number[],
  values: number[],
): { preset: VRMExpressionPresetName; track: THREE.NumberKeyframeTrack } {
  const track = new THREE.NumberKeyframeTrack(`expression/${preset}`, times, values);
  return { preset, track };
}

export interface VrmAnimationClipConfig {
  name: string;
  rotations?: Array<{ bone: VrmHumanoidBoneName; track: THREE.QuaternionKeyframeTrack | null }>;
  expressions?: Array<{ preset: VRMExpressionPresetName; track: THREE.NumberKeyframeTrack }>;
  duration?: number;
}

export function createVrmAnimationClip(vrm: VRM, config: VrmAnimationClipConfig): THREE.AnimationClip | null {
  const animation = new VRMAnimation();
  animation.duration = config.duration ?? 0;

  let hasTracks = false;

  if (config.rotations) {
    for (const { bone, track } of config.rotations) {
      if (!track) {
        continue;
      }
      animation.humanoidTracks.rotation.set(bone, track);
      const lastTime = track.times.at(-1) ?? 0;
      animation.duration = Math.max(animation.duration, lastTime);
      hasTracks = true;
    }
  }

  if (config.expressions) {
    for (const { preset, track } of config.expressions) {
      animation.expressionTracks.preset.set(preset, track);
      const lastTime = track.times.at(-1) ?? 0;
      animation.duration = Math.max(animation.duration, lastTime);
      hasTracks = true;
    }
  }

  if (!hasTracks) {
    return null;
  }

  const clip = buildVRMClip(animation, vrm);
  clip.name = config.name;
  return clip;
}

export function createClipFromVrma(vrm: VRM, vrma: VRMAnimation, name?: string): THREE.AnimationClip {
  const clip = buildVRMClip(vrma, vrm);
  if (name) {
    clip.name = name;
  }
  return clip;
}
