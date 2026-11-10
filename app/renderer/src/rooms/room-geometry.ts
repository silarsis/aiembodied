/** Shared by the visual builder and the physics world so walls and colliders always agree. */
import type { RoomFile, RoomObject, RoomOpening, RoomShell, Vec3 } from '../../../main/src/rooms/types.js';

export const WALL_THICKNESS = 0.1;

export type WallName = RoomOpening['wall'];

/** An axis-aligned box in world space. */
export interface WorldBox {
  center: Vec3;
  size: Vec3;
}

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function wallLength(shell: RoomShell, wall: WallName): number {
  return wall === 'north' || wall === 'south' ? shell.width : shell.depth;
}

/** Splits a wall into boxes around its openings. Works in wall space: u along the wall, v up. */
export function wallPieces(shell: RoomShell, wall: WallName): WorldBox[] {
  const length = wallLength(shell, wall);
  const along = wall === 'north' || wall === 'south';
  // North/south walls overlap the east/west walls' ends so the corners are closed.
  const extend = along ? WALL_THICKNESS : 0;
  const min = -length / 2 - extend;
  const max = length / 2 + extend;
  const holes = (shell.openings ?? [])
    .filter((opening) => opening.wall === wall)
    .map((opening) => ({
      u0: Math.max(min, opening.offset - opening.width / 2),
      u1: Math.min(max, opening.offset + opening.width / 2),
      v0: Math.max(0, opening.sill ?? 0),
      v1: Math.min(shell.height, (opening.sill ?? 0) + opening.height),
    }))
    .filter((hole) => hole.u1 > hole.u0 && hole.v1 > hole.v0);

  const cuts = [...new Set([min, max, ...holes.flatMap((hole) => [hole.u0, hole.u1])])].sort((a, b) => a - b);
  const pieces: WorldBox[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < 1e-6) continue;
    const mid = (a + b) / 2;
    const spans = holes
      .filter((hole) => hole.u0 <= mid && mid <= hole.u1)
      .map((hole) => [hole.v0, hole.v1] as const)
      .sort((p, q) => p[0] - q[0]);
    let cursor = 0;
    const solid: Array<[number, number]> = [];
    for (const [v0, v1] of spans) {
      if (v0 > cursor) solid.push([cursor, v0]);
      cursor = Math.max(cursor, v1);
    }
    if (cursor < shell.height) solid.push([cursor, shell.height]);
    for (const [v0, v1] of solid) pieces.push(toWorld(shell, wall, a, b, v0, v1));
  }
  return pieces;
}

function toWorld(shell: RoomShell, wall: WallName, u0: number, u1: number, v0: number, v1: number): WorldBox {
  const t = WALL_THICKNESS;
  const u = (u0 + u1) / 2;
  const v = (v0 + v1) / 2;
  const du = u1 - u0;
  const dv = v1 - v0;
  switch (wall) {
    case 'north':
      return { center: [u, v, -shell.depth / 2 - t / 2], size: [du, dv, t] };
    case 'south':
      return { center: [u, v, shell.depth / 2 + t / 2], size: [du, dv, t] };
    case 'east':
      return { center: [shell.width / 2 + t / 2, v, u], size: [t, dv, du] };
    case 'west':
      return { center: [-shell.width / 2 - t / 2, v, u], size: [t, dv, du] };
  }
}

/** Window openings can't be walked through; physics closes them with a thin blocker. */
export function windowBlockers(shell: RoomShell): WorldBox[] {
  return (shell.openings ?? [])
    .filter((opening) => opening.kind === 'window')
    .map((opening) => {
      const sill = opening.sill ?? 0;
      return toWorld(
        shell,
        opening.wall,
        opening.offset - opening.width / 2,
        opening.offset + opening.width / 2,
        sill,
        sill + opening.height,
      );
    });
}

/** Local object-space point to world space (rotation about Y only). */
export function objectToWorld(object: Pick<RoomObject, 'position' | 'rotationY'>, local: Vec3): Vec3 {
  const angle = degToRad(object.rotationY ?? 0);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    object.position[0] + local[0] * cos + local[2] * sin,
    object.position[1] + local[1],
    object.position[2] - local[0] * sin + local[2] * cos,
  ];
}

export function colliderObjects(room: RoomFile, filter: (object: RoomObject) => boolean): RoomObject[] {
  return room.objects.filter((object) => (object.collider ?? 'box') === 'box' && filter(object));
}
