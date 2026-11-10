/**
 * What the fixed room camera can see. The idle director only sends the avatar to things the viewer
 * can see, so the camera is rebuilt here from the room file with three.js and no renderer.
 */
import * as THREE from 'three';
import type { RoomFile, RoomObject, Vec3 } from '../../../main/src/rooms/types.js';
import { worldTag } from './room-tags.js';

/** How far inside the picture an object has to be, as a fraction of the half width and height. */
export const VISIBLE_MARGIN = 0.05;
/** Used when the real view's shape is not known. */
export const DEFAULT_ASPECT = 16 / 9;

/** The room camera for a view of the given width over height, as the stage sets it up. */
export function roomCamera(room: RoomFile, aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(room.camera.fov, aspect > 0 ? aspect : DEFAULT_ASPECT, 0.05, 50);
  camera.position.set(...room.camera.position);
  camera.lookAt(new THREE.Vector3(...room.camera.target));
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

/** A frustum that is the camera's, narrowed by `margin` on every side of the picture. */
export function viewFrustum(camera: THREE.PerspectiveCamera, margin = VISIBLE_MARGIN): THREE.Frustum {
  const shrink = new THREE.Matrix4().makeScale(1 / (1 - margin), 1 / (1 - margin), 1);
  const view = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(shrink, view));
}

/** The points of an object that must all be in view: its middle and, when it has them, its sit and stand spots. */
export function objectViewPoints(room: RoomFile, object: RoomObject): Vec3[] {
  const points: Vec3[] = [[object.position[0], object.position[1] + Math.min(object.size[1] / 2, 0.6), object.position[2]]];
  for (const kind of ['sit', 'stand'] as const) {
    const tag = worldTag(room, object.id, kind);
    if (tag) points.push([tag.position[0], kind === 'stand' ? 0.9 : tag.position[1], tag.position[2]]);
  }
  return points;
}

/** The room's objects whose position and sit or stand spots are inside the camera's view. */
export function visibleObjects(room: RoomFile, aspect: number = DEFAULT_ASPECT): RoomObject[] {
  const frustum = viewFrustum(roomCamera(room, aspect));
  const point = new THREE.Vector3();
  return room.objects.filter((object) =>
    objectViewPoints(room, object).every((p) => frustum.containsPoint(point.set(p[0], p[1], p[2]))),
  );
}
