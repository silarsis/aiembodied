import * as THREE from 'three';
import { VRMHumanBoneList, type VRM } from '@pixiv/three-vrm';
import { VRMAnimation } from '@pixiv/three-vrm-animation';
import { createClipFromVrma, createMixerForVrm } from '../avatar/animations/index.js';
import type { LabRig } from './lab-rig.js';
import type { MotionTracks } from './motion-source.js';
import { FPS, type Pose } from './types.js';

/**
 * The motion model's own pose on every frame, read back from the avatar's bones after the app's clip builder and
 * a mixer have applied the tracks (so a VRM 0 model's mirrored axes and the hips' scaling are the app's own).
 * The root and every bone the tracks do not key are left at the rig's rest pose.
 */
export function evaluateRawPoses(vrm: VRM, rig: LabRig, tracks: MotionTracks): Pose[] {
  const animation = new VRMAnimation();
  animation.duration = Math.max(tracks.frames - 1, 1) / FPS;
  animation.restHipsPosition.set(0, 1, 0);
  const times = Array.from({ length: tracks.frames }, (_, frame) => frame / FPS);
  for (const [name, values] of Object.entries(tracks.bones)) {
    const bone = VRMHumanBoneList.find((candidate) => candidate === name);
    if (!bone) continue;
    animation.humanoidTracks.rotation.set(
      bone,
      new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values.flat()),
    );
  }
  animation.humanoidTracks.translation.set(
    'hips',
    new THREE.VectorKeyframeTrack('hips.position', times, tracks.hips.flat()),
  );

  const clip = createClipFromVrma(vrm, animation, 'sit-lab-raw');
  const mixer = createMixerForVrm(vrm);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const poses: Pose[] = [];
  for (let frame = 0; frame < tracks.frames; frame += 1) {
    mixer.setTime(frame / FPS);
    poses.push(rig.readPose());
  }
  mixer.stopAllAction();
  mixer.uncacheClip(clip);
  return poses;
}
