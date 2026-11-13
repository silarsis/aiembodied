import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { RoomSceneController } from '../../src/rooms/room-scene-controller.js';
import { companionHome } from '../../src/rooms/avatar-placement.js';
import { builtInRoom } from './fixtures.js';

function controller() {
  const canvas = document.createElement('canvas');
  const parent = document.createElement('div');
  parent.append(canvas);
  Object.defineProperty(parent, 'clientWidth', { value: 800 });
  Object.defineProperty(parent, 'clientHeight', { value: 600 });
  const renderer = { setClearColor: () => undefined, setSize: () => undefined } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const instance = new RoomSceneController({ renderer, scene, camera, canvas, legacySize: { width: 480, height: 640 } });
  const avatar = new THREE.Group();
  instance.attachAvatar(avatar);
  return { instance, avatar };
}

describe('RoomSceneController.setRoom', () => {
  const reading = builtInRoom('reading-room');

  it('puts the avatar at home when a room is entered', async () => {
    const { instance, avatar } = controller();
    await instance.setRoom(reading);
    expect(avatar.position.x).toBeCloseTo(reading.home.position[0]);
    expect(avatar.position.z).toBeCloseTo(reading.home.position[2]);
    instance.dispose();
  });

  it('leaves the avatar where it is when the same room is loaded again with a new object', async () => {
    const { instance, avatar } = controller();
    await instance.setRoom(reading);
    avatar.position.set(1.2, 0, -0.7);
    const before = instance.currentStage;

    const withModel = { ...reading, objects: reading.objects.map((o, i) => (i === 0 ? { ...o, name: 'made' } : o)) };
    await instance.setRoom(withModel);
    expect(instance.currentStage).not.toBe(before);
    expect(instance.currentStage).not.toBeNull();
    expect(avatar.position.x).toBeCloseTo(1.2);
    expect(avatar.position.z).toBeCloseTo(-0.7);
    instance.dispose();
  });

  it('puts the avatar at the home of a different room', async () => {
    const { instance, avatar } = controller();
    await instance.setRoom(reading);
    avatar.position.set(1.2, 0, -0.7);
    const studio = builtInRoom('studio-flat');
    await instance.setRoom(studio);
    expect(avatar.position.x).toBeCloseTo(studio.home.position[0]);
    expect(avatar.position.z).toBeCloseTo(studio.home.position[2]);
    instance.dispose();
  });
});

describe('RoomSceneController soles on the floor', () => {
  it('lifts an avatar normalised with its ankles on y = 0 so the soles meet the floor', async () => {
    const canvas = document.createElement('canvas');
    const parent = document.createElement('div');
    parent.append(canvas);
    Object.defineProperty(parent, 'clientWidth', { value: 800 });
    Object.defineProperty(parent, 'clientHeight', { value: 600 });
    const renderer = { setClearColor: () => undefined, setSize: () => undefined } as unknown as THREE.WebGLRenderer;
    const instance = new RoomSceneController({ renderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), canvas, legacySize: { width: 480, height: 640 } });
    const avatar = new THREE.Group();
    avatar.position.y = -0.07; // the 2D normalisation dropped the ankle bone to y = 0
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.3));
    body.position.y = 0.8 - 0.09; // soles 9 cm below the ankle
    avatar.add(body);
    instance.attachAvatar(avatar);
    await instance.setRoom(builtInRoom('reading-room'));
    avatar.updateWorldMatrix(true, true);
    const bottom = new THREE.Box3().setFromObject(body).min.y;
    expect(bottom).toBeCloseTo(builtInRoom('reading-room').home.position[1], 3);
    instance.dispose();
  });
});

describe('RoomSceneController avatar height', () => {
  function tallAvatar() {
    const canvas = document.createElement('canvas');
    const parent = document.createElement('div');
    parent.append(canvas);
    Object.defineProperty(parent, 'clientWidth', { value: 800 });
    Object.defineProperty(parent, 'clientHeight', { value: 600 });
    const renderer = { setClearColor: () => undefined, setSize: () => undefined } as unknown as THREE.WebGLRenderer;
    const instance = new RoomSceneController({ renderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), canvas, legacySize: { width: 480, height: 640 } });
    // Normalised the 2D way: 1.9 m sole to crown, ankles on y = 0, soles 8 cm below.
    const avatar = new THREE.Group();
    avatar.position.set(0.03, -0.02, -0.01);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.9, 0.3));
    body.position.set(-0.03, 0.95 - 0.08 + 0.02, 0.01); // the root is offset so the body centres on the origin
    avatar.add(body);
    instance.attachAvatar(avatar);
    return { instance, avatar, body };
  }

  function bounds(body: THREE.Object3D) {
    body.parent?.updateWorldMatrix(true, true);
    return new THREE.Box3().setFromObject(body);
  }

  it('scales the avatar to the room height with its soles on the floor', async () => {
    const { instance, body } = tallAvatar();
    const room = builtInRoom('reading-room');
    await instance.setRoom(room);
    const box = bounds(body);
    expect(box.max.y - box.min.y).toBeCloseTo(1.6, 3);
    expect(box.min.y).toBeCloseTo(room.home.position[1], 3);
    instance.dispose();
  });

  it('rescales in place when the height setting changes, keeping the soles down and the body where it stands', async () => {
    const { instance, avatar, body } = tallAvatar();
    const room = builtInRoom('reading-room');
    await instance.setRoom(room);
    avatar.position.x += 0.7;
    avatar.rotation.y += 0.8;
    const centre = bounds(body).getCenter(new THREE.Vector3());
    instance.setAvatarHeight(1.3);
    const box = bounds(body);
    expect(box.max.y - box.min.y).toBeCloseTo(1.3, 3);
    expect(box.min.y).toBeCloseTo(room.home.position[1], 3);
    const after = box.getCenter(new THREE.Vector3());
    expect(after.x).toBeCloseTo(centre.x, 3);
    expect(after.z).toBeCloseTo(centre.z, 3);
    instance.dispose();
  });

  it('gives the avatar its 2D size back when the room is left', async () => {
    const { instance, avatar } = tallAvatar();
    await instance.setRoom(builtInRoom('reading-room'));
    await instance.setRoom(null);
    expect(avatar.scale.x).toBeCloseTo(1);
    expect(avatar.position.y).toBeCloseTo(-0.02);
    instance.dispose();
  });
});

describe('RoomSceneController companions', () => {
  it('stands companions beside home in a room and puts them back when it ends', async () => {
    const { instance } = controller();
    const rex = new THREE.Group();
    rex.position.set(0.5, 0, 0);
    const sage = new THREE.Group();
    instance.attachCompanion('rex', rex);
    instance.attachCompanion('sage', sage);
    const room = builtInRoom('reading-room');
    await instance.setRoom(room);
    const right = companionHome(room.home, 0);
    const left = companionHome(room.home, 1);
    expect(rex.position.x).toBeCloseTo(right.position[0] + 0.5 * Math.cos((room.home.facing * Math.PI) / 180), 3);
    expect(sage.position.x).toBeCloseTo(left.position[0]);
    expect(sage.position.z).toBeCloseTo(left.position[2]);
    expect(sage.rotation.y).toBeCloseTo((room.home.facing * Math.PI) / 180);

    await instance.setRoom(null);
    expect(rex.position.x).toBeCloseTo(0.5);
    expect(sage.position.x).toBeCloseTo(0);
    expect(sage.rotation.y).toBeCloseTo(0);
    instance.dispose();
  });

  it('places a companion that loads while a room is showing and leaves the others where they are', async () => {
    const { instance } = controller();
    const room = builtInRoom('reading-room');
    await instance.setRoom(room);
    const a = new THREE.Group();
    const b = new THREE.Group();
    instance.attachCompanion('a', a);
    instance.attachCompanion('b', b);
    expect(b.position.x).toBeCloseTo(companionHome(room.home, 1).position[0]);
    // b has walked off; a leaving and c arriving must not pull b back to a slot.
    b.position.x += 2;
    const walked = b.position.x;
    instance.detachCompanion('a');
    expect(b.position.x).toBeCloseTo(walked);
    const c = new THREE.Group();
    instance.attachCompanion('c', c);
    expect(c.position.x).toBeCloseTo(companionHome(room.home, 0).position[0]);
    expect(b.position.x).toBeCloseTo(walked);
    instance.dispose();
  });
});

describe('RoomSceneController scene envs', () => {
  const humanoid = (hand: THREE.Object3D) => ({
    getNormalizedBoneNode: (name: string) => (name === 'rightHand' ? hand : null),
  });

  it('hands Echo her own sceneEnv, a companion its own, and null for an unknown or humanoid-less avatar', () => {
    const { instance } = controller();
    expect(instance.envFor('echo')).toBe(instance.sceneEnv);
    expect(instance.envFor('sage')).toBeNull();
    const sage = new THREE.Group();
    instance.attachCompanion('sage', sage, humanoid(new THREE.Object3D()), 0.9);
    instance.attachCompanion('rex', new THREE.Group());
    expect(instance.envFor('sage')).not.toBeNull();
    expect(instance.envFor('sage')).not.toBe(instance.sceneEnv);
    expect(instance.envFor('rex')).toBeNull();
    // The env stays the same object when the model reloads.
    const env = instance.envFor('sage');
    instance.attachCompanion('sage', new THREE.Group(), humanoid(new THREE.Object3D()), 0.9);
    expect(instance.envFor('sage')).toBe(env);
    instance.detachCompanion('sage');
    expect(instance.envFor('sage')).toBeNull();
    instance.dispose();
  });

  it('moves the companion\'s root, not Echo\'s, when its env bakes a pose; it stands at its home until then', async () => {
    const { instance, avatar } = controller();
    const sage = new THREE.Group();
    sage.rotation.y = Math.PI;
    instance.attachCompanion('sage', sage, humanoid(new THREE.Object3D()), 0.9);
    const room = builtInRoom('reading-room');
    await instance.setRoom(room);
    const home = companionHome(room.home, 0);
    expect(sage.position.x).toBeCloseTo(home.position[0]);
    const env = instance.envFor('sage')!;
    const world = env.planWorld()!;
    expect(world.frame.origin.x).toBeCloseTo(home.position[0]);
    const echoAt = avatar.position.clone();
    env.setRootPose({ x: 0.4, z: -0.3, yaw: 0.5 });
    expect(sage.position.x).toBe(0.4);
    expect(sage.position.z).toBe(-0.3);
    expect(sage.rotation.y).toBeCloseTo(Math.PI + 0.5);
    expect(avatar.position.equals(echoAt)).toBe(true);
    // Stepping the controller feeds the companion's body to physics without error.
    instance.step(1 / 60);
    // Leaving the room puts it back.
    await instance.setRoom(null);
    expect(sage.rotation.y).toBeCloseTo(Math.PI);
    expect(sage.position.x).toBeCloseTo(0);
    instance.dispose();
  });

  it('puts a companion\'s carried object back when the room goes away', async () => {
    const { instance } = controller();
    const hand = new THREE.Object3D();
    const sage = new THREE.Group();
    sage.add(hand);
    instance.attachCompanion('sage', sage, humanoid(hand), 0.9);
    const room = builtInRoom('reading-room');
    await instance.setRoom(room);
    const env = instance.envFor('sage')!;
    const stage = instance.currentStage!;
    const origin = stage.objectPosition('mug')!;
    expect(env.attach('mug', 'right')).toBe(true);
    expect(env.carriedIds).toEqual(['mug']);
    hand.position.set(0, 1, 0.2);
    await instance.setRoom(null);
    expect(env.carriedIds).toEqual([]);
    expect(origin).toBeTruthy();
    instance.dispose();
  });
});

describe('RoomSceneController places', () => {
  const reading = builtInRoom('reading-room');
  // The reading room's door is in the east wall (x = 3), 1.2 m along it.
  const nearDoor = (x: number, z: number) => Math.hypot(x - 2.65, z - 1.2) < 0.5;

  it('stands Echo just inside the door, facing into the room', async () => {
    const { instance, avatar } = controller();
    await instance.setRoom(reading);
    expect(instance.placeAtDoor('echo')).toBe(true);
    expect(nearDoor(avatar.position.x, avatar.position.z)).toBe(true);
    // Into the room from the east wall is -x.
    expect(avatar.rotation.y).toBeCloseTo(-Math.PI / 2);
    instance.dispose();
  });

  it('stands a companion at the door too, and keeps it there', async () => {
    const { instance } = controller();
    const sage = new THREE.Group();
    instance.attachCompanion('sage', sage);
    await instance.setRoom(reading);
    expect(instance.placeAtDoor('sage')).toBe(true);
    expect(nearDoor(sage.position.x, sage.position.z)).toBe(true);
    // Another companion arriving later does not pull Sage back to her slot.
    instance.attachCompanion('rex', new THREE.Group());
    expect(nearDoor(sage.position.x, sage.position.z)).toBe(true);
    instance.dispose();
  });

  it('does nothing without a room, a door or a body', async () => {
    const { instance } = controller();
    expect(instance.placeAtDoor('echo')).toBe(false);
    await instance.setRoom({ ...reading, shell: { ...reading.shell, openings: [] } });
    expect(instance.placeAtDoor('echo')).toBe(false);
    await instance.setRoom(reading);
    expect(instance.placeAtDoor('ghost')).toBe(false);
    instance.dispose();
  });

  it('forgets a hidden avatar: its spot is free and Echo stops following her body', async () => {
    const { instance } = controller();
    instance.attachCompanion('sage', new THREE.Group());
    await instance.setRoom(reading);
    instance.occupancy.standing('sage', { x: 1, z: 1 });
    expect(instance.occupancy.others('echo').map((other) => other.id)).toEqual(['sage']);
    instance.setHidden('sage', true);
    expect(instance.occupancy.others('echo')).toEqual([]);
    // Stepping with Echo hidden parks her capsule instead of following her body.
    const park = instance.currentStage ? vi.spyOn(instance.currentStage, 'parkEcho') : null;
    instance.setHidden('echo', true);
    instance.step(1 / 60);
    expect(park).not.toBeNull();
    expect(park).toHaveBeenCalled();
    instance.setHidden('echo', false);
    instance.setHidden('sage', false);
    instance.dispose();
  });
});
