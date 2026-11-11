import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RoomStage } from '../../src/rooms/room-stage.js';
import { RoomOccupancy } from '../../src/rooms/room-occupancy.js';
import { RoomSceneEnv, type AvatarRig } from '../../src/rooms/scene-env.js';
import { surfaceSpec } from '../../src/rooms/scene-actions.js';
import { builtInRoom } from './fixtures.js';

function buildRig(baseRotationY = 0): AvatarRig & { hands: Record<'left' | 'right', THREE.Object3D> } {
  const scene = new THREE.Group();
  scene.rotation.y = baseRotationY;
  scene.scale.setScalar(1.25);
  const bones = new Map<string, THREE.Object3D>();
  const hands = { left: new THREE.Object3D(), right: new THREE.Object3D() };
  scene.add(hands.left, hands.right);
  bones.set('leftHand', hands.left);
  bones.set('rightHand', hands.right);
  return {
    scene,
    baseRotationY,
    restHipsHeight: 0.9,
    humanoid: { getNormalizedBoneNode: (name) => bones.get(name) ?? null },
    hands,
  };
}

describe('RoomSceneEnv', () => {
  const room = builtInRoom('reading-room');
  let stage: RoomStage;
  let rig: ReturnType<typeof buildRig>;
  let env: RoomSceneEnv;

  beforeEach(async () => {
    stage = await RoomStage.create(room);
    rig = buildRig(Math.PI);
    env = new RoomSceneEnv({ stage: () => stage, rig: () => rig });
  });

  it('describes the avatar as a motion frame: root x/z, yaw without the model base rotation, and scale', () => {
    rig.scene.position.set(1, 0.1, -2);
    rig.scene.rotation.y = Math.PI + 0.5;
    const world = env.planWorld()!;
    expect(world.frame.origin.x).toBe(1);
    expect(world.frame.origin.z).toBe(-2);
    expect(world.frame.origin.yaw).toBeCloseTo(0.5, 9);
    expect(world.frame.scale).toBe(1.25);
    expect(world.restHipsHeight).toBe(0.9);
    expect(world.room.id).toBe(room.id);
  });

  it('leaves others and occupancy undefined while the avatar is alone', () => {
    const alone = new RoomSceneEnv({ stage: () => stage, rig: () => rig, avatarId: 'echo', occupancy: () => null });
    const world = alone.planWorld()!;
    expect(world.others).toBeUndefined();
    expect(world.occupancy).toBeUndefined();
    expect(env.planWorld()!.occupancy).toBeUndefined();
  });

  it('fills the other avatars and a bound occupancy handle when the room is shared', () => {
    const occupancy = new RoomOccupancy();
    occupancy.standing('sage', { x: 1, z: -1 });
    rig.scene.position.set(0, 0, -0.3);
    const shared = new RoomSceneEnv({ stage: () => stage, rig: () => rig, avatarId: 'echo', occupancy: () => occupancy });
    const world = shared.planWorld()!;
    expect(world.others).toEqual([{ id: 'sage', x: 1, z: -1 }]);
    expect(world.occupancy).toBeDefined();
    // Its own spot is recorded for the others, and kept up to date by root poses.
    expect(occupancy.others('sage')).toEqual([{ id: 'echo', x: 0, z: -0.3 }]);
    shared.setRootPose({ x: 2, z: 1, yaw: 0 });
    expect(occupancy.others('sage')).toEqual([{ id: 'echo', x: 2, z: 1 }]);
    world.occupancy!.claim('seat', 'sofa');
    expect(occupancy.holder('seat', 'sofa')).toBe('echo');
  });

  it('has no world without a room or an avatar', () => {
    expect(new RoomSceneEnv({ stage: () => null, rig: () => rig }).planWorld()).toBeNull();
    expect(new RoomSceneEnv({ stage: () => stage, rig: () => null }).planWorld()).toBeNull();
  });

  it('bakes a root pose: the scene moves to the point and turns, keeping the model base rotation', () => {
    env.setRootPose({ x: 2, z: 1, yaw: -1 });
    expect(rig.scene.position.x).toBe(2);
    expect(rig.scene.position.z).toBe(1);
    expect(rig.scene.rotation.y).toBeCloseTo(Math.PI - 1, 9);
    expect(env.planWorld()!.frame.origin.yaw).toBeCloseTo(-1, 9);
  });

  it('picks the mug up into the hand keeping its place in the world, and physics leaves it alone', () => {
    const mug = stage.objectNode('mug')!;
    const before = stage.objectPosition('mug')!;
    rig.hands.right.position.set(0.3, 0.9, 0.2);
    rig.scene.position.set(-0.2, 0, 0.4);
    rig.scene.updateWorldMatrix(true, true);
    expect(env.attach('mug', 'right')).toBe(true);
    expect(mug.parent).toBe(rig.hands.right);
    const after = stage.objectPosition('mug')!;
    for (let i = 0; i < 3; i += 1) expect(after[i]!).toBeCloseTo(before[i]!, 4);
    expect(env.carriedIds).toEqual(['mug']);

    // The hand moves: the mug follows by the same amount, and physics steps don't pull it back to the table.
    const handBefore = rig.hands.right.getWorldPosition(new THREE.Vector3());
    rig.hands.right.position.set(0.3, 1.2, 0.5);
    for (let i = 0; i < 30; i += 1) stage.step(1 / 60, rig.scene);
    const moved = stage.objectPosition('mug')!;
    const handAfter = rig.hands.right.getWorldPosition(new THREE.Vector3());
    expect(moved[1]).toBeGreaterThan(before[1]! + 0.1);
    expect(moved[0] - after[0]!).toBeCloseTo(handAfter.x - handBefore.x, 4);
    expect(moved[1] - after[1]!).toBeCloseTo(handAfter.y - handBefore.y, 4);
    expect(moved[2] - after[2]!).toBeCloseTo(handAfter.z - handBefore.z, 4);
    expect(mug.parent).toBe(rig.hands.right);
  });

  it('refuses to pick up what is missing or already carried', () => {
    expect(env.attach('nothing', 'left')).toBe(false);
    expect(env.attach('mug', 'left')).toBe(true);
    expect(env.attach('mug', 'right')).toBe(false);
  });

  it('puts the mug on a surface under the hand, clamped onto the top, and lets physics have it again', () => {
    const table = room.objects.find((o) => o.id === 'coffee-table')!;
    const surface = surfaceSpec(table)!;
    env.attach('mug', 'right');
    // The hand is well beyond the table's edge; the mug lands on the nearest part of the top.
    rig.scene.position.set(0, 0, 0);
    rig.scene.updateWorldMatrix(true, true);
    rig.hands.right.position.copy(rig.scene.worldToLocal(new THREE.Vector3(table.position[0] + 3, 0.6, table.position[2] + 3)));
    rig.scene.updateWorldMatrix(true, true);
    env.detach({ t: 1.7, kind: 'detach', objectId: 'mug', hand: 'right', surface });
    const mug = stage.objectNode('mug')!;
    expect(mug.parent).toBe(stage.propParent);
    expect(env.carriedIds).toEqual([]);
    expect(mug.position.y).toBeCloseTo(0.42, 6);
    expect(mug.position.x).toBeCloseTo(table.position[0] + 0.5 - 0.15, 6);
    expect(mug.position.z).toBeCloseTo(table.position[2] + 0.3 - 0.15, 6);
    // Dynamic again: it settles on the table instead of floating or falling through.
    for (let i = 0; i < 120; i += 1) stage.step(1 / 60, rig.scene);
    const rest = stage.objectPosition('mug')!;
    expect(rest[1]).toBeGreaterThan(0.4);
    expect(rest[1]).toBeLessThan(0.45);
  });

  it('puts a carried object back where it was picked up when the room goes away', () => {
    const origin = stage.objectPosition('mug')!;
    rig.hands.left.position.set(1, 1, 1);
    rig.scene.updateWorldMatrix(true, true);
    env.attach('mug', 'left');
    rig.hands.left.position.set(2, 1.5, 0);
    env.releaseHeld();
    const mug = stage.objectNode('mug')!;
    expect(mug.parent).toBe(stage.propParent);
    expect(env.carriedIds).toEqual([]);
    expect(mug.position.x).toBeCloseTo(origin[0], 6);
    expect(mug.position.y).toBeCloseTo(origin[1], 6);
    expect(mug.position.z).toBeCloseTo(origin[2], 6);
  });

  it('closes the hand on a pick up and opens it on a put down', () => {
    const chain = (side: 'left' | 'right') => {
      const names = ['Index', 'Middle', 'Ring', 'Little']
        .flatMap((f) => ['Proximal', 'Intermediate', 'Distal'].map((j) => `${side}${f}${j}`))
        .concat(['Metacarpal', 'Proximal', 'Distal'].map((j) => `${side}Thumb${j}`));
      return names;
    };
    const fingers = new Map<string, THREE.Object3D>();
    for (const name of chain('right')) {
      const bone = new THREE.Object3D();
      bone.position.set(-0.03, 0, 0);
      rig.hands.right.add(bone);
      fingers.set(name, bone);
    }
    const base = rig.humanoid;
    rig.humanoid = { getNormalizedBoneNode: (name) => fingers.get(name) ?? base.getNormalizedBoneNode(name) };
    env.attach('mug', 'right');
    for (let i = 0; i < 20; i += 1) env.step(0.05);
    const curled = fingers.get('rightIndexProximal')!.quaternion.angleTo(new THREE.Quaternion());
    expect(curled).toBeGreaterThan(0.5);
    env.releaseHeld();
    for (let i = 0; i < 20; i += 1) env.step(0.05);
    expect(fingers.get('rightIndexProximal')!.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
  });
});
