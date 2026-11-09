/**
 * Can the avatar get from its home spot to everything it should reach? A coarse floor grid with
 * the navmesh's clearances (0.3 m from walls, 0.35 m from furniture). The real navmesh is built in
 * the renderer; this check keeps generated rooms usable.
 */
import { distanceToRect, rectOf, toWorld, type Rect } from './placer-geometry.js';
import type { RoomFile, RoomObject, Vec3 } from './types.js';

export const CELL = 0.1;
export const FURNITURE_CLEARANCE = 0.35;
export const WALL_CLEARANCE = 0.3;
export const REACH_RADIUS = 0.9;
const FLAT_HEIGHT = 0.06;

export function footprintOf(object: Pick<RoomObject, 'position' | 'rotationY' | 'size'>): Rect {
  return rectOf(object.position[0], object.position[2], object.size[0], object.size[2], object.rotationY ?? 0);
}

/** Objects standing on the floor that block walking (not rugs, not props that physics moves). */
export function floorObstacles(room: RoomFile): RoomObject[] {
  return room.objects.filter(
    (o) => (o.collider ?? 'box') === 'box' && !o.dynamic && o.position[1] < 0.05 && o.size[1] >= FLAT_HEIGHT,
  );
}

export interface Walkability {
  free(x: number, z: number): boolean;
  /** Free cells connected to home. */
  reachable(x: number, z: number): boolean;
  /** Some reachable cell within `radius` of the point. */
  reachableNear(x: number, z: number, radius: number): boolean;
  /** Some reachable cell within `radius` of the rectangle. */
  reachableNearRect(rect: Rect, radius: number): boolean;
}

export function buildWalkability(room: RoomFile): Walkability {
  const { width, depth } = room.shell;
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(depth / CELL);
  const x0 = -width / 2;
  const z0 = -depth / 2;
  const obstacles = floorObstacles(room).map(footprintOf);
  const blocked = new Uint8Array(cols * rows);
  const centre = (c: number, r: number): [number, number] => [x0 + (c + 0.5) * CELL, z0 + (r + 0.5) * CELL];
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < cols; c += 1) {
      const [x, z] = centre(c, r);
      let isBlocked = Math.abs(x) > width / 2 - WALL_CLEARANCE || Math.abs(z) > depth / 2 - WALL_CLEARANCE;
      for (let i = 0; !isBlocked && i < obstacles.length; i += 1) isBlocked = distanceToRect(obstacles[i], x, z) < FURNITURE_CLEARANCE;
      if (isBlocked) blocked[r * cols + c] = 1;
    }
  const cellAt = (x: number, z: number): [number, number] => [
    Math.min(cols - 1, Math.max(0, Math.floor((x - x0) / CELL))),
    Math.min(rows - 1, Math.max(0, Math.floor((z - z0) / CELL))),
  ];
  // Flood fill from home (or the nearest free cell if home itself is blocked).
  const seen = new Uint8Array(cols * rows);
  const [hc, hr] = cellAt(room.home.position[0], room.home.position[2]);
  let start = -1;
  for (let ring = 0; ring < 20 && start < 0; ring += 1)
    for (let dr = -ring; dr <= ring && start < 0; dr += 1)
      for (let dc = -ring; dc <= ring; dc += 1) {
        const c = hc + dc;
        const r = hr + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows || blocked[r * cols + c]) continue;
        start = r * cols + c;
        break;
      }
  if (start >= 0) {
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const index = stack.pop() as number;
      const c = index % cols;
      const r = Math.floor(index / cols);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const next = nr * cols + nc;
        if (blocked[next] || seen[next]) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  const nearAny = (x: number, z: number, window: number, radius: number, distance: (cx: number, cz: number) => number): boolean => {
    const [c0, r0] = cellAt(x - window, z - window);
    const [c1, r1] = cellAt(x + window, z + window);
    for (let r = r0; r <= r1; r += 1)
      for (let c = c0; c <= c1; c += 1) {
        if (!seen[r * cols + c]) continue;
        const [cx, cz] = centre(c, r);
        if (distance(cx, cz) <= radius) return true;
      }
    return false;
  };
  return {
    free: (x, z) => {
      const [c, r] = cellAt(x, z);
      return !blocked[r * cols + c];
    },
    reachable: (x, z) => {
      const [c, r] = cellAt(x, z);
      return seen[r * cols + c] === 1;
    },
    reachableNear: (x, z, radius) => nearAny(x, z, radius + CELL, radius, (cx, cz) => Math.hypot(cx - x, cz - z)),
    reachableNearRect: (rect, radius) => {
      const window = Math.hypot(rect.hx, rect.hz) + radius + CELL;
      return nearAny(rect.cx, rect.cz, window, radius, (cx, cz) => distanceToRect(rect, cx, cz));
    },
  };
}

/** Where a grabbable's support stands: the footprint of the floor object it ends up resting on. */
function baseOf(room: RoomFile, object: RoomObject): RoomObject {
  if (object.position[1] < 0.05) return object;
  let best: RoomObject | null = null;
  for (const other of room.objects) {
    if (other === object || other.position[1] >= object.position[1] - 0.01) continue;
    const rect = footprintOf(other);
    if (distanceToRect(rect, object.position[0], object.position[2]) > 0.01) continue;
    if (!best || other.position[1] + (other.tags?.surface?.height ?? other.size[1]) > best.position[1]) best = other;
  }
  return best ? baseOf(room, best) : object;
}

export interface StandCandidate {
  position: Vec3;
  facing: number;
}

/** Places to stand next to a seat, in object-local space: in front first, then behind and the sides. */
export function standCandidates(size: Vec3): StandCandidate[] {
  const front = size[2] / 2 + 0.5;
  const side = size[0] / 2 + 0.5;
  return [
    { position: [0, 0, front], facing: 180 },
    { position: [0, 0, -front], facing: 0 },
    { position: [side, 0, 0], facing: -90 },
    { position: [-side, 0, 0], facing: 90 },
  ];
}

/** The first stand spot a seat has that the avatar can walk to, or null. */
export function reachableStand(object: RoomObject, walk: Walkability): StandCandidate | null {
  const frame = { cx: object.position[0], cz: object.position[2], rot: object.rotationY ?? 0 };
  for (const candidate of standCandidates(object.size)) {
    const [x, z] = toWorld(frame, candidate.position[0], candidate.position[2]);
    if (walk.reachableNear(x, z, 0.35)) return candidate;
  }
  return null;
}

/** Ids of seats, surfaces and grabbable props the avatar cannot walk up to. */
export function findUnreachable(room: RoomFile): string[] {
  const walk = buildWalkability(room);
  const result: string[] = [];
  for (const object of room.objects) {
    const tags = object.tags ?? {};
    let ok = true;
    if (tags.sit) {
      ok = reachableStand(object, walk) !== null;
    } else if (tags.grab || tags.surface) {
      const base = baseOf(room, object);
      ok = walk.reachableNearRect(footprintOf(base), REACH_RADIUS);
    }
    if (!ok) result.push(object.id);
  }
  return result;
}
