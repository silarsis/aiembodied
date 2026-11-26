import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPSULE_RADII, ContactBody, MAX_BODY_SHIFT, MAX_PELVIS_LIFT, MISS_SECONDS } from '../../src/rooms/contact-body.js';
import { BUTTOCKS_BELOW_HIPS } from '../../src/rooms/seat-fit.js';
import {
  HEAD_PITCH_LIMIT,
  HEAD_ROLL_LIMIT,
  HEAD_YAW_LIMIT,
} from '../../src/rooms/contact-math.js';
import { RoomPhysics } from '../../src/rooms/room-physics.js';
import { builtInRoom } from './fixtures.js';

const deg = (d: number) => (d * Math.PI) / 180;
const HEAD_YAW_LIMIT_DEG = (HEAD_YAW_LIMIT * 180) / Math.PI;
const HEAD_PITCH_LIMIT_DEG = (HEAD_PITCH_LIMIT * 180) / Math.PI;
const HEAD_ROLL_LIMIT_DEG = (HEAD_ROLL_LIMIT * 180) / Math.PI;

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
    avatar.bones.get('hips')!.position.set(0, 0.46 + 0.09, 0);
    for (const side of ['left', 'right']) {
      avatar.bones.get(`${side}UpperLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(thigh));
      avatar.bones.get(`${side}LowerLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(knee));
    }
    avatar.scene.updateMatrixWorld(true);
    return avatar;
  }

  function run(avatar: ReturnType<typeof buildAvatar>, body: ContactBody, frames: number, reset?: () => void, seat: string | null = 'sofa') {
    for (let i = 0; i < frames; i += 1) {
      reset?.();
      body.update(avatar, physics, 1 / 60, [], null, seat);
    }
  }

  it('lifts the root a little for furniture other than the seat, without bending any joint', () => {
    const avatar = seated(0.22, 75, 60); // short shins: the feet dangle (the seat is 8 cm lower, so the shins are too)
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
    }, null); // not the seat being sat on: other furniture still lifts the pelvis
    for (const [name, q] of animated) expect(avatar.bones.get(name)!.quaternion.equals(q)).toBe(true);
    avatar.scene.updateMatrixWorld(true);

    const lift = avatar.scene.position.y - baseY;
    expect(lift).toBeGreaterThan(0.005);
    expect(lift).toBeLessThanOrEqual(MAX_PELVIS_LIFT + 1e-9);
    expect(body.pelvisLift).toBeCloseTo(lift, 9);
    for (const side of ['left', 'right']) {
      const hip = worldPoint(avatar.bones.get(`${side}UpperLeg`)!);
      const knee = worldPoint(avatar.bones.get(`${side}LowerLeg`)!);
      const ankle = worldPoint(avatar.bones.get(`${side}Foot`)!);
      // Only the lift (at most MAX_PELVIS_LIFT) answers to the cushion; the legs are not rotated.
      expect(depthOf(physics, hip, knee, thigh)).toBeLessThan(0.04);
      expect(depthOf(physics, knee, ankle, CAPSULE_RADII.shin)).toBeLessThan(0.01);
    }
  });

  it('eases the lift and the correction away once the animation leaves the furniture', () => {
    const avatar = seated(0.22, 75, 60);
    const body = new ContactBody(avatar.humanoid);
    const baseY = avatar.scene.position.y;
    const seatedHips = avatar.bones.get('hips')!.position.clone();
    const animated = new Map<string, THREE.Quaternion>();
    for (const side of ['left', 'right']) for (const name of ['UpperLeg', 'LowerLeg']) animated.set(side + name, avatar.bones.get(side + name)!.quaternion.clone());
    run(avatar, body, 30, () => {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
    }, null);
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
    expect(seatedHips.y).toBeCloseTo(0.55);
    run(avatar, body, 90, () => {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
    });
    expect(body.pelvisLift).toBe(0);
    expect(avatar.scene.position.y).toBeCloseTo(baseY, 9);
  });

  it('takes a pose that something else rewrote after our write (a pose blend) as the new animated pose', () => {
    // The animation put the feet 6 cm into the floor: planting them rotates the thigh (within its cap).
    const avatar = buildAvatar();
    avatar.scene.position.set(-2, 0, 1);
    avatar.bones.get('hips')!.position.y = 0.84;
    avatar.scene.updateMatrixWorld(true);
    const body = new ContactBody(avatar.humanoid);
    const thigh = avatar.bones.get('leftUpperLeg')!;
    const animated = thigh.quaternion.clone();
    run(avatar, body, 30, () => thigh.quaternion.copy(animated), null);
    expect(thigh.quaternion.equals(animated)).toBe(false);
    // Stand up and walk off; a pose blend (which runs before the contact solve) writes a pose between
    // the corrected one and the new animation. Nothing touches the contact any more, so it must stay exactly so.
    avatar.scene.position.set(-2, avatar.scene.position.y - body.pelvisLift, 1);
    avatar.bones.get('hips')!.position.set(0, 0.95, 0);
    for (const name of ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg']) avatar.bones.get(name)!.quaternion.identity();
    const blended = new THREE.Quaternion().copy(thigh.quaternion).setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(10));
    thigh.quaternion.copy(blended);
    avatar.scene.updateMatrixWorld(true);
    body.update(avatar, physics, 1 / 60, [], null, null);
    // Weight is still easing out, but it eases from the blended pose, not from a stale animated one.
    const angleToBlended = thigh.quaternion.angleTo(blended);
    const angleToStale = thigh.quaternion.angleTo(animated);
    expect(angleToBlended).toBeLessThan(angleToStale);
    run(avatar, body, 120, () => thigh.quaternion.copy(blended), null);
    expect(thigh.quaternion.angleTo(blended)).toBeLessThan(1e-6);
  });

  it('release() puts back the animated pose of bones nothing else rewrites and clears the body shift', () => {
    // Feet 6 cm into the floor: planting them rotates the legs.
    const sunk = buildAvatar();
    sunk.scene.position.set(-2, 0, 1);
    sunk.bones.get('hips')!.position.y = 0.84;
    sunk.scene.updateMatrixWorld(true);
    const sunkBody = new ContactBody(sunk.humanoid);
    const names = ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
    const animated = new Map(names.map((name) => [name, sunk.bones.get(name)!.quaternion.clone()]));
    run(sunk, sunkBody, 30, () => {
      for (const [name, q] of animated) sunk.bones.get(name)!.quaternion.copy(q);
    }, null);
    expect(names.some((name) => !sunk.bones.get(name)!.quaternion.equals(animated.get(name)!))).toBe(true);
    sunkBody.release();
    for (const [name, q] of animated) expect(sunk.bones.get(name)!.quaternion.angleTo(q)).toBeLessThan(1e-9);

    const avatar = seated(0.22, 75, 60);
    const body = new ContactBody(avatar.humanoid);
    run(avatar, body, 30, undefined, null); // no seat: the cushion lifts the root
    expect(body.pelvisLift).toBeGreaterThan(0);
    body.release();
    expect(body.pelvisLift).toBe(0);
    expect(body.traceSnapshot().bodyShift).toMatchObject({ applied: [0, 0, 0] });
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
    const avatar = seated(0.46, 85, 85);
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
    }, null);
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
    }, null);
    expect(hips.position.y).toBe(0.84);
    // The hip and knee corrections are capped, so a 6 cm sink is only partly undone (it used to be fully planted).
    expect(worldPoint(ankle).y).toBeGreaterThan(-0.03);
    expect(worldPoint(ankle).y).toBeLessThan(CAPSULE_RADII.foot);
    expect(body.misses().map((miss) => miss.end)).toContain('leftFoot');
  });

  it('reports a limb end that stays away from its animated place', () => {
    const avatar = seated(0.22, 75, 60);
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

  describe('Echo on the sofa (short legs, planted feet)', () => {
    const REST = 0.816;
    const SCALE = 0.98;
    const THIGH = 0.404;
    const SHIN = 0.304;
    const ANKLE = 0.108;
    const FACTOR = (REST / 0.95) * SCALE;

    /** Echo's proportions, seat-fitted (buttocks on the 0.46 m seat top), thighs sloping `slope` degrees down, shins reaching the floor. */
    function echoSeated(slope: number) {
      const scene = new THREE.Group();
      scene.scale.setScalar(SCALE);
      const bones = new Map<string, THREE.Object3D>();
      const add = (name: string, parentName: string | null, x: number, y: number, z: number) => {
        const bone = new THREE.Object3D();
        bone.name = name;
        bone.position.set(x, y, z);
        (parentName ? bones.get(parentName)! : scene).add(bone);
        bones.set(name, bone);
      };
      add('hips', null, 0, REST, 0);
      add('spine', 'hips', 0, 0.09, 0);
      add('chest', 'spine', 0, 0.13, 0);
      add('neck', 'chest', 0, 0.2, 0);
      add('head', 'neck', 0, 0.1, 0);
      for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
        add(`${side}UpperLeg`, 'hips', sign * 0.08, -0.02, 0);
        add(`${side}LowerLeg`, `${side}UpperLeg`, 0, -THIGH, 0);
        add(`${side}Foot`, `${side}LowerLeg`, 0, -SHIN, 0);
        add(`${side}Toes`, `${side}Foot`, 0, -0.04, 0.1);
      }
      const [sx, , sz] = sofa.position;
      scene.position.set(sx, 0, sz + 0.15);
      const seatTop = 0.46;
      const hipsY = seatTop + BUTTOCKS_BELOW_HIPS * FACTOR;
      bones.get('hips')!.position.y = hipsY / SCALE;
      const thighFlex = 90 - slope;
      // The knee's height decides how far the shin must tilt so the ankle ends ANKLE above the floor.
      const kneeY = hipsY - 0.02 * SCALE - THIGH * SCALE * Math.sin(deg(slope));
      const drop = kneeY - ANKLE * SCALE;
      const shinFromDown = Math.acos(Math.min(1, drop / (SHIN * SCALE)));
      const kneeFlex = thighFlex + (shinFromDown * 180) / Math.PI;
      for (const side of ['left', 'right']) {
        bones.get(`${side}UpperLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(thighFlex));
        bones.get(`${side}LowerLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(kneeFlex));
      }
      scene.updateMatrixWorld(true);
      return { scene, bones, humanoid: { getNormalizedBoneNode: (name: string) => bones.get(name) ?? null }, restHipsHeight: REST };
    }

    /** Combined local yaw/pitch/roll (degrees) of neck and head relative to the chest. */
    function headAngles(avatar: ReturnType<typeof echoSeated>) {
      const q = avatar.bones.get('neck')!.quaternion.clone().multiply(avatar.bones.get('head')!.quaternion);
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      return { yaw: (e.y * 180) / Math.PI, pitch: (e.x * 180) / Math.PI, roll: (e.z * 180) / Math.PI };
    }

    function frames(avatar: ReturnType<typeof echoSeated>, body: ContactBody, count: number, headSettle: boolean, animated: Map<string, THREE.Quaternion>) {
      for (let i = 0; i < count; i += 1) {
        for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
        body.update(avatar, physics, 1 / 60, [], null, 'sofa', headSettle);
      }
    }

    it('eases a head turned 58 degrees back to the 35 degree limit while seated and idle', () => {
      const avatar = echoSeated(0);
      avatar.bones.get('neck')!.quaternion.setFromEuler(new THREE.Euler(0, deg(20), 0, 'YXZ'));
      avatar.bones.get('head')!.quaternion.setFromEuler(new THREE.Euler(0, deg(38), 0, 'YXZ'));
      const animated = new Map(['neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]));
      const body = new ContactBody(avatar.humanoid);
      expect(headAngles(avatar).yaw).toBeCloseTo(58, 3);
      frames(avatar, body, 10, true, animated);
      expect(headAngles(avatar).yaw).toBeGreaterThan(40); // eases, does not snap
      frames(avatar, body, 120, true, animated);
      const settled = headAngles(avatar);
      expect(settled.yaw).toBeCloseTo(HEAD_YAW_LIMIT_DEG, 1);
      expect(Math.abs(settled.pitch)).toBeLessThan(0.1);
      expect(Math.abs(settled.roll)).toBeLessThan(0.1);
      expect(body.traceSnapshot().headSettle).toMatchObject({ weight: 1 });
      // A new stream starts: the animated pose comes back.
      frames(avatar, body, 120, false, animated);
      expect(headAngles(avatar).yaw).toBeCloseTo(58, 3);
    });

    it('leaves a head turned 20 degrees alone', () => {
      const avatar = echoSeated(0);
      avatar.bones.get('head')!.quaternion.setFromEuler(new THREE.Euler(0, deg(20), 0, 'YXZ'));
      const animated = new Map(['neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]));
      const body = new ContactBody(avatar.humanoid);
      frames(avatar, body, 60, true, animated);
      expect(avatar.bones.get('head')!.quaternion.equals(animated.get('head')!)).toBe(true);
      expect(avatar.bones.get('neck')!.quaternion.equals(animated.get('neck')!)).toBe(true);
    });

    it('clamps pitch and roll to their limits too', () => {
      const avatar = echoSeated(0);
      avatar.bones.get('head')!.quaternion.setFromEuler(new THREE.Euler(deg(-33), 0, deg(17), 'YXZ'));
      const animated = new Map(['neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]));
      const body = new ContactBody(avatar.humanoid);
      frames(avatar, body, 120, true, animated);
      const a = headAngles(avatar);
      expect(a.pitch).toBeCloseTo(-HEAD_PITCH_LIMIT_DEG, 1);
      expect(a.roll).toBeCloseTo(HEAD_ROLL_LIMIT_DEG, 1);
    });

    /** Head yaw (degrees) relative to the hips, from world rotations: what the settle limits, whatever the spine does. */
    function headYawFromHips(avatar: ReturnType<typeof echoSeated>) {
      avatar.scene.updateMatrixWorld(true);
      const worldQ = (name: string) => avatar.bones.get(name)!.getWorldQuaternion(new THREE.Quaternion());
      const q = worldQ('hips').invert().multiply(worldQ('head'));
      return (new THREE.Euler().setFromQuaternion(q, 'YXZ').y * 180) / Math.PI;
    }

    it('takes a head turned -178 degrees (a broken frame) back to straight ahead, never through bigger angles', () => {
      const avatar = echoSeated(0);
      avatar.bones.get('head')!.quaternion.setFromEuler(new THREE.Euler(0, deg(-178), 0, 'YXZ'));
      const animated = new Map(['neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]));
      const body = new ContactBody(avatar.humanoid);
      let widest = 0;
      for (let i = 0; i < 180; i += 1) {
        frames(avatar, body, 1, true, animated);
        widest = Math.max(widest, Math.abs(headYawFromHips(avatar)));
      }
      expect(widest).toBeLessThanOrEqual(178.01);
      expect(Math.abs(headYawFromHips(avatar))).toBeLessThan(5);
      const trace = body.traceSnapshot().headSettle as { reset: boolean; animYawPitchRollDeg: number[] };
      expect(trace).toMatchObject({ reset: true });
      expect(trace.animYawPitchRollDeg[0]).toBeCloseTo(-178, 1);
    });

    it('counts a twisted chest toward the limit: chest 40 degrees plus head 30 ends within 35 degrees of the hips', () => {
      const avatar = echoSeated(0);
      avatar.bones.get('chest')!.quaternion.setFromEuler(new THREE.Euler(0, deg(40), 0, 'YXZ'));
      avatar.bones.get('head')!.quaternion.setFromEuler(new THREE.Euler(0, deg(30), 0, 'YXZ'));
      const animated = new Map(['chest', 'neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]));
      const body = new ContactBody(avatar.humanoid);
      frames(avatar, body, 180, true, animated);
      expect(headYawFromHips(avatar)).toBeCloseTo(HEAD_YAW_LIMIT_DEG, 1);
      expect(body.traceSnapshot().headSettle).toMatchObject({ reset: false });
    });

    it('uses the seat fit distance as the pelvis radius, so a fitted pelvis does not lift', () => {
      expect(CAPSULE_RADII.pelvis).toBe(BUTTOCKS_BELOW_HIPS);
      const avatar = echoSeated(0);
      const body = new ContactBody(avatar.humanoid);
      run(avatar, body, 30, undefined, 'sofa');
      expect(body.pelvisLift).toBe(0);
    });

    it('ignores a pelvis sunk into the seat being sat on, but lifts for other furniture', () => {
      const avatar = echoSeated(0);
      avatar.bones.get('hips')!.position.y -= 0.05; // pelvis 5 cm into the cushion
      avatar.scene.updateMatrixWorld(true);
      const seatedBody = new ContactBody(avatar.humanoid);
      run(avatar, seatedBody, 30, undefined, 'sofa');
      expect(seatedBody.pelvisLift).toBe(0);
      const otherBody = new ContactBody(avatar.humanoid);
      run(avatar, otherBody, 30, undefined, 'something-else');
      expect(otherBody.pelvisLift).toBeGreaterThan(0.01);
    });

    function cushionFrames(avatar: ReturnType<typeof echoSeated>, body: ContactBody) {
      const names = ['UpperLeg', 'LowerLeg'].flatMap((n) => ['left', 'right'].map((side) => side + n));
      const animated = new Map(names.map((name) => [name, avatar.bones.get(name)!.quaternion.clone()]));
      run(avatar, body, 60, () => {
        for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
      });
      avatar.scene.updateMatrixWorld(true);
      return animated;
    }
    const thighDepth = (avatar: ReturnType<typeof echoSeated>, side: string) =>
      depthOf(physics, worldPoint(avatar.bones.get(`${side}UpperLeg`)!), worldPoint(avatar.bones.get(`${side}LowerLeg`)!), CAPSULE_RADII.thigh * FACTOR);

    it('leaves thighs resting in the seat cushion alone: no body shift, no joint bent, no miss (15 degree slope)', () => {
      const avatar = echoSeated(15);
      const body = new ContactBody(avatar.humanoid);
      expect(thighDepth(avatar, 'left')).toBeGreaterThan(0.05); // the pose really sinks in
      const start = avatar.scene.position.clone();
      const animated = cushionFrames(avatar, body);
      // Seat fit is the authority on the seat: the thighs stay in the cushion and the pose is not bent to leave it.
      expect(thighDepth(avatar, 'left')).toBeGreaterThan(0.05);
      expect(avatar.scene.position.equals(start)).toBe(true);
      expect(body.pelvisLift).toBe(0);
      expect(body.misses()).toEqual([]);
      for (const [name, q] of animated) expect(avatar.bones.get(name)!.quaternion.equals(q)).toBe(true);
    });

    it.each([18, 20])('moves the whole body forward out of the sofa front when the shins sink into it (%i degree slope)', (slope) => {
      const avatar = echoSeated(slope);
      const body = new ContactBody(avatar.humanoid);
      const shin = () => depthOf(physics, worldPoint(avatar.bones.get('leftLowerLeg')!), worldPoint(avatar.bones.get('leftFoot')!), CAPSULE_RADII.shin * FACTOR);
      const before = shin();
      expect(before).toBeGreaterThan(0.03);
      const start = avatar.scene.position.clone();
      const baseY = start.y;
      cushionFrames(avatar, body);
      const moved = avatar.scene.position.clone().sub(start);
      expect(moved.z).toBeGreaterThan(before * 0.8);
      expect(Math.abs(moved.x)).toBeLessThan(1e-6);
      expect(avatar.scene.position.y).toBe(baseY);
      expect(shin()).toBeLessThan(0.01);
      expect(body.misses()).toEqual([]);
    });
  });
});

describe('ContactBody on the reading-room armchair', () => {
  const room = builtInRoom('reading-room');
  const chair = room.objects.find((object) => object.id === 'armchair')!;
  const chairYaw = deg(chair.rotationY ?? 0);
  let physics: RoomPhysics;

  beforeAll(async () => {
    physics = await RoomPhysics.create(room, new Map());
  });
  afterAll(() => physics.dispose());

  /** The avatar sits turned like the chair at (localX, localZ) in the chair's frame (x across, z forward). The root is in world space, as in the app. */
  function inChair(localX: number, localZ: number, thigh: number, knee: number, shin = 0.22) {
    const avatar = buildAvatar(shin);
    avatar.scene.rotation.y = chairYaw;
    avatar.scene.position.set(
      chair.position[0] + localX * Math.cos(chairYaw) + localZ * Math.sin(chairYaw),
      0,
      chair.position[2] - localX * Math.sin(chairYaw) + localZ * Math.cos(chairYaw),
    );
    avatar.bones.get('hips')!.position.set(0, 0.44 + 0.09, 0);
    for (const side of ['left', 'right']) {
      avatar.bones.get(`${side}UpperLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(thigh));
      avatar.bones.get(`${side}LowerLeg`)!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(knee));
    }
    avatar.scene.updateMatrixWorld(true);
    return avatar;
  }

  /** A world point in the chair's frame (x across, z forward). */
  function chairFrame(point: THREE.Vector3): { x: number; z: number } {
    const dx = point.x - chair.position[0];
    const dz = point.z - chair.position[2];
    return { x: dx * Math.cos(chairYaw) - dz * Math.sin(chairYaw), z: dx * Math.sin(chairYaw) + dz * Math.cos(chairYaw) };
  }

  const JOINTS = ['UpperLeg', 'LowerLeg', 'Foot', 'UpperArm', 'LowerArm', 'Hand'].flatMap((name) => ['left', 'right'].map((side) => side + name));
  function animatedPose(avatar: ReturnType<typeof inChair>) {
    return new Map(JOINTS.map((name) => [name, avatar.bones.get(name)!.quaternion.clone()]));
  }
  function frames(avatar: ReturnType<typeof inChair>, body: ContactBody, count: number, animated: Map<string, THREE.Quaternion>) {
    for (let i = 0; i < count; i += 1) {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
      body.update(avatar, physics, 1 / 60, [], null, 'armchair');
    }
  }
  function expectAsAnimated(avatar: ReturnType<typeof inChair>, animated: Map<string, THREE.Quaternion>) {
    for (const [name, q] of animated) expect(avatar.bones.get(name)!.quaternion.equals(q)).toBe(true);
  }

  /** Far enough forward that the hanging shins clear the chair's base. */
  const SIT_Z = 0.15;

  /** The left thigh's centre sits 0.01 m outside the left armrest's inner face (chair x = 0.31), so it overlaps it by about 0.065 m. */
  const IN_LEFT_ARMREST = 0.3 - 0.09;

  it('moves the root away from an armrest the leg is in and leaves every joint as animated', () => {
    const avatar = inChair(IN_LEFT_ARMREST, SIT_Z, 90, 90);
    const animated = animatedPose(avatar);
    const body = new ContactBody(avatar.humanoid);
    const startX = chairFrame(avatar.scene.position).x;
    const hip = worldPoint(avatar.bones.get('leftUpperLeg')!);
    const knee = worldPoint(avatar.bones.get('leftLowerLeg')!);
    expect(depthOf(physics, hip, knee, CAPSULE_RADII.thigh)).toBeGreaterThan(0.05);

    frames(avatar, body, 90, animated);
    avatar.scene.updateMatrixWorld(true);

    const moved = chairFrame(avatar.scene.position).x - startX;
    expect(moved).toBeLessThan(-0.04); // towards the middle of the chair
    expect(moved).toBeGreaterThan(-MAX_BODY_SHIFT);
    expectAsAnimated(avatar, animated);
    expect(moved).toBeGreaterThan(-0.09); // about the overlap, not a throw
    expect(body.misses()).toEqual([]);
  });

  it('shifts the root by at most MAX_BODY_SHIFT, and the leg left in the furniture is a miss', () => {
    // Standing legs inside the chair's base: the way out is far more than the cap.
    const avatar = buildAvatar();
    avatar.scene.position.set(chair.position[0] + 0.15, 0, chair.position[2]);
    avatar.scene.updateMatrixWorld(true);
    const body = new ContactBody(avatar.humanoid);
    const start = avatar.scene.position.clone();
    for (let i = 0; i < 120; i += 1) body.update(avatar, physics, 1 / 60, [], null, null);
    const sideways = Math.hypot(avatar.scene.position.x - start.x, avatar.scene.position.z - start.z);
    expect(sideways).toBeGreaterThan(MAX_BODY_SHIFT - 0.005);
    expect(sideways).toBeLessThanOrEqual(MAX_BODY_SHIFT + 1e-6);
    const target = (body.traceSnapshot().bodyShift as { target: number[] }).target;
    expect(Math.hypot(target[0]!, target[2]!)).toBeCloseTo(MAX_BODY_SHIFT, 2); // the trace rounds to the millimetre
    expect(body.misses().length).toBeGreaterThan(0);
  });

  it('barely moves the root when both armrests are touched equally', () => {
    const avatar = inChair(0, SIT_Z, 90, 90);
    avatar.bones.get('leftUpperLeg')!.position.x = 0.3;
    avatar.bones.get('rightUpperLeg')!.position.x = -0.3;
    avatar.scene.updateMatrixWorld(true);
    for (const side of ['left', 'right']) {
      const thigh = avatar.bones.get(`${side}UpperLeg`)!;
      const knee = avatar.bones.get(`${side}LowerLeg`)!;
      expect(depthOf(physics, worldPoint(thigh), worldPoint(knee), CAPSULE_RADII.thigh)).toBeGreaterThan(0.05);
    }
    const animated = animatedPose(avatar);
    const body = new ContactBody(avatar.humanoid);
    const start = avatar.scene.position.clone();
    frames(avatar, body, 90, animated);
    expect(Math.abs(chairFrame(avatar.scene.position).x - chairFrame(start).x)).toBeLessThan(0.01);
    expectAsAnimated(avatar, animated);
  });

  it('eases the shift back to zero once the animation leaves the armrest', () => {
    const avatar = inChair(IN_LEFT_ARMREST, SIT_Z, 90, 90);
    const animated = animatedPose(avatar);
    const body = new ContactBody(avatar.humanoid);
    const start = avatar.scene.position.clone();
    frames(avatar, body, 90, animated);
    expect(avatar.scene.position.distanceTo(start)).toBeGreaterThan(0.04);
    // The animation now keeps the body in the middle of the chair: the hips move over by the shift and more.
    avatar.bones.get('hips')!.position.x = -0.2;
    frames(avatar, body, 120, animated);
    expect(avatar.scene.position.x).toBeCloseTo(start.x, 3);
    expect(avatar.scene.position.z).toBeCloseTo(start.z, 3);
    expect(body.traceSnapshot().bodyShift).toMatchObject({ applied: [0, 0, 0], target: [0, 0, 0] });
  });

  it('keeps the root where it is after forgetHorizontalShift(): the shift is not eased back out', () => {
    const avatar = inChair(IN_LEFT_ARMREST, SIT_Z, 90, 90);
    const animated = animatedPose(avatar);
    const body = new ContactBody(avatar.humanoid);
    frames(avatar, body, 90, animated);
    const placed = avatar.scene.position.clone();
    body.forgetHorizontalShift();
    expect(avatar.scene.position.equals(placed)).toBe(true);
    const applied = (body.traceSnapshot().bodyShift as { applied: number[] }).applied;
    expect([applied[0], applied[2]]).toEqual([0, 0]);
    frames(avatar, body, 1, animated);
    // The body is already clear where it stands, so nothing pulls it back.
    expect(avatar.scene.position.distanceTo(placed)).toBeLessThan(0.002);
    frames(avatar, body, 60, animated);
    expect(avatar.scene.position.distanceTo(placed)).toBeLessThan(0.005);
  });

  it('resetLift() forgets every axis without moving the root', () => {
    const avatar = inChair(IN_LEFT_ARMREST, SIT_Z, 90, 90);
    const animated = animatedPose(avatar);
    const body = new ContactBody(avatar.humanoid);
    frames(avatar, body, 60, animated);
    const placed = avatar.scene.position.clone();
    body.resetLift();
    expect(avatar.scene.position.equals(placed)).toBe(true);
    expect(body.traceSnapshot().bodyShift).toMatchObject({ applied: [0, 0, 0] });
  });
});
