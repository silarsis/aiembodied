import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RoomSceneController } from '../../src/rooms/room-scene-controller.js';
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
