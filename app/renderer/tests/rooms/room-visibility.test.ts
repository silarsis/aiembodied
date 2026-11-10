import { describe, expect, it } from 'vitest';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import { VISIBLE_MARGIN, objectViewPoints, roomCamera, viewFrustum, visibleObjects } from '../../src/rooms/room-visibility.js';
import { builtInRoom } from './fixtures.js';

const ids = (room: RoomFile, aspect: number) => visibleObjects(room, aspect).map((object) => object.id);

describe('visibleObjects', () => {
  const reading = builtInRoom('reading-room');

  it('keeps what the camera shows on a wide window and drops the bookshelf off to the left', () => {
    const seen = ids(reading, 16 / 9);
    expect(seen).toEqual(expect.arrayContaining(['sofa', 'armchair', 'coffee-table', 'mug']));
    expect(seen).not.toContain('bookshelf');
  });

  it('shows more of the room on a wider view and less on a narrow one', () => {
    expect(ids(reading, 21 / 9)).toContain('bookshelf');
    const narrow = ids(reading, 9 / 16);
    expect(narrow).toContain('sofa');
    expect(narrow).not.toContain('armchair');
    expect(ids(reading, 21 / 9).length).toBeGreaterThan(ids(reading, 9 / 16).length);
  });

  it('needs the sit or stand spot in view too, not only the object', () => {
    const points = objectViewPoints(reading, reading.objects.find((object) => object.id === 'sofa') ?? reading.objects[0]);
    expect(points).toHaveLength(3); // middle, sit spot, stand spot
    // Move the sofa's stand spot (0, 0, 1 in front of it) out of view by turning the camera away.
    const away: RoomFile = { ...reading, camera: { ...reading.camera, target: [0, 1, 5] } };
    expect(ids(away, 16 / 9)).not.toContain('sofa');
  });

  it('applies a 5 % margin: a point just inside the edge of the picture is left out', () => {
    const camera = roomCamera(reading, 16 / 9);
    const frustum = viewFrustum(camera);
    const plain = viewFrustum(camera, 0);
    // A point at 98 % of the half height straight ahead is in the picture but inside the margin.
    const ahead = camera.position.clone().add(camera.getWorldDirection(camera.position.clone()).multiplyScalar(3));
    const up = camera.up.clone().applyQuaternion(camera.quaternion);
    const half = Math.tan((camera.fov / 2) * (Math.PI / 180)) * 3;
    const edge = ahead.clone().add(up.multiplyScalar(half * 0.98));
    expect(plain.containsPoint(edge)).toBe(true);
    expect(frustum.containsPoint(edge)).toBe(false);
    expect(VISIBLE_MARGIN).toBe(0.05);
  });

  it('works for the studio flat', () => {
    expect(ids(builtInRoom('studio-flat'), 16 / 9)).toEqual(expect.arrayContaining(['desk', 'desk-chair']));
  });
});
