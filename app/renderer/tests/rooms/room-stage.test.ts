import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Vec3 } from '../../../main/src/rooms/types.js';
import { RoomStage } from '../../src/rooms/room-stage.js';
import { RoomPhysics } from '../../src/rooms/room-physics.js';
import { buildRoom } from '../../src/rooms/room-builder.js';
import { builtInRoom } from './fixtures.js';

function insideBox(p: Vec3, object: { position: Vec3; size: Vec3; rotationY?: number }): boolean {
  const angle = ((object.rotationY ?? 0) * Math.PI) / 180;
  const dx = p[0] - object.position[0];
  const dz = p[2] - object.position[2];
  const lx = dx * Math.cos(angle) - dz * Math.sin(angle);
  const lz = dx * Math.sin(angle) + dz * Math.cos(angle);
  return Math.abs(lx) < object.size[0] / 2 && Math.abs(lz) < object.size[2] / 2;
}

describe('RoomStage navigation', () => {
  const room = builtInRoom('reading-room');

  it('finds a walkable path from home to the armchair that avoids the coffee table', async () => {
    const stage = await RoomStage.create(room);
    expect(stage.hasNavigation).toBe(true);
    const sit = stage.worldTag('armchair', 'sit')!;
    const path = stage.findPath(stage.homePose().position, sit.position);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThanOrEqual(2);
    const table = room.objects.find((object) => object.id === 'coffee-table')!;
    for (const point of path!) {
      expect(stage.isWalkable(point)).toBe(true);
      expect(insideBox(point, table)).toBe(false);
    }
    // Sample along each segment too: no straight leg may cross any solid object.
    const solid = room.objects.filter((object) => (object.collider ?? 'box') === 'box' && !object.dynamic);
    for (let i = 0; i < path!.length - 1; i += 1) {
      for (let t = 0; t <= 1; t += 0.05) {
        const p: Vec3 = [0, 0, 0];
        for (let axis = 0; axis < 3; axis += 1) p[axis] = path![i][axis] * (1 - t) + path![i + 1][axis] * t;
        for (const object of solid) expect(insideBox(p, object)).toBe(false);
      }
    }
    stage.dispose();
  });

  it('treats points inside walls and furniture as not walkable', async () => {
    const stage = await RoomStage.create(room);
    expect(stage.isWalkable([0, 0, -0.3])).toBe(true);
    expect(stage.isWalkable([3.05, 0, 0])).toBe(false);
    expect(stage.isWalkable([0, 0, -2.52])).toBe(false);
    expect(stage.isWalkable([1.1, 0, -1.0])).toBe(false);
    const snapped = stage.closestWalkable([1.1, 0, -1.0]);
    expect(stage.isWalkable(snapped)).toBe(true);
    stage.dispose();
  });

  it('builds a debug overlay and removes it again', async () => {
    const stage = await RoomStage.create(room);
    stage.setDebugNavmesh(true);
    expect(stage.group.getObjectByName('navmesh-debug')).toBeTruthy();
    stage.setDebugNavmesh(false);
    expect(stage.group.getObjectByName('navmesh-debug')).toBeFalsy();
    stage.dispose();
  });

  it('works for the studio flat as well', async () => {
    const studio = builtInRoom('studio-flat');
    const stage = await RoomStage.create(studio);
    const bed = stage.worldTag('bed', 'sit')!;
    expect(stage.findPath(stage.homePose().position, bed.position)).not.toBeNull();
    stage.dispose();
  });
});

describe('RoomPhysics', () => {
  it('lets a dropped mug land on the table and rest there', async () => {
    const room = builtInRoom('reading-room');
    const lifted = {
      ...room,
      objects: room.objects.map((object) =>
        object.id === 'mug' ? { ...object, position: [object.position[0], object.position[1] + 0.2, object.position[2]] as Vec3 } : object,
      ),
    };
    const built = buildRoom(lifted);
    const physics = await RoomPhysics.create(lifted, built.objectNodes);
    for (let i = 0; i < 90; i += 1) physics.step(1 / 60);
    const node = built.objectNodes.get('mug')!;
    const table = room.objects.find((object) => object.id === 'coffee-table')!;
    expect(node.position.y).toBeGreaterThan(table.size[1] - 0.02);
    expect(node.position.y).toBeLessThan(table.size[1] + 0.02);
    expect(Math.abs(node.position.x - 1.1)).toBeLessThan(0.05);
    const settled = node.position.clone();
    for (let i = 0; i < 30; i += 1) physics.step(1 / 60);
    expect(node.position.distanceTo(settled)).toBeLessThan(0.005);
    physics.dispose();
    built.dispose();
  });

  it('moves with the avatar capsule without throwing and disposes cleanly', async () => {
    const stage = await RoomStage.create(builtInRoom('studio-flat'));
    const root = new THREE.Group();
    root.position.set(0, 0, -0.3);
    stage.step(1 / 60, root);
    root.position.set(0.5, 0, 0);
    stage.step(1 / 60, root);
    stage.dispose();
    expect(() => stage.step(1 / 60, root)).not.toThrow();
  });
});

describe('RoomStage carrying', () => {
  const room = builtInRoom('reading-room');

  it('keeps a held prop kinematic: it neither falls nor is moved by physics, then settles when put down', async () => {
    const stage = await RoomStage.create(room);
    const mug = stage.objectNode('mug')!;
    stage.setHeld('mug', true);
    // Carry it up into the air; gravity must not act and the sync must not overwrite the node.
    const carrier = new THREE.Object3D();
    carrier.position.set(0, 1.5, 0);
    carrier.add(mug);
    carrier.updateWorldMatrix(true, true);
    for (let i = 0; i < 60; i += 1) stage.step(1 / 60);
    expect(mug.parent).toBe(carrier);
    expect(stage.objectPosition('mug')![1]).toBeCloseTo(1.5 + mug.position.y, 4);
    expect(mug.position.y).toBeGreaterThan(0.3); // still where it was in the carrier's space

    stage.propParent.add(mug);
    stage.placeObject('mug', [1.1, 0.42, -1.0], 0);
    stage.setHeld('mug', false);
    for (let i = 0; i < 120; i += 1) stage.step(1 / 60);
    const p = stage.objectPosition('mug')!;
    expect(p[1]).toBeGreaterThan(0.4);
    expect(p[1]).toBeLessThan(0.45);
    stage.dispose();
  });
});

describe('RoomStage extra avatars', () => {
  it('feeds each extra avatar\'s body position to physics and drops it again', async () => {
    const stage = await RoomStage.create(builtInRoom('reading-room'));
    const sage = new THREE.Group();
    sage.position.set(1, 0, 1);
    stage.step(1 / 60, null, [{ id: 'sage', root: sage }]);
    const physics = (stage as unknown as { physics: { avatarIds: string[] } }).physics;
    expect(physics.avatarIds).toEqual(['sage']);
    stage.removeAvatar('sage');
    expect(physics.avatarIds).toEqual([]);
    stage.dispose();
  });
});

describe('RoomStage surfaceHeightAt', () => {
  const room = builtInRoom('reading-room');

  async function stageWithMeshes() {
    const stage = await RoomStage.create(room);
    const sofa = room.objects.find((object) => object.id === 'sofa')!;
    const node = stage.objectNode('sofa')!;
    node.clear();
    // A cushion 0.4 m high with a backrest rising to 0.9 m behind it, in the node's local space.
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1), new THREE.MeshBasicMaterial());
    cushion.position.set(0, 0.2, 0);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1, 0.9, 0.2), new THREE.MeshBasicMaterial());
    back.position.set(0, 0.45, -0.6);
    node.add(cushion, back);
    node.updateMatrixWorld(true);
    return { stage, sofa };
  }

  it('measures the rendered top under a point', async () => {
    const { stage, sofa } = await stageWithMeshes();
    const [x, y, z] = sofa.position;
    expect(stage.surfaceHeightAt('sofa', x, z, y + 0.45)).toBeCloseTo(y + 0.4, 6);
    expect(stage.surfaceHeightAt('sofa', x, z)).toBeCloseTo(y + 0.4, 6);
  });

  it('rejects a backrest outside the band around the tag height, and misses', async () => {
    const { stage, sofa } = await stageWithMeshes();
    const [x, y, z] = sofa.position;
    // Under the backrest the ray starts inside it (tag + band is below its top), so it is not taken for a seat.
    expect(stage.surfaceHeightAt('sofa', x, z - 0.6, y + 0.45)).toBeNull(); // top at 0.9 is above the ray start
    expect(stage.surfaceHeightAt('sofa', x + 5, z, y + 0.45)).toBeNull();
    expect(stage.surfaceHeightAt('nothing', x, z)).toBeNull();
  });

  it('falls back to the box top without meshes when no height hint is given', async () => {
    const stage = await RoomStage.create(room);
    const sofa = room.objects.find((object) => object.id === 'sofa')!;
    stage.objectNode('sofa')!.clear();
    expect(stage.surfaceHeightAt('sofa', sofa.position[0], sofa.position[2])).toBeCloseTo(sofa.position[1] + sofa.size[1], 6);
  });
});
