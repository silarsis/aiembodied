/**
 * What a seat looks like, measured from an object's shapes: where the cushion top is, how far it reaches in front
 * of and behind the sit tag, what leans behind it and what is under the feet. Pure: it only samples a
 * `SurfaceSampler`, so it works for part-built furniture (analytic) and for models (ray-cast by the caller).
 * Measured in object-local space first (y up from the object's floor contact, tag facing in degrees, 0 = +Z),
 * then moved to the world by `seatGeometryToWorld`.
 */
import type { SitTag, Vec3 } from '../../../main/src/shared/rooms/types.js';
import { degToRad } from './room-geometry.js';
import { shapeTopAt, type LocalShape } from './room-shapes.js';

/** Highest surface not above `fromY` at object-local (x, z), or null when nothing is there. */
export type SurfaceSampler = (x: number, z: number, fromY: number) => number | null;

export interface BackRest {
  /** Metres from the sit tag back to the rest's front plane, along the facing direction reversed. */
  distance: number;
  /** Height of its top (object-local y, or world y after `seatGeometryToWorld`). */
  top: number;
}

export interface SeatGeometry {
  /** Top of the surface under the sit tag. */
  seatTopY: number;
  /** Metres from the sit tag forward to where the seat surface ends. */
  frontEdge: number;
  /** Back edge to front edge along the facing direction, metres. */
  depth: number;
  backRest: BackRest | null;
  /** Height of whatever is in front of the seat at foot level, normally the floor (0). */
  footFloorY: number;
}

export interface WorldSeatGeometry extends SeatGeometry {
  /** The sit tag in the world. */
  position: Vec3;
  /** World facing, degrees (0 = +Z). */
  facing: number;
}

/** How far above or below the tag a surface may be and still count as the seat (same as the stage's SURFACE_BAND). */
const SEAT_BAND = 0.25;
/** The seat surface ends where it steps up or down by more than this (metres). */
const EDGE_STEP = 0.06;
/** A surface this much above the seat counts as a back rest (metres). */
const BACKREST_RISE = 0.15;
const SAMPLE_STEP = 0.01;
const MAX_REACH = 1.5;
const MAX_BACKREST_REACH = 0.8;
/** Past the front edge, where the feet land (metres). */
const FOOT_AHEAD = 0.15;
const SKY = 100;

/** Sampler over part shapes: the highest top among them. */
export function shapeSampler(shapes: readonly LocalShape[]): SurfaceSampler {
  return (x, z, fromY) => {
    let best: number | null = null;
    for (const shape of shapes) {
      const top = shapeTopAt(shape, x, z, fromY);
      if (top !== null && (best === null || top > best)) best = top;
    }
    return best;
  };
}

export function seatGeometryLocal(tag: SitTag, sample: SurfaceSampler): SeatGeometry {
  const [sx, sy, sz] = tag.position;
  const angle = degToRad(tag.facing);
  const fx = Math.sin(angle);
  const fz = Math.cos(angle);
  const at = (d: number) => [sx + fx * d, sz + fz * d] as const;

  const topAt = (d: number) => {
    const [x, z] = at(d);
    const top = sample(x, z, sy + SEAT_BAND);
    return top !== null && top >= sy - SEAT_BAND ? top : null;
  };
  const seatTop = topAt(0) ?? sy;
  // Walks from the tag in one direction while the surface stays level with the seat top.
  const reach = (sign: 1 | -1): number => {
    let last = 0;
    for (let d = SAMPLE_STEP; d <= MAX_REACH; d += SAMPLE_STEP) {
      const top = topAt(sign * d);
      if (top === null || Math.abs(top - seatTop) > EDGE_STEP) break;
      last = d;
    }
    return last;
  };
  const front = reach(1);
  const back = reach(-1);

  let backRest: BackRest | null = null;
  for (let d = SAMPLE_STEP; d <= MAX_BACKREST_REACH; d += SAMPLE_STEP) {
    const [x, z] = at(-d);
    const top = sample(x, z, SKY);
    if (top !== null && top > seatTop + BACKREST_RISE) {
      // The highest point within a hand's width behind its front plane: a rounded or padded top is still the top.
      let highest = top;
      for (let e = d; e <= d + 0.15; e += SAMPLE_STEP) {
        const [ex, ez] = at(-e);
        highest = Math.max(highest, sample(ex, ez, SKY) ?? highest);
      }
      backRest = { distance: d, top: highest };
      break;
    }
  }

  const [footX, footZ] = at(front + FOOT_AHEAD);
  const footFloorY = sample(footX, footZ, seatTop - SEAT_BAND) ?? 0;
  return { seatTopY: seatTop, frontEdge: front, depth: front + back, backRest, footFloorY };
}

/** Applies the optional overrides of a sit tag's `seat` field. Depth keeps the measured front edge unless that is overridden too. */
export function applySeatOverrides(measured: SeatGeometry, seat: SitTag['seat']): SeatGeometry {
  if (!seat) return measured;
  const frontEdge = seat.frontEdge ?? measured.frontEdge;
  return {
    ...measured,
    seatTopY: seat.top ?? measured.seatTopY,
    frontEdge,
    depth:
      seat.depth ??
      (seat.frontEdge !== undefined
        ? measured.depth - measured.frontEdge + frontEdge
        : measured.depth),
  };
}

/** Moves an object-local seat geometry to the world: heights gain the object's y; distances are unchanged by a yaw. */
export function seatGeometryToWorld(
  local: SeatGeometry,
  tag: SitTag,
  object: { position: Vec3; yawDegrees: number },
): WorldSeatGeometry {
  const angle = degToRad(object.yawDegrees);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const y = object.position[1];
  return {
    seatTopY: local.seatTopY + y,
    frontEdge: local.frontEdge,
    depth: local.depth,
    backRest: local.backRest
      ? { distance: local.backRest.distance, top: local.backRest.top + y }
      : null,
    footFloorY: local.footFloorY + y,
    position: [
      object.position[0] + tag.position[0] * cos + tag.position[2] * sin,
      y + tag.position[1],
      object.position[2] - tag.position[0] * sin + tag.position[2] * cos,
    ],
    facing: tag.facing + object.yawDegrees,
  };
}
