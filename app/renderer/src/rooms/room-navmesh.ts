import { NavMeshQuery, init, type NavMesh } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { NavMeshHelper } from '@recast-navigation/three';
import * as THREE from 'three';
import type { RoomFile, Vec3 } from '../../../main/src/rooms/types.js';
import { colliderObjects, degToRad } from './room-geometry.js';

export const AGENT_RADIUS = 0.3;
export const AGENT_HEIGHT = 1.7;
export const AGENT_MAX_CLIMB = 0.15;
/** Floor sampling cell. Recast uses the same size so voxels line up with the obstacle footprints. */
const CELL = 0.05;

let initialised: Promise<void> | null = null;
/** Recast's WASM is loaded once for the whole page. */
export function initNavigation(): Promise<void> {
  initialised ??= init().catch((error: unknown) => {
    initialised = null;
    throw error;
  });
  return initialised;
}

interface Footprint {
  x: number;
  z: number;
  cos: number;
  sin: number;
  hx: number;
  hz: number;
}

function footprints(room: RoomFile): Footprint[] {
  // Dynamic props can move and usually sit on something else, so they don't block the floor.
  return colliderObjects(room, (object) => !object.dynamic).map((object) => {
    const angle = degToRad(object.rotationY ?? 0);
    return {
      x: object.position[0],
      z: object.position[2],
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      hx: object.size[0] / 2,
      hz: object.size[2] / 2,
    };
  });
}

function blocked(footprint: Footprint[], x: number, z: number): boolean {
  for (const f of footprint) {
    const dx = x - f.x;
    const dz = z - f.z;
    // Inverse of the object's yaw: local x = dx cos - dz sin, local z = dx sin + dz cos.
    const lx = dx * f.cos - dz * f.sin;
    const lz = dx * f.sin + dz * f.cos;
    if (Math.abs(lx) <= f.hx && Math.abs(lz) <= f.hz) return true;
  }
  return false;
}

/** Flat floor triangles with the obstacle footprints cut out (so nothing can be walked on top of furniture). */
export function buildFloorMesh(room: RoomFile): { positions: Float32Array; indices: Uint32Array } {
  const { width, depth } = room.shell;
  const cols = Math.round(width / CELL);
  const rows = Math.round(depth / CELL);
  const cellW = width / cols;
  const cellD = depth / rows;
  const obstacles = footprints(room);
  const positions: number[] = [];
  const indices: number[] = [];
  const quad = (x0: number, x1: number, z0: number, z1: number) => {
    const base = positions.length / 3;
    positions.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let row = 0; row < rows; row += 1) {
    const z0 = -depth / 2 + row * cellD;
    let runStart = -1;
    for (let col = 0; col <= cols; col += 1) {
      const free =
        col < cols && !blocked(obstacles, -width / 2 + (col + 0.5) * cellW, z0 + cellD / 2);
      if (free && runStart < 0) runStart = col;
      if (!free && runStart >= 0) {
        quad(-width / 2 + runStart * cellW, -width / 2 + col * cellW, z0, z0 + cellD);
        runStart = -1;
      }
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const SNAP = { x: 1.5, y: 2, z: 1.5 };
const EXACT = { x: 0.05, y: 0.5, z: 0.05 };

export class RoomNavMesh {
  private readonly query: NavMeshQuery;
  private helper: NavMeshHelper | null = null;
  private disposed = false;

  private constructor(private readonly navMesh: NavMesh) {
    this.query = new NavMeshQuery(navMesh);
  }

  static async create(room: RoomFile): Promise<RoomNavMesh> {
    await initNavigation();
    const { positions, indices } = buildFloorMesh(room);
    if (indices.length === 0) throw new Error('The room has no free floor to walk on.');
    const result = generateSoloNavMesh(positions, indices, {
      cs: CELL,
      ch: CELL,
      walkableSlopeAngle: 45,
      walkableHeight: Math.ceil(AGENT_HEIGHT / CELL),
      walkableClimb: Math.ceil(AGENT_MAX_CLIMB / CELL),
      walkableRadius: Math.ceil(AGENT_RADIUS / CELL),
      maxEdgeLen: 40,
      maxSimplificationError: 1.3,
      minRegionArea: 16,
      mergeRegionArea: 40,
      maxVertsPerPoly: 6,
      detailSampleDist: 6,
      detailSampleMaxError: 1,
    });
    if (!result.success || !result.navMesh) {
      throw new Error(`Could not build a navigation mesh: ${'error' in result ? String(result.error) : 'unknown error'}`);
    }
    return new RoomNavMesh(result.navMesh);
  }

  /** Straight-line waypoints from `from` to `to`, both snapped onto the walkable floor. Null when unreachable. */
  findPath(from: Vec3, to: Vec3): Vec3[] | null {
    if (this.disposed) return null;
    const result = this.query.computePath(vec(from), vec(to), { halfExtents: SNAP });
    if (!result.success || result.path.length === 0) return null;
    return result.path.map((p) => [p.x, p.y, p.z] as Vec3);
  }

  /** The nearest point on the walkable floor (or `p` itself if the navmesh is unavailable). */
  closestWalkable(p: Vec3): Vec3 {
    if (this.disposed) return p;
    const result = this.query.findClosestPoint(vec(p), { halfExtents: SNAP });
    return result.success ? [result.point.x, result.point.y, result.point.z] : p;
  }

  isWalkable(p: Vec3): boolean {
    if (this.disposed) return false;
    const result = this.query.findNearestPoly(vec(p), { halfExtents: EXACT });
    return result.success && result.nearestRef !== 0;
  }

  /** Semi-transparent overlay of the walkable area for the developer toggle. */
  debugMesh(): THREE.Object3D {
    if (!this.helper) {
      this.helper = new NavMeshHelper(this.navMesh, {
        navMeshMaterial: new THREE.MeshBasicMaterial({
          color: 0x2ee6a6,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      });
      this.helper.position.y = 0.03;
      this.helper.name = 'navmesh-debug';
    }
    return this.helper;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.helper) {
      this.helper.removeFromParent();
      this.helper.navMeshGeometry.dispose();
      this.helper.navMeshMaterial.dispose();
      this.helper = null;
    }
    this.query.destroy();
    this.navMesh.destroy();
  }
}

function vec(p: Vec3): { x: number; y: number; z: number } {
  return { x: p[0], y: p[1], z: p[2] };
}
