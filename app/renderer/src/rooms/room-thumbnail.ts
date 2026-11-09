import * as THREE from 'three';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import { buildRoom } from './room-builder.js';

const WIDTH = 320;
const HEIGHT = 200;
const cache = new Map<string, Promise<string | null>>();

/** A small PNG preview from the room's own camera, or null where WebGL isn't available. Cached by room id. */
export function roomThumbnail(room: RoomFile): Promise<string | null> {
  let found = cache.get(room.id);
  if (!found) {
    found = Promise.resolve().then(() => render(room));
    cache.set(room.id, found);
  }
  return found;
}

export function clearRoomThumbnails(): void {
  cache.clear();
}

function render(room: RoomFile): string | null {
  if (typeof document === 'undefined') return null;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return null;
  let renderer: THREE.WebGLRenderer | null = null;
  const built = buildRoom(room);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(WIDTH, HEIGHT, false);
    renderer.setClearColor(room.shell.outside?.color ?? '#202028', 1);
    const scene = new THREE.Scene();
    scene.add(built.group);
    const camera = new THREE.PerspectiveCamera(room.camera.fov, WIDTH / HEIGHT, 0.05, 50);
    camera.position.set(...room.camera.position);
    camera.lookAt(new THREE.Vector3(...room.camera.target));
    renderer.render(scene, camera);
    return canvas.toDataURL('image/png');
  } catch (error) {
    console.warn('[rooms] could not render a thumbnail', error);
    return null;
  } finally {
    built.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
