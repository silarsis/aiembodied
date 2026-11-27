import * as THREE from 'three';
import { RoomPhysics } from '../../src/rooms/room-physics.js';
import type { StreamRequestPlan } from '../../src/rooms/scene-actions.js';
import type { Destination } from '../../src/sit-lab/destination.js';
import { LabRig } from '../../src/sit-lab/lab-rig.js';
import { FrameMeasurer } from '../../src/sit-lab/measure.js';
import type { MethodContext, MotionClip } from '../../src/sit-lab/methods/types.js';
import type { Quat } from '../../src/sit-lab/pose-math.js';
import type { Pose } from '../../src/sit-lab/types.js';
import { builtInRoom } from '../rooms/fixtures.js';

/** A 0.95 m-hips avatar in its rest pose (arms out, facing +Z) as normalised bones. */
export function buildStubRig(): LabRig {
  const scene = new THREE.Group();
  const bones = new Map<string, THREE.Object3D>();
  const add = (name: string, parent: string | null, x: number, y: number, z: number) => {
    const bone = new THREE.Object3D();
    bone.name = name;
    bone.position.set(x, y, z);
    (parent ? bones.get(parent) : scene)?.add(bone);
    bones.set(name, bone);
  };
  add('hips', null, 0, 0.95, 0);
  add('spine', 'hips', 0, 0.1, 0);
  add('chest', 'spine', 0, 0.15, 0);
  add('neck', 'chest', 0, 0.25, 0);
  add('head', 'neck', 0, 0.1, 0);
  for (const [side, sign] of [
    ['left', 1],
    ['right', -1],
  ] as const) {
    add(`${side}UpperLeg`, 'hips', sign * 0.09, -0.05, 0);
    add(`${side}LowerLeg`, `${side}UpperLeg`, 0, -0.43, 0);
    add(`${side}Foot`, `${side}LowerLeg`, 0, -0.42, 0);
    add(`${side}Toes`, `${side}Foot`, 0, -0.04, 0.12);
    add(`${side}Shoulder`, 'chest', sign * 0.05, 0.2, 0);
    add(`${side}UpperArm`, 'chest', sign * 0.17, 0.2, 0);
    add(`${side}LowerArm`, `${side}UpperArm`, sign * 0.27, 0, 0);
    add(`${side}Hand`, `${side}LowerArm`, sign * 0.25, 0, 0);
    add(`${side}MiddleProximal`, `${side}Hand`, sign * 0.09, 0, 0);
  }
  scene.updateMatrixWorld(true);
  return new LabRig({
    scene,
    humanoid: { getNormalizedBoneNode: (name: string) => bones.get(name) ?? null },
    restHipsHeight: 0.95,
  });
}

const sofa = builtInRoom('reading-room').objects.find((object) => object.id === 'sofa');
if (!sofa) throw new Error('the reading room has no sofa');

/** The reading-room sofa's middle seat as a destination: cushion top 0.46 m, sit point 5 cm forward of its origin. */
export const SOFA: Destination = {
  seatId: 'sofa',
  sitPoint: [sofa.position[0], 0.42, sofa.position[2] + 0.05],
  facing: 0,
  forward: [0, 1],
  left: [1, 0],
  surfaceY: 0.46,
  pelvisY: 0.55,
  frontEdge: 0.38,
  footFloorY: 0,
  bodyFactor: 1,
  scale: 1,
  allowedContacts: ['sofa'],
};

export async function sofaPhysics(): Promise<RoomPhysics> {
  return RoomPhysics.create(builtInRoom('reading-room'), new Map());
}

/** Hips at `hipsY` over the sit point, thighs flexed `thigh` degrees and knees `knee` degrees, feet `dropAnkle` below the shins' end. */
export function seatedPose(rig: LabRig, hipsY: number, thigh = 90, knee = 90): Pose {
  const at = (axis: [number, number, number], degrees: number) => {
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(...axis),
      (degrees * Math.PI) / 180,
    );
    return [q.x, q.y, q.z, q.w] as [number, number, number, number];
  };
  const pose = rig.readPose();
  for (const side of ['left', 'right']) {
    pose.bones[`${side}UpperLeg`] = at([1, 0, 0], -thigh);
    pose.bones[`${side}LowerLeg`] = at([1, 0, 0], knee);
  }
  pose.hips = [SOFA.sitPoint[0], hipsY, SOFA.sitPoint[2]];
  return pose;
}

export function measurerFor(rig: LabRig, physics: RoomPhysics): FrameMeasurer {
  return new FrameMeasurer(
    rig,
    SOFA,
    { colliders: physics, surfaceAt: () => SOFA.surfaceY },
    { thigh: 0.43, shin: 0.42, ankleHeight: 0.08 },
  );
}

export const SIT_REQUEST: StreamRequestPlan = {
  prompt: 'a person walks calmly',
  duration: 6,
  phases: [{ prompt: 'a person turns around and sits down on a chair', startS: 2 }],
  targets: [
    { t: 3.2, until: 4, height: 0.55, revealS: 2 },
    { t: 4, until: 5.9, root: [0, 0.2], height: 0.55, heading: 0, revealS: 2 },
  ],
};

/** A context for methods, with a model that answers `clip` (or what `answer` makes of the request) and counts its calls. */
export function contextFor(
  rig: LabRig,
  physics: RoomPhysics,
  answer: (request: StreamRequestPlan, seed: number) => MotionClip,
  calls: Array<{ request: StreamRequestPlan; seed: number }> = [],
): MethodContext {
  const measurer = measurerFor(rig, physics);
  return {
    rig,
    dest: SOFA,
    legs: { thigh: 0.43, shin: 0.42, ankleHeight: 0.08 },
    hipHalfSpacing: 0.09,
    frame: { origin: { x: 0, z: 0, yaw: 0 }, scale: 1 },
    baseRequest: SIT_REQUEST,
    sitStartS: 2,
    seed: 1,
    colliders: physics,
    measure: () => measurer.measure(),
    generate: (request, seed) => {
      calls.push({ request, seed });
      return Promise.resolve(answer(request, seed));
    },
    generateContinuation: (_base, request, seed) => {
      calls.push({ request, seed });
      return Promise.resolve(answer(request, seed));
    },
    timed: (fn) => fn(),
  };
}

/** A motion of `frames` identical poses. */
export function holdMotion(pose: Pose, frames = 150, request = SIT_REQUEST): MotionClip {
  return {
    poses: Array.from({ length: frames }, () => pose),
    tracks: { frames, bones: {}, hips: [] },
    stream: { chunks: [], session: 's-1', requestMs: 1 },
    request,
  };
}

/** A rotation of `degrees` about `axis` (unit length). */
export function axisAngle(axis: [number, number, number], degrees: number): Quat {
  const q = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(...axis),
    (degrees * Math.PI) / 180,
  );
  return [q.x, q.y, q.z, q.w];
}
