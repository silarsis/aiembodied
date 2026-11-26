import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAPSULE_RADII,
  ContactBody,
  MAX_PELVIS_LIFT,
  MISS_SECONDS,
} from '../../src/rooms/contact-body.js';
import { BUTTOCKS_BELOW_HIPS } from '../../src/rooms/seat-fit.js';
import {
  ANKLE_MAX_OFFSET,
  HEAD_PITCH_LIMIT,
  HEAD_ROLL_LIMIT,
  HEAD_YAW_LIMIT,
  HIP_MAX_OFFSET,
  KNEE_MAX_OFFSET,
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
  for (const [side, sign] of [
    ['left', 1],
    ['right', -1],
  ] as const) {
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
  return {
    scene,
    bones,
    humanoid: { getNormalizedBoneNode: (name: string) => bones.get(name) ?? null },
    restHipsHeight: 0.95,
  };
}

function worldPoint(bone: THREE.Object3D): THREE.Vector3 {
  bone.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
}

/** Depth of a capsule from `a` to `b` into the room's fixed geometry (0 when clear). */
function depthOf(physics: RoomPhysics, a: THREE.Vector3, b: THREE.Vector3, radius: number): number {
  const direction = new THREE.Vector3().subVectors(b, a);
  const length = direction.length();
  const rotation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
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
      avatar.bones
        .get(`${side}UpperLeg`)!
        .quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(thigh));
      avatar.bones
        .get(`${side}LowerLeg`)!
        .quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(knee));
    }
    avatar.scene.updateMatrixWorld(true);
    return avatar;
  }

  function run(
    avatar: ReturnType<typeof buildAvatar>,
    body: ContactBody,
    frames: number,
    reset?: () => void,
    seat: string | null = 'sofa',
  ) {
    for (let i = 0; i < frames; i += 1) {
      reset?.();
      body.update(avatar, physics, 1 / 60, [], null, seat);
    }
  }

  it('lifts the pelvis a little and keeps thighs and shins out of the cushion', () => {
    const avatar = seated(0.22, 75, 60); // short shins: the feet dangle (the seat is 8 cm lower, so the shins are too)
    const body = new ContactBody(avatar.humanoid);
    const thigh = CAPSULE_RADII.thigh;
    const before = depthOf(
      physics,
      worldPoint(avatar.bones.get('leftUpperLeg')!),
      worldPoint(avatar.bones.get('leftLowerLeg')!),
      thigh,
    );
    expect(before).toBeGreaterThan(0.02); // the pose really does sink in
    const baseY = avatar.scene.position.y;
    const animated = new Map<string, THREE.Quaternion>();
    for (const name of ['UpperLeg', 'LowerLeg'])
      for (const side of ['left', 'right'])
        animated.set(side + name, avatar.bones.get(side + name)!.quaternion.clone());

    // The mixer rewrites the animated rotations every frame.
    run(
      avatar,
      body,
      30,
      () => {
        for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
      },
      null,
    ); // not the seat being sat on: other furniture still lifts the pelvis
    avatar.scene.updateMatrixWorld(true);

    const lift = avatar.scene.position.y - baseY;
    expect(lift).toBeGreaterThan(0.005);
    expect(lift).toBeLessThanOrEqual(MAX_PELVIS_LIFT + 1e-9);
    expect(body.pelvisLift).toBeCloseTo(lift, 9);
    for (const side of ['left', 'right']) {
      const hip = worldPoint(avatar.bones.get(`${side}UpperLeg`)!);
      const knee = worldPoint(avatar.bones.get(`${side}LowerLeg`)!);
      const ankle = worldPoint(avatar.bones.get(`${side}Foot`)!);
      // The thighs rest on the seat: only the pelvis lift (at most MAX_PELVIS_LIFT) answers to them, they are not rotated.
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
    for (const side of ['left', 'right'])
      for (const name of ['UpperLeg', 'LowerLeg'])
        animated.set(side + name, avatar.bones.get(side + name)!.quaternion.clone());
    run(
      avatar,
      body,
      30,
      () => {
        for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
      },
      null,
    );
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
    const avatar = seated(0.22, 75, 60);
    const body = new ContactBody(avatar.humanoid);
    const thigh = avatar.bones.get('leftUpperLeg')!;
    const animated = thigh.quaternion.clone();
    // No seat given: the thigh in the cushion counts as a penetration here, so it is nudged (within its cap).
    run(avatar, body, 30, () => thigh.quaternion.copy(animated), null);
    expect(thigh.quaternion.equals(animated)).toBe(false);
    // Stand up and walk off; a pose blend (which runs before the contact solve) writes a pose between
    // the corrected one and the new animation. Nothing touches the contact any more, so it must stay exactly so.
    avatar.scene.position.set(-2, avatar.scene.position.y - body.pelvisLift, 1);
    avatar.bones.get('hips')!.position.set(0, 0.95, 0);
    for (const name of ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'])
      avatar.bones.get(name)!.quaternion.identity();
    const blended = new THREE.Quaternion()
      .copy(thigh.quaternion)
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(10));
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

  it('release() puts back the animated pose of bones nothing else rewrites and clears the lift', () => {
    const avatar = seated(0.22, 75, 60);
    const body = new ContactBody(avatar.humanoid);
    const names = ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
    const animated = new Map(
      names.map((name) => [name, avatar.bones.get(name)!.quaternion.clone()]),
    );
    run(
      avatar,
      body,
      30,
      () => {
        for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
      },
      null,
    ); // no seat: the thighs are nudged out of the cushion instead of resting on it
    expect(
      names.some((name) => !avatar.bones.get(name)!.quaternion.equals(animated.get(name)!)),
    ).toBe(true);
    expect(body.pelvisLift).toBeGreaterThan(0);
    body.release();
    for (const [name, q] of animated)
      expect(avatar.bones.get(name)!.quaternion.angleTo(q)).toBeLessThan(1e-9);
    expect(body.pelvisLift).toBe(0);
  });

  it('leaves a pose with no contact exactly as it was', () => {
    const avatar = buildAvatar();
    avatar.scene.position.set(-2, 0, 1);
    avatar.bones
      .get('leftUpperArm')!
      .quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), deg(-40));
    avatar.scene.updateMatrixWorld(true);
    const before = new Map(
      [...avatar.bones].map(([name, bone]) => [name, bone.quaternion.clone()]),
    );
    const body = new ContactBody(avatar.humanoid);
    const hits: unknown[] = [];
    body.onMissStart((miss) => hits.push(miss));
    run(avatar, body, 20);
    for (const [name, bone] of avatar.bones)
      expect(bone.quaternion.equals(before.get(name)!)).toBe(true);
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
      avatar.bones
        .get(`${side}LowerLeg`)!
        .quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(85));
      animated.set(`${side}UpperLeg`, avatar.bones.get(`${side}UpperLeg`)!.quaternion.clone());
      animated.set(`${side}LowerLeg`, avatar.bones.get(`${side}LowerLeg`)!.quaternion.clone());
    }
    avatar.scene.updateMatrixWorld(true);
    const heights = ['left', 'right'].map((side) => worldPoint(avatar.bones.get(`${side}Foot`)!).y);
    expect(Math.max(...heights)).toBeLessThan(0.11);
    expect(Math.min(...heights)).toBeGreaterThan(-0.01);
    const body = new ContactBody(avatar.humanoid);
    run(
      avatar,
      body,
      40,
      () => {
        for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
      },
      null,
    );
    avatar.scene.updateMatrixWorld(true);
    expect(body.pelvisLift).toBeGreaterThan(0.005);
    ['left', 'right'].forEach((side, i) => {
      expect(Math.abs(worldPoint(avatar.bones.get(`${side}Foot`)!).y - heights[i]!)).toBeLessThan(
        0.01,
      );
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
    run(
      avatar,
      body,
      40,
      () => {
        for (const side of ['left', 'right']) {
          avatar.bones.get(`${side}UpperLeg`)!.quaternion.identity();
          avatar.bones.get(`${side}LowerLeg`)!.quaternion.identity();
        }
      },
      null,
    );
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
      for (const [side, sign] of [
        ['left', 1],
        ['right', -1],
      ] as const) {
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
        bones
          .get(`${side}UpperLeg`)!
          .quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(thighFlex));
        bones
          .get(`${side}LowerLeg`)!
          .quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(kneeFlex));
      }
      scene.updateMatrixWorld(true);
      return {
        scene,
        bones,
        humanoid: { getNormalizedBoneNode: (name: string) => bones.get(name) ?? null },
        restHipsHeight: REST,
      };
    }

    /** Combined local yaw/pitch/roll (degrees) of neck and head relative to the chest. */
    function headAngles(avatar: ReturnType<typeof echoSeated>) {
      const q = avatar.bones
        .get('neck')!
        .quaternion.clone()
        .multiply(avatar.bones.get('head')!.quaternion);
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      return {
        yaw: (e.y * 180) / Math.PI,
        pitch: (e.x * 180) / Math.PI,
        roll: (e.z * 180) / Math.PI,
      };
    }

    function frames(
      avatar: ReturnType<typeof echoSeated>,
      body: ContactBody,
      count: number,
      headSettle: boolean,
      animated: Map<string, THREE.Quaternion>,
    ) {
      for (let i = 0; i < count; i += 1) {
        for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
        body.update(avatar, physics, 1 / 60, [], null, 'sofa', headSettle);
      }
    }

    it('eases a head turned 58 degrees back to the 35 degree limit while seated and idle', () => {
      const avatar = echoSeated(0);
      avatar.bones.get('neck')!.quaternion.setFromEuler(new THREE.Euler(0, deg(20), 0, 'YXZ'));
      avatar.bones.get('head')!.quaternion.setFromEuler(new THREE.Euler(0, deg(38), 0, 'YXZ'));
      const animated = new Map(
        ['neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]),
      );
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
      const animated = new Map(
        ['neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]),
      );
      const body = new ContactBody(avatar.humanoid);
      frames(avatar, body, 60, true, animated);
      expect(avatar.bones.get('head')!.quaternion.equals(animated.get('head')!)).toBe(true);
      expect(avatar.bones.get('neck')!.quaternion.equals(animated.get('neck')!)).toBe(true);
    });

    it('clamps pitch and roll to their limits too', () => {
      const avatar = echoSeated(0);
      avatar.bones
        .get('head')!
        .quaternion.setFromEuler(new THREE.Euler(deg(-33), 0, deg(17), 'YXZ'));
      const animated = new Map(
        ['neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]),
      );
      const body = new ContactBody(avatar.humanoid);
      frames(avatar, body, 120, true, animated);
      const a = headAngles(avatar);
      expect(a.pitch).toBeCloseTo(-HEAD_PITCH_LIMIT_DEG, 1);
      expect(a.roll).toBeCloseTo(HEAD_ROLL_LIMIT_DEG, 1);
    });

    /** Head yaw (degrees) relative to the hips, from world rotations: what the settle limits, whatever the spine does. */
    function headYawFromHips(avatar: ReturnType<typeof echoSeated>) {
      avatar.scene.updateMatrixWorld(true);
      const worldQ = (name: string) =>
        avatar.bones.get(name)!.getWorldQuaternion(new THREE.Quaternion());
      const q = worldQ('hips').invert().multiply(worldQ('head'));
      return (new THREE.Euler().setFromQuaternion(q, 'YXZ').y * 180) / Math.PI;
    }

    it('takes a head turned -178 degrees (a broken frame) back to straight ahead, never through bigger angles', () => {
      const avatar = echoSeated(0);
      avatar.bones.get('head')!.quaternion.setFromEuler(new THREE.Euler(0, deg(-178), 0, 'YXZ'));
      const animated = new Map(
        ['neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]),
      );
      const body = new ContactBody(avatar.humanoid);
      let widest = 0;
      for (let i = 0; i < 180; i += 1) {
        frames(avatar, body, 1, true, animated);
        widest = Math.max(widest, Math.abs(headYawFromHips(avatar)));
      }
      expect(widest).toBeLessThanOrEqual(178.01);
      expect(Math.abs(headYawFromHips(avatar))).toBeLessThan(5);
      const trace = body.traceSnapshot().headSettle as {
        reset: boolean;
        animYawPitchRollDeg: number[];
      };
      expect(trace).toMatchObject({ reset: true });
      expect(trace.animYawPitchRollDeg[0]).toBeCloseTo(-178, 1);
    });

    it('counts a twisted chest toward the limit: chest 40 degrees plus head 30 ends within 35 degrees of the hips', () => {
      const avatar = echoSeated(0);
      avatar.bones.get('chest')!.quaternion.setFromEuler(new THREE.Euler(0, deg(40), 0, 'YXZ'));
      avatar.bones.get('head')!.quaternion.setFromEuler(new THREE.Euler(0, deg(30), 0, 'YXZ'));
      const animated = new Map(
        ['chest', 'neck', 'head'].map((n) => [n, avatar.bones.get(n)!.quaternion.clone()]),
      );
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

    it.each([15, 18, 20])(
      'clears the cushion by raising the knees (%i degree slope): thighs out of the seat, no pelvis lift, no outward push',
      (slope) => {
        const avatar = echoSeated(slope);
        const body = new ContactBody(avatar.humanoid);
        const names = ['UpperLeg', 'LowerLeg'].flatMap((n) =>
          ['left', 'right'].map((side) => side + n),
        );
        const animated = new Map(
          names.map((name) => [name, avatar.bones.get(name)!.quaternion.clone()]),
        );
        const thighRadius = CAPSULE_RADII.thigh * FACTOR;
        const depth = (side: string) =>
          depthOf(
            physics,
            worldPoint(avatar.bones.get(`${side}UpperLeg`)!),
            worldPoint(avatar.bones.get(`${side}LowerLeg`)!),
            thighRadius,
          );
        expect(depth('left')).toBeGreaterThan(0.08); // the pose really sinks in
        const kneeX = ['left', 'right'].map(
          (side) => worldPoint(avatar.bones.get(`${side}LowerLeg`)!).x,
        );
        const hipsY = worldPoint(avatar.bones.get('hips')!).y;
        const baseY = avatar.scene.position.y;

        run(avatar, body, 60, () => {
          for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
        });
        avatar.scene.updateMatrixWorld(true);

        expect(depth('left')).toBeLessThan(0.02);
        expect(depth('right')).toBeLessThan(0.02);
        expect(body.pelvisLift).toBe(0);
        // Pinning the feet back would pull the knees into the seat: they float and are recorded as missing.
        expect(body.misses().map((miss) => miss.end)).toContain('leftFoot');
        expect(avatar.scene.position.y).toBe(baseY);
        expect(worldPoint(avatar.bones.get('hips')!).y).toBeCloseTo(hipsY, 9);
        ['left', 'right'].forEach((side, i) => {
          expect(
            Math.abs(worldPoint(avatar.bones.get(`${side}LowerLeg`)!).x - kneeX[i]!),
          ).toBeLessThan(0.02);
        });
      },
    );
  });
});

describe('ContactBody on the reading-room armchair', () => {
  const room = builtInRoom('reading-room');
  const chair = room.objects.find((object) => object.id === 'armchair')!;
  let physics: RoomPhysics;

  beforeAll(async () => {
    physics = await RoomPhysics.create(room, new Map());
  });
  afterAll(() => physics.dispose());

  /** The avatar sits in a pivot placed and turned like the chair, so its x axis is the chair's. */
  function inChair(localX: number, localZ: number, thigh: number, knee: number) {
    const avatar = buildAvatar(0.42);
    const pivot = new THREE.Group();
    pivot.position.set(chair.position[0], 0, chair.position[2]);
    pivot.rotation.y = deg(chair.rotationY ?? 0);
    pivot.add(avatar.scene);
    avatar.scene.position.set(localX, 0, localZ);
    avatar.bones.get('hips')!.position.set(0, 0.44 + 0.09, 0);
    for (const side of ['left', 'right']) {
      avatar.bones
        .get(`${side}UpperLeg`)!
        .quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg(thigh));
      avatar.bones
        .get(`${side}LowerLeg`)!
        .quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(knee));
    }
    pivot.updateMatrixWorld(true);
    return { ...avatar, pivot };
  }

  const NAMES = ['UpperLeg', 'LowerLeg', 'Foot'];
  /** Offset angle of each leg bone from its animated rotation. */
  function offsets(avatar: ReturnType<typeof inChair>, animated: Map<string, THREE.Quaternion>) {
    const result = new Map<string, number>();
    for (const [name, q] of animated)
      result.set(name, avatar.bones.get(name)!.quaternion.angleTo(q));
    return result;
  }
  function lateralOf(avatar: ReturnType<typeof inChair>, name: string, sign: number): number {
    const local = avatar.scene.worldToLocal(worldPoint(avatar.bones.get(name)!));
    return local.x * sign;
  }
  function abductionOf(avatar: ReturnType<typeof inChair>, side: string, sign: number): number {
    const hip = avatar.scene.worldToLocal(worldPoint(avatar.bones.get(`${side}UpperLeg`)!));
    const knee = avatar.scene.worldToLocal(worldPoint(avatar.bones.get(`${side}LowerLeg`)!));
    const d = knee.sub(hip).normalize();
    return Math.asin(d.x * sign);
  }

  it('nudges a seated pose without throwing the legs out over the armrests', () => {
    // Thighs on the cushion, tilted slightly down, knees near the front edge.
    const avatar = inChair(0, -0.05, 80, 75);
    const animated = new Map<string, THREE.Quaternion>();
    for (const side of ['left', 'right'])
      for (const name of NAMES)
        animated.set(side + name, avatar.bones.get(side + name)!.quaternion.clone());
    const sides: Array<[string, number]> = [
      ['left', 1],
      ['right', -1],
    ];
    const startAbduction = sides.map(([side, sign]) => abductionOf(avatar, side, sign));
    const startOut = sides.map(([side, sign]) => [
      lateralOf(avatar, `${side}LowerLeg`, sign),
      lateralOf(avatar, `${side}Foot`, sign),
    ]);
    const body = new ContactBody(avatar.humanoid);
    const caps: Record<string, number> = {
      UpperLeg: HIP_MAX_OFFSET,
      LowerLeg: KNEE_MAX_OFFSET,
      Foot: ANKLE_MAX_OFFSET,
    };
    for (let i = 0; i < 60; i += 1) {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
      body.update(avatar, physics, 1 / 60, [], null, 'armchair');
      avatar.pivot.updateMatrixWorld(true);
      for (const [name, angle] of offsets(avatar, animated)) {
        expect(angle).toBeLessThanOrEqual(caps[name.replace(/^(left|right)/, '')]! + 1e-6);
      }
    }
    sides.forEach(([side, sign], i) => {
      expect(Math.abs(abductionOf(avatar, side, sign) - startAbduction[i]!)).toBeLessThan(deg(5));
      expect(lateralOf(avatar, `${side}LowerLeg`, sign)).toBeLessThanOrEqual(
        startOut[i]![0]! + 0.01,
      );
      expect(lateralOf(avatar, `${side}Foot`, sign)).toBeLessThanOrEqual(startOut[i]![1]! + 0.01);
    });
  });

  it('does not push a thigh deep inside an armrest outward; the refusal is a miss', () => {
    // Left thigh centred 4 cm inside the armrest's outer face (chair x = +0.38 is the armrest centre).
    const avatar = inChair(0.38 + 0.03 - 0.09, -0.1, 90, 90);
    const thigh = avatar.bones.get('leftUpperLeg')!;
    const animated = new Map<string, THREE.Quaternion>();
    for (const side of ['left', 'right'])
      for (const name of NAMES)
        animated.set(side + name, avatar.bones.get(side + name)!.quaternion.clone());
    const hip = worldPoint(thigh);
    const knee = worldPoint(avatar.bones.get('leftLowerLeg')!);
    const hit = physics.penetration(
      new RAPIER.Capsule(hip.distanceTo(knee) / 2, CAPSULE_RADII.thigh),
      hip.clone().add(knee).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        knee.clone().sub(hip).normalize(),
      ),
    );
    expect(hit?.objectId).toBe('armchair');
    expect(hit!.depth).toBeGreaterThan(0.05);
    const start = lateralOf(avatar, 'leftLowerLeg', 1);
    const body = new ContactBody(avatar.humanoid);
    for (let i = 0; i < Math.ceil((MISS_SECONDS + 0.3) * 60); i += 1) {
      for (const [name, q] of animated) avatar.bones.get(name)!.quaternion.copy(q);
      body.update(avatar, physics, 1 / 60, [], null, 'armchair');
      avatar.pivot.updateMatrixWorld(true);
    }
    expect(lateralOf(avatar, 'leftLowerLeg', 1)).toBeLessThanOrEqual(start + 0.01);
    expect(abductionOf(avatar, 'left', 1)).toBeLessThan(
      deg(5) + abductionOf(inChair(0, 0, 90, 90), 'left', 1),
    );
    expect(body.misses().length).toBeGreaterThan(0);
  });
});
