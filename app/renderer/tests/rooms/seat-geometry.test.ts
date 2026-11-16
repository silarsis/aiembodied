import { describe, expect, it } from 'vitest';
import { applySeatOverrides, seatGeometryLocal, seatGeometryToWorld, shapeSampler } from '../../src/rooms/seat-geometry.js';
import { objectShapes } from '../../src/rooms/room-shapes.js';
import { builtInRoom } from './fixtures.js';

const room = builtInRoom('reading-room');
const sofa = room.objects.find((object) => object.id === 'sofa')!;
const tag = sofa.tags!.sit!;

describe('seatGeometryLocal on the reading-room sofa', () => {
  const local = seatGeometryLocal(tag, shapeSampler(objectShapes(sofa)));

  it('finds the cushion top, its front edge and depth', () => {
    expect(local.seatTopY).toBeCloseTo(0.54, 2);
    // Cushion spans z -0.27 .. 0.43; the tag is at z 0.05.
    expect(local.frontEdge).toBeCloseTo(0.38, 1);
    expect(local.depth).toBeCloseTo(0.7, 1);
  });

  it('finds the back rest behind the tag', () => {
    // Back rest front plane at z -0.25, tag at 0.05; top at 0.9.
    expect(local.backRest?.distance).toBeCloseTo(0.3, 1);
    expect(local.backRest?.top).toBeCloseTo(0.9, 2);
  });

  it('puts the feet on the floor in front', () => {
    expect(local.footFloorY).toBe(0);
  });

  it('has no back rest on a flat stool', () => {
    const stool = [{ shape: 'cylinder' as const, radius: 0.2, height: 0.45, offset: [0, 0.225, 0] as [number, number, number], color: '#fff' }];
    const result = seatGeometryLocal({ position: [0, 0.45, 0], facing: 0 }, shapeSampler(objectShapes({ size: [0.4, 0.45, 0.4], parts: stool })));
    expect(result.backRest).toBeNull();
    expect(result.seatTopY).toBeCloseTo(0.45);
    expect(result.depth).toBeCloseTo(0.4, 1);
  });
});

describe('seat overrides and world space', () => {
  const local = seatGeometryLocal(tag, shapeSampler(objectShapes(sofa)));

  it('lets the tag override measured values', () => {
    const result = applySeatOverrides(local, { top: 0.6, frontEdge: 0.3 });
    expect(result.seatTopY).toBe(0.6);
    expect(result.frontEdge).toBe(0.3);
    expect(result.depth).toBeCloseTo(local.depth - local.frontEdge + 0.3);
    expect(applySeatOverrides(local, { depth: 0.5 }).depth).toBe(0.5);
    expect(applySeatOverrides(local, undefined)).toBe(local);
  });

  it('follows the object pose', () => {
    const world = seatGeometryToWorld(local, tag, { position: [2, 0.1, 3], yawDegrees: 90 });
    expect(world.seatTopY).toBeCloseTo(local.seatTopY + 0.1);
    expect(world.backRest?.top).toBeCloseTo(1.0, 2);
    expect(world.facing).toBe(90);
    // Local (0, 0.5, 0.05) turned 90 degrees about Y lands 0.05 along +X.
    expect(world.position[0]).toBeCloseTo(2.05);
    expect(world.position[2]).toBeCloseTo(3);
    expect(world.frontEdge).toBe(local.frontEdge);
  });
});
