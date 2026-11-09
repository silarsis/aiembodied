import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildRoom } from '../../src/rooms/room-builder.js';
import { wallPieces } from '../../src/rooms/room-geometry.js';
import { builtInRoom } from './fixtures.js';

describe('buildRoom', () => {
  const room = builtInRoom('reading-room');

  it('creates a node per object and parts for every primitive', () => {
    const built = buildRoom(room);
    expect(built.objectNodes.size).toBe(room.objects.length);
    const mug = built.objectNodes.get('mug');
    expect(mug?.position.toArray()).toEqual([1.1, 0.42, -1]);
    expect(mug?.children.length).toBe(2);
    expect(built.group.children.some((child) => (child as THREE.Light).isLight)).toBe(true);
    built.dispose();
  });

  it('leaves a hole in the wall where the door is', () => {
    const door = room.shell.openings!.find((opening) => opening.kind === 'door')!;
    expect(door.wall).toBe('east');
    const pieces = wallPieces(room.shell, 'east');
    // A horizontal ray through the middle of the door at hip height must miss every east wall piece.
    const y = 1.0;
    const z = door.offset;
    const hits = pieces.filter(
      (piece) =>
        Math.abs(piece.center[1] - y) <= piece.size[1] / 2 && Math.abs(piece.center[2] - z) <= piece.size[2] / 2,
    );
    expect(hits).toHaveLength(0);
    // Above the door there is wall, and beside it too.
    const above = pieces.filter((p) => Math.abs(p.center[1] - 2.4) <= p.size[1] / 2 && Math.abs(p.center[2] - z) <= p.size[2] / 2);
    expect(above).toHaveLength(1);
    const beside = pieces.filter((p) => Math.abs(p.center[1] - 1) <= p.size[1] / 2 && Math.abs(p.center[2] - (z - 1.5)) <= p.size[2] / 2);
    expect(beside).toHaveLength(1);

    const built = buildRoom(room);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, y, z), new THREE.Vector3(1, 0, 0));
    built.group.updateMatrixWorld(true);
    const walls = built.group.getObjectByName('shell')!.children.filter((child) => child.name === 'wall:east');
    expect(ray.intersectObjects(walls)).toHaveLength(0);
    const blocked = new THREE.Raycaster(new THREE.Vector3(0, y, z - 1.5), new THREE.Vector3(1, 0, 0));
    expect(blocked.intersectObjects(walls).length).toBeGreaterThan(0);
    built.dispose();
  });

  it('puts a window hole in the north wall and a sill below it', () => {
    const window = room.shell.openings!.find((opening) => opening.kind === 'window')!;
    const pieces = wallPieces(room.shell, 'north');
    const inHole = pieces.filter(
      (p) =>
        Math.abs(p.center[0] - window.offset) <= p.size[0] / 2 &&
        Math.abs(p.center[1] - (window.sill! + window.height / 2)) <= p.size[1] / 2,
    );
    expect(inHole).toHaveLength(0);
    const sill = pieces.filter((p) => Math.abs(p.center[0] - window.offset) <= p.size[0] / 2 && Math.abs(p.center[1] - 0.3) <= p.size[1] / 2);
    expect(sill).toHaveLength(1);
  });

  it('disposes geometries and removes the group', () => {
    const parent = new THREE.Group();
    const built = buildRoom(room);
    parent.add(built.group);
    built.dispose();
    expect(parent.children).toHaveLength(0);
    expect(built.objectNodes.size).toBe(0);
    expect(() => built.dispose()).not.toThrow();
  });

  it('hands objects with a model to the loader hook only when one is given', async () => {
    const withModel = { ...room, objects: [{ ...room.objects[0], model: { file: 'chair.glb' }, parts: [] }] };
    const model = new THREE.Group();
    const built = buildRoom(withModel, { loadModel: async () => model });
    await Promise.resolve();
    await Promise.resolve();
    expect(built.objectNodes.get(room.objects[0].id)?.children).toContain(model);
    const skipped = buildRoom(withModel);
    expect(skipped.objectNodes.get(room.objects[0].id)?.children).toHaveLength(0);
  });
});
