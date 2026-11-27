/**
 * Collision shapes of a room object in object-local space (origin = floor contact, metres, rotation about the
 * origin). Pure data, no Rapier: `room-physics.ts` turns them into colliders, `seat-geometry.ts` reads the same
 * shapes to find seat surfaces, so what is drawn, what blocks and what you sit on cannot drift apart.
 */
import * as THREE from 'three';
import type { RoomObject, RoomPart, Vec3 } from '../../../main/src/shared/rooms/types.js';
import { degToRad } from './room-geometry.js';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface ShapeBase {
  /** Centre of the shape. */
  translation: Vec3;
  rotation: Quat;
}
export interface CuboidShape extends ShapeBase {
  kind: 'cuboid';
  halfExtents: Vec3;
}
/** Axis along the shape's local Y, like THREE.CylinderGeometry. */
export interface CylinderShape extends ShapeBase {
  kind: 'cylinder';
  halfHeight: number;
  radius: number;
}
export interface BallShape extends ShapeBase {
  kind: 'ball';
  radius: number;
}
export interface TrimeshShape extends ShapeBase {
  kind: 'trimesh';
  /** x, y, z per vertex, already in object-local space. */
  vertices: Float32Array;
  indices: Uint32Array;
}
export type LocalShape = CuboidShape | CylinderShape | BallShape | TrimeshShape;

/** More triangles than this make a poor collider (slow queries); the bounding box is used instead. */
export const MAX_TRIMESH_TRIANGLES = 50_000;

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** Same Euler order (XYZ, THREE's default) that room-builder gives the part's mesh. */
function partRotation(part: RoomPart): Quat {
  if (!part.rotation) return IDENTITY;
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      degToRad(part.rotation[0]),
      degToRad(part.rotation[1]),
      degToRad(part.rotation[2]),
      'XYZ',
    ),
  );
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/** One shape per part. `offset` is the part's centre (room-builder sets the mesh position to it). */
export function partShapes(parts: readonly RoomPart[]): LocalShape[] {
  return parts.map((part): LocalShape => {
    const base = {
      translation: [part.offset[0], part.offset[1], part.offset[2]] as Vec3,
      rotation: partRotation(part),
    };
    switch (part.shape) {
      case 'box':
        return {
          kind: 'cuboid',
          halfExtents: [part.size[0] / 2, part.size[1] / 2, part.size[2] / 2],
          ...base,
        };
      case 'cylinder':
        return { kind: 'cylinder', halfHeight: part.height / 2, radius: part.radius, ...base };
      case 'sphere':
        return { kind: 'ball', radius: part.radius, ...base };
    }
  });
}

/** The object's bounding box standing on its origin. */
export function boundingBoxShape(size: Vec3): CuboidShape {
  return {
    kind: 'cuboid',
    halfExtents: [size[0] / 2, size[1] / 2, size[2] / 2],
    translation: [0, size[1] / 2, 0],
    rotation: IDENTITY,
  };
}

/** What blocks before any model has loaded: the parts, or the bounding box when there are none. */
export function objectShapes(object: Pick<RoomObject, 'parts' | 'size'>): LocalShape[] {
  return object.parts?.length ? partShapes(object.parts) : [boundingBoxShape(object.size)];
}

/**
 * A trimesh of a loaded model's visible meshes, in the space of `root`'s parent (the model holder is placed at
 * the object origin without a transform, so that is object-local space). Null when there is nothing to
 * collide with or the model is too heavy; callers then keep the bounding box.
 */
export function modelShapes(root: THREE.Object3D): LocalShape[] | null {
  try {
    root.updateWorldMatrix(true, true);
    const toLocal = new THREE.Matrix4();
    if (root.parent) toLocal.copy(root.parent.matrixWorld).invert();
    const position: number[] = [];
    const index: number[] = [];
    const point = new THREE.Vector3();
    let triangles = 0;
    let tooBig = false;
    root.traverseVisible((node) => {
      if (tooBig || !(node instanceof THREE.Mesh) || node.name === 'placeholder') return;
      const geo = node.geometry as THREE.BufferGeometry;
      const attr = geo.getAttribute('position');
      if (!attr) return;
      const count = geo.index ? geo.index.count : attr.count;
      triangles += Math.floor(count / 3);
      if (triangles > MAX_TRIMESH_TRIANGLES) {
        tooBig = true;
        return;
      }
      const matrix = new THREE.Matrix4().multiplyMatrices(toLocal, node.matrixWorld);
      const base = position.length / 3;
      for (let i = 0; i < attr.count; i += 1) {
        point.fromBufferAttribute(attr, i).applyMatrix4(matrix);
        position.push(point.x, point.y, point.z);
      }
      for (let i = 0; i + 2 < count; i += 3) {
        for (let k = 0; k < 3; k += 1)
          index.push(base + (geo.index ? geo.index.getX(i + k) : i + k));
      }
    });
    if (tooBig || index.length === 0) return null;
    return [
      {
        kind: 'trimesh',
        vertices: new Float32Array(position),
        indices: new Uint32Array(index),
        translation: [0, 0, 0],
        rotation: IDENTITY,
      },
    ];
  } catch (error) {
    console.warn('[rooms] could not build a collision mesh from the model', error);
    return null;
  }
}

/**
 * The highest point of a shape on the vertical line through (x, z) that is not above `fromY`, or null when the
 * line misses it. If `fromY` is inside the shape the answer is `fromY` itself. Trimeshes are not sampled.
 */
export function shapeTopAt(shape: LocalShape, x: number, z: number, fromY: number): number | null {
  if (shape.kind === 'trimesh') return null;
  const inverse = new THREE.Quaternion(
    shape.rotation.x,
    shape.rotation.y,
    shape.rotation.z,
    shape.rotation.w,
  ).invert();
  const origin = new THREE.Vector3(
    x - shape.translation[0],
    fromY - shape.translation[1],
    z - shape.translation[2],
  ).applyQuaternion(inverse);
  const dir = new THREE.Vector3(0, -1, 0).applyQuaternion(inverse);
  let tIn = 0;
  let tOut = Infinity;
  // Clips [tIn, tOut] to where origin + t * dir stays within |c| <= half on one axis.
  const slab = (o: number, d: number, half: number): boolean => {
    if (Math.abs(d) < 1e-9) return Math.abs(o) <= half;
    const a = (-half - o) / d;
    const b = (half - o) / d;
    tIn = Math.max(tIn, Math.min(a, b));
    tOut = Math.min(tOut, Math.max(a, b));
    return tIn <= tOut;
  };
  // Clips to the inside of a circle (or sphere) of radius r in the listed components.
  const disc = (o: number[], d: number[], r: number): boolean => {
    const A = d.reduce((s, v) => s + v * v, 0);
    const B = 2 * d.reduce((s, v, i) => s + v * o[i], 0);
    const C = o.reduce((s, v) => s + v * v, 0) - r * r;
    if (A < 1e-12) return C <= 0;
    const disc2 = B * B - 4 * A * C;
    if (disc2 < 0) return false;
    const root = Math.sqrt(disc2);
    tIn = Math.max(tIn, (-B - root) / (2 * A));
    tOut = Math.min(tOut, (-B + root) / (2 * A));
    return tIn <= tOut;
  };
  let hit: boolean;
  switch (shape.kind) {
    case 'cuboid':
      hit =
        slab(origin.x, dir.x, shape.halfExtents[0]) &&
        slab(origin.y, dir.y, shape.halfExtents[1]) &&
        slab(origin.z, dir.z, shape.halfExtents[2]);
      break;
    case 'cylinder':
      hit =
        slab(origin.y, dir.y, shape.halfHeight) &&
        disc([origin.x, origin.z], [dir.x, dir.z], shape.radius);
      break;
    case 'ball':
      hit = disc([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], shape.radius);
      break;
  }
  return hit && tOut >= 0 ? fromY - tIn : null;
}
