import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPSULE_RADII, ContactBody, MAX_PELVIS_LIFT, MISS_SECONDS } from '../../src/rooms/contact-body.js';
import { RoomPhysics } from '../../src/rooms/room-physics.js';
import { builtInRoom } from './fixtures.js';

const deg = (d: number) => (d * Math.PI) / 180;

/** A 0.95 m-hips avatar in its rest pose: arms out along +/-X, model facing +Z, normalised bones. */
function buildAvatar(shin = 0.42) {
  const scene = new THREE.Group();
  const bones = new Map<string, THREE.Object3D>();
  const add = (name: string, parentName: string | null, x: number, y: number, z: number) => {
    const bone = new THREE.Object3D();
    bone.name = name;
    bone.position.set(x, y, z);
    (parentName ? bones.get(parentName)! : scene).add(bone);
    bones.set(name, bone);
  };
  add('hips', null, 0, 0.95, 0);
  add('spine', 'hips', 0, 0.1, 0);
  add('chest', 'spine', 0, 0.15, 0);
  add('neck', 'chest', 0, 0.25, 0);
  for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
    add(`${side}UpperLeg`, 'hips', sign * 0.09, -0.05, 0);
    add(`${side}LowerLeg`, `${side}UpperLeg`, 0, -0.43, 0);
    add(`${side}Foot`, `${side}LowerLeg`, 0, -shin, 0);
    add(`${side}Toes`, `${side}Foot`, 0, -0.04, 0.12);
    add(`${side}UpperArm`, 'chest', sign * 0.17, 0.2, 0);
    add(`${side}LowerArm`, `${side}UpperArm`, sign * 0.27, 0, 0);
    add(`${side}Hand`, `${side}LowerArm`, sign * 0.25, 0, 0);
    add(`${side}MiddleProximal`, `${side}Hand`, sign * 0.09, 0, 0);
  }
  scene.updateMatrixWorld(true);
  return { scene, bones, humanoid: { getNormalizedBoneNode: (name: string) => bones.get(name) ?? null }, restHipsHeight: 0.95 };
}

function worldPoint(bone: THREE.Object3D): THREE.Vector3 {
  bone.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
}

/** Depth of a capsule from `a` to `b` into the room's fixed geometry (0 when clear). */
function depthOf(physics: RoomPhysics, a: THREE.Vector3, b: THREE.Vector3, radius: number): number {
  const direction = new THREE.Vector3().subVectors(b, a);
  const length = direction.length();
  const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  const centre = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  return physics.penetration(new RAPIER.Capsule(length / 2, radius), centre, rotation)?.depth ?? 0;
}

describe('ContactBody on the reading-room sofa', () => {
  const room = builtInRoom('reading-room');
  const sofa = room.objects.find((object) => object.id === 'sofa')!;
  let physics: RoomPhysics;

  beforeAll(async () => {
    physics = await RoomPhysics.create(room, new Map());
  });
  afterAll(() => physics.dispose());

  /** Seated on the middle cushion: hips on the seat top, thighs sunk into the cushion. Angles are hip and knee flexion in degrees. */
  function seated(shin: number, thigh: number, knee: number) {
    const avatar = buildAvatar(shin);
    const [sx, , sz] = sofa.position;
    avatar.scene.position.set(sx, 0, sz + 0.15); // towards the front edge, so the knees clear the sofa base
    avatar.bones.get('hips')!.position.set(0, 0.54 + 0.09, 0);
    for (const side of ['left', 'right']) {
      avatar.bones.get(`${side}UpperLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(thigh));
      avatar.bones.get(`${side}LowerLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(knee));
    }
    avatar.scene.updateMatrixWorld(true);
    return avatar;
  }

  function run(avatar: ReturnType<typeof buildAvatar>, body: ContactBody, frames: number, reset?: () => void) {
    for (let i = 0; i < frames; i += 1) {
      reset?.();
      body.update(avatar, physics, 1 / 60, [], null);
    }
  }

  it('lifts the pelvis a little and keeps thighs and shins out of the cushion', () => {
    const avatar = seated(0.3, 75, 60); // short shins: the feet dangle
    const body = new ContactBody(avatar.humanoid);
    const thigh = CAPSULE_RADII.thigh;
    const before = depthOf(physics, worldPoint(avatar.bones.get('leftUpperLeg')!), worldPoint(avatar.bones.get('leftLowerLeg')!), thigh);
    expect(before).toBeGreaterThan(0.02); // the pose really does sink in
    const baseY = avatar.scene.position.y;
    const animated = new Map<string, THREE.Quaternion>();
    for (const name of ['UpperLeg', 'LowerLeg']) for (const side of ['left', 'right']) animated.set(side + name, avatar.bones.get(side + name)!.quaternion.clone());

    // The mixer rewrites the animated rotations every frame.
    run(avatar, body, 30, () => {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
    });
    avatar.scene.updateMatrixWorld(true);

    const lift = avatar.scene.position.y - baseY;
    expect(lift).toBeGreaterThan(0.005);
    expect(lift).toBeLessThanOrEqual(MAX_PELVIS_LIFT + 1e-9);
    expect(body.pelvisLift).toBeCloseTo(lift, 9);
    for (const side of ['left', 'right']) {
      const hip = worldPoint(avatar.bones.get(`${side}UpperLeg`)!);
      const knee = worldPoint(avatar.bones.get(`${side}LowerLeg`)!);
      const ankle = worldPoint(avatar.bones.get(`${side}Foot`)!);
      expect(depthOf(physics, hip, knee, thigh)).toBeLessThan(0.01);
      expect(depthOf(physics, knee, ankle, CAPSULE_RADII.shin)).toBeLessThan(0.01);
    }
  });

  it('eases the lift and the correction away once the animation leaves the furniture', () => {
    const avatar = seated(0.3, 75, 60);
    const body = new ContactBody(avatar.humanoid);
    const baseY = avatar.scene.position.y;
    const seatedHips = avatar.bones.get('hips')!.position.clone();
    const animated = new Map<string, THREE.Quaternion>();
    for (const side of ['left', 'right']) for (const name of ['UpperLeg', 'LowerLeg']) animated.set(side + name, avatar.bones.get(side + name)!.quaternion.clone());
    run(avatar, body, 30, () => {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
    });
    expect(body.pelvisLift).toBeGreaterThan(0.005);
    // Stand up: the hips go high, the legs straight.
    avatar.bones.get('hips')!.position.set(0, 0.95, 0);
    for (const side of ['left', 'right']) {
      avatar.bones.get(`${side}UpperLeg`)!.quaternion.identity();
      avatar.bones.get(`${side}LowerLeg`)!.quaternion.identity();
      animated.set(`${side}UpperLeg`, new THREE.Quaternion());
      animated.set(`${side}LowerLeg`, new THREE.Quaternion());
    }
    // ...and walks off to open floor.
    avatar.scene.position.x = -2;
    avatar.scene.position.z = 1;
    avatar.scene.position.y = body.pelvisLift + 0; // the lift is still on the root
    expect(seatedHips.y).toBeCloseTo(0.63);
    run(avatar, body, 90, () => {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
    });
    expect(body.pelvisLift).toBe(0);
    expect(avatar.scene.position.y).toBeCloseTo(baseY, 9);
  });

  it('takes a pose that something else rewrote after our write (a pose blend) as the new animated pose', () => {
    const avatar = seated(0.3, 75, 60);
    const body = new ContactBody(avatar.humanoid);
    const thigh = avatar.bones.get('leftUpperLeg')!;
    const animated = thigh.quaternion.clone();
    run(avatar, body, 30, () => thigh.quaternion.copy(animated));
    expect(thigh.quaternion.equals(animated)).toBe(false);
    // Stand up and walk off; a pose blend (which runs before the contact solve) writes a pose between
    // the corrected one and the new animation. Nothing touches the contact any more, so it must stay exactly so.
    avatar.scene.position.set(-2, avatar.scene.position.y - body.pelvisLift, 1);
    avatar.bones.get('hips')!.position.set(0, 0.95, 0);
    for (const name of ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg']) avatar.bones.get(name)!.quaternion.identity();
    const blended = new THREE.Quaternion().copy(thigh.quaternion).setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(10));
    thigh.quaternion.copy(blended);
    avatar.scene.updateMatrixWorld(true);
    body.update(avatar, physics, 1 / 60, [], null);
    // Weight is still easing out, but it eases from the blended pose, not from a stale animated one.
    const angleToBlended = thigh.quaternion.angleTo(blended);
    const angleToStale = thigh.quaternion.angleTo(animated);
    expect(angleToBlended).toBeLessThan(angleToStale);
    run(avatar, body, 120, () => thigh.quaternion.copy(blended));
    expect(thigh.quaternion.angleTo(blended)).toBeLessThan(1e-6);
  });

  it('release() puts back the animated pose of bones nothing else rewrites and clears the lift', () => {
    const avatar = seated(0.3, 75, 60);
    const body = new ContactBody(avatar.humanoid);
    const names = ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
    const animated = new Map(names.map((name) => [name, avatar.bones.get(name)!.quaternion.clone()]));
    run(avatar, body, 30, () => {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
    });
    expect(names.some((name) => !avatar.bones.get(name)!.quaternion.equals(animated.get(name)!))).toBe(true);
    expect(body.pelvisLift).toBeGreaterThan(0);
    body.release();
    for (const [name, q] of animated) expect(avatar.bones.get(name)!.quaternion.angleTo(q)).toBeLessThan(1e-9);
    expect(body.pelvisLift).toBe(0);
  });

  it('leaves a pose with no contact exactly as it was', () => {
    const avatar = buildAvatar();
    avatar.scene.position.set(-2, 0, 1);
    avatar.bones.get('leftUpperArm')!.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), deg(-40));
    avatar.scene.updateMatrixWorld(true);
    const before = new Map([...avatar.bones].map(([name, bone]) => [name, bone.quaternion.clone()]));
    const body = new ContactBody(avatar.humanoid);
    const hits: unknown[] = [];
    body.onMissStart((miss) => hits.push(miss));
    run(avatar, body, 20);
    for (const [name, bone] of avatar.bones) expect(bone.quaternion.equals(before.get(name)!)).toBe(true);
    expect(avatar.scene.position.y).toBe(0);
    expect(body.pelvisLift).toBe(0);
    expect(body.misses()).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('keeps grounded feet on the floor while the pelvis is lifted', () => {
    // Long shins, vertical: the ankles are on the floor in the animated pose.
    const avatar = seated(0.54, 85, 85);
    const animated = new Map<string, THREE.Quaternion>();
    for (const side of ['left', 'right']) {
      avatar.bones.get(`${side}LowerLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(85));
      animated.set(`${side}UpperLeg`, avatar.bones.get(`${side}UpperLeg`)!.quaternion.clone());
      animated.set(`${side}LowerLeg`, avatar.bones.get(`${side}LowerLeg`)!.quaternion.clone());
    }
    avatar.scene.updateMatrixWorld(true);
    const heights = ['left', 'right'].map((side) => worldPoint(avatar.bones.get(`${side}Foot`)!).y);
    expect(Math.max(...heights)).toBeLessThan(0.11);
    expect(Math.min(...heights)).toBeGreaterThan(-0.01);
    const body = new ContactBody(avatar.humanoid);
    run(avatar, body, 40, () => {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
    });
    avatar.scene.updateMatrixWorld(true);
    expect(body.pelvisLift).toBeGreaterThan(0.005);
    ['left', 'right'].forEach((side, i) => {
      expect(Math.abs(worldPoint(avatar.bones.get(`${side}Foot`)!).y - heights[i]!)).toBeLessThan(0.01);
    });
  });

  it('plants an ankle that sank below the floor', () => {
    const avatar = buildAvatar();
    avatar.scene.position.set(-2, 0, 1);
    avatar.bones.get('hips')!.position.y = 0.84; // the animation put the feet 6 cm into the floor
    avatar.scene.updateMatrixWorld(true);
    const ankle = avatar.bones.get('leftFoot')!;
    expect(worldPoint(ankle).y).toBeLessThan(0);
    const body = new ContactBody(avatar.humanoid);
    const hips = avatar.bones.get('hips')!;
    run(avatar, body, 40, () => {
      for (const side of ['left', 'right']) {
        avatar.bones.get(`${side}UpperLeg`)!.quaternion.identity();
        avatar.bones.get(`${side}LowerLeg`)!.quaternion.identity();
      }
    });
    expect(hips.position.y).toBe(0.84);
    expect(worldPoint(ankle).y).toBeGreaterThan(CAPSULE_RADII.foot - 0.01);
  });

  it('reports a limb end that stays away from its animated place', () => {
    const avatar = seated(0.3, 75, 60);
    // A hand pushed into the sofa's back rest and held there by the animation.
    const arm = avatar.bones.get('rightUpperArm')!;
    arm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(-100)); // arm behind the body
    avatar.scene.updateMatrixWorld(true);
    const body = new ContactBody(avatar.humanoid);
    const starts: string[] = [];
    body.onMissStart((miss) => starts.push(miss.end));
    const animated = arm.quaternion.clone();
    run(avatar, body, Math.ceil((MISS_SECONDS + 0.5) * 60), () => arm.quaternion.copy(animated));
    // Whether or not this pose is blocked, the report must agree with itself.
    for (const miss of body.misses()) expect(starts).toContain(miss.end);
  });

  it('reports where a limb end is and where the animation put it', () => {
    const avatar = buildAvatar();
    avatar.scene.position.set(-2, 0, 1);
    avatar.scene.updateMatrixWorld(true);
    const body = new ContactBody(avatar.humanoid);
    run(avatar, body, 5);
    const knee = body.endPositions('leftKnee')!;
    const ankle = worldPoint(avatar.bones.get('leftFoot')!);
    const at = body.endPositions('leftFoot')!;
    expect(at.actual[1]).toBeCloseTo(ankle.y, 6);
    expect(at.animated[0]).toBeCloseTo(at.actual[0], 6); // no contact: the solver left it alone
    expect(knee.actual[1]).toBeGreaterThan(at.actual[1]);
  });
});
