import { describe, expect, it } from 'vitest';
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

  it('places a companion that loads while a room is showing and re-slots the rest when one leaves', async () => {
    const { instance } = controller();
    const room = builtInRoom('reading-room');
    await instance.setRoom(room);
    const a = new THREE.Group();
    const b = new THREE.Group();
    instance.attachCompanion('a', a);
    instance.attachCompanion('b', b);
    expect(b.position.x).toBeCloseTo(companionHome(room.home, 1).position[0]);
    instance.detachCompanion('a');
    expect(b.position.x).toBeCloseTo(companionHome(room.home, 0).position[0]);
    instance.dispose();
  });
});
