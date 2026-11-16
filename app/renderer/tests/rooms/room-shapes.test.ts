import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { RoomPart } from '../../../main/src/rooms/types.js';
import { MAX_TRIMESH_TRIANGLES, boundingBoxShape, modelShapes, objectShapes, partShapes, shapeTopAt } from '../../src/rooms/room-shapes.js';

describe('partShapes', () => {
  it('maps each part kind to a shape centred on its offset', () => {
    const parts: RoomPart[] = [
      { shape: 'box', size: [2, 0.4, 1], offset: [0.1, 0.2, 0.3], color: '#fff' },
      { shape: 'cylinder', radius: 0.3, height: 0.8, offset: [0, 0.4, 0], color: '#fff' },
      { shape: 'sphere', radius: 0.2, offset: [1, 1, 1], color: '#fff' },
    ];
    const [box, cylinder, ball] = partShapes(parts);
    expect(box).toMatchObject({ kind: 'cuboid', halfExtents: [1, 0.2, 0.5], translation: [0.1, 0.2, 0.3] });
    expect(cylinder).toMatchObject({ kind: 'cylinder', halfHeight: 0.4, radius: 0.3, translation: [0, 0.4, 0] });
    expect(ball).toMatchObject({ kind: 'ball', radius: 0.2, translation: [1, 1, 1] });
    expect(box.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('turns degrees into the quaternion the builder gives the mesh', () => {
    const [shape] = partShapes([{ shape: 'box', size: [1, 1, 1], offset: [0, 0, 0], rotation: [10, 20, 30], color: '#fff' }]);
    const mesh = new THREE.Mesh();
    mesh.rotation.set((10 * Math.PI) / 180, (20 * Math.PI) / 180, (30 * Math.PI) / 180);
    expect(shape.rotation.x).toBeCloseTo(mesh.quaternion.x);
    expect(shape.rotation.y).toBeCloseTo(mesh.quaternion.y);
    expect(shape.rotation.z).toBeCloseTo(mesh.quaternion.z);
    expect(shape.rotation.w).toBeCloseTo(mesh.quaternion.w);
  });
});

describe('objectShapes', () => {
  it('uses the parts, else the bounding box standing on the origin', () => {
    expect(objectShapes({ size: [1, 2, 3] })).toEqual([boundingBoxShape([1, 2, 3])]);
    expect(boundingBoxShape([1, 2, 3])).toMatchObject({ halfExtents: [0.5, 1, 1.5], translation: [0, 1, 0] });
    expect(objectShapes({ size: [1, 1, 1], parts: [{ shape: 'sphere', radius: 1, offset: [0, 1, 0], color: '#fff' }] })).toHaveLength(1);
  });
});

describe('modelShapes', () => {
  const box = (name = 'm') => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.name = name;
    return mesh;
  };

  it('merges visible meshes in the holder space and skips hidden ones', () => {
    const holder = new THREE.Group();
    const a = box();
    a.position.set(1, 0.5, 0);
    const hidden = box();
    hidden.visible = false;
    holder.add(a, hidden);
    const shapes = modelShapes(holder);
    expect(shapes).toHaveLength(1);
    const shape = shapes?.[0];
    if (shape?.kind !== 'trimesh') throw new Error('expected a trimesh');
    expect(shape.indices.length).toBe(36);
    const xs = Array.from({ length: shape.vertices.length / 3 }, (_, i) => shape.vertices[i * 3]);
    expect(Math.min(...xs)).toBeCloseTo(0.5);
    expect(Math.max(...xs)).toBeCloseTo(1.5);
  });

  it('returns null for an empty model or one over the triangle limit', () => {
    expect(modelShapes(new THREE.Group())).toBeNull();
    const heavy = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, MAX_TRIMESH_TRIANGLES, 1));
    expect(modelShapes(heavy)).toBeNull();
  });
});

describe('shapeTopAt', () => {
  it('finds the top of a box, a rotated box, a cylinder and a ball', () => {
    const [box, tilted, cylinder, ball] = partShapes([
      { shape: 'box', size: [1, 1, 1], offset: [0, 0.5, 0], color: '#fff' },
      { shape: 'box', size: [1, 1, 1], offset: [0, 0.5, 0], rotation: [0, 45, 0], color: '#fff' },
      { shape: 'cylinder', radius: 0.5, height: 1, offset: [0, 0.5, 0], color: '#fff' },
      { shape: 'sphere', radius: 0.5, offset: [0, 0.5, 0], color: '#fff' },
    ]);
    expect(shapeTopAt(box, 0.4, 0.4, 5)).toBeCloseTo(1);
    expect(shapeTopAt(box, 0.6, 0, 5)).toBeNull();
    expect(shapeTopAt(tilted, 0.6, 0, 5)).toBeCloseTo(1); // corner of the turned box reaches 0.707
    expect(shapeTopAt(cylinder, 0.45, 0, 5)).toBeCloseTo(1);
    expect(shapeTopAt(cylinder, 0.4, 0.4, 5)).toBeNull();
    expect(shapeTopAt(ball, 0, 0, 5)).toBeCloseTo(1);
    expect(shapeTopAt(box, 0, 0, 0.7)).toBeCloseTo(0.7); // starting inside
    expect(shapeTopAt(box, 0, 0, -1)).toBeNull(); // below
  });
});
