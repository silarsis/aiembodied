/**
 * Deterministic room placer: turns a RoomLayout (what the language model wrote) plus the models
 * found for its objects into a valid RoomFile. Wall objects first, then free anchors, `near`
 * objects, the remaining free objects, rugs, and last the `on` objects on their surfaces. Objects
 * that cannot fit are dropped with a warning; a walkability pass keeps seats, surfaces and props
 * reachable from the avatar's home spot.
 */
import {
  contains, facingToward, insideRoom, normalizeDegrees, overlaps, rectOf, seededRandom, snapAngle, toWorld, type Rect,
} from './placer-geometry.js';
import { lightsFor, lightingCeiling, lightingOutside, resolveColor } from './room-palette.js';
import { buildParts } from './room-primitives.js';
import { buildWalkability, findUnreachable, reachableStand } from './room-walkability.js';
import type { LayoutObject, RoomLayout, WallSide } from './room-layout.js';
import type { RoomFile, RoomObject, RoomOpening, RoomModelRef, Vec3 } from './types.js';

export interface ResolvedModel {
  model: RoomModelRef & { asset: string; scale: number };
  /** The scaled real size of the model (width, height, depth). */
  size: Vec3;
}
export interface PlaceOptions {
  layout: RoomLayout;
  /** Library models by layout object id; objects missing here get simple shapes. */
  resolved?: Record<string, ResolvedModel | undefined>;
  seed?: number;
  roomId?: string;
}
export interface PlaceResult {
  room: RoomFile;
  warnings: string[];
  dropped: string[];
}

const GAP = 0.1;
const TALL = 0.85;
const FLAT = 0.06;
const SIGHT_HALF = 0.45;
const HOME_CLEAR = 0.7;
const CAMERA_INSET = 0.4;
const HOME_DISTANCE = 2.3;
const WALL_FACING: Record<WallSide, number> = { north: 0, south: 180, east: -90, west: 90 };

interface Zone {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  tallOnly: boolean;
}
type Phase = 'wall' | 'near' | 'free' | 'flat' | 'on';
interface Placed {
  object: LayoutObject;
  size: Vec3;
  x: number;
  y: number;
  z: number;
  rot: number;
  phase: Phase;
}

const isFlat = (o: LayoutObject, size: Vec3) => size[1] < FLAT && !o.grabbable;
const isSurface = (o: LayoutObject) => o.surface || o.category === 'table';

export function placeRoom(options: PlaceOptions): PlaceResult {
  const { layout } = options;
  const rng = seededRandom(options.seed ?? 1);
  const warnings: string[] = [];
  const dropped: string[] = [];
  const { width, depth, height } = layout.shell;
  const halfW = width / 2;
  const halfD = depth / 2;
  const camZ = halfD - CAMERA_INSET;
  const homeZ = Math.max(camZ - HOME_DISTANCE, -halfD + 1.0);

  const openings = buildOpenings(layout, warnings);
  const zones: Zone[] = [
    { x0: -HOME_CLEAR, x1: HOME_CLEAR, z0: homeZ - HOME_CLEAR, z1: homeZ + HOME_CLEAR, tallOnly: false },
    { x0: -SIGHT_HALF, x1: SIGHT_HALF, z0: homeZ, z1: camZ, tallOnly: true },
  ];
  for (const o of openings) {
    const strip = o.kind === 'door' ? 1.0 : 0.8;
    const half = o.width / 2 + (o.kind === 'door' ? 0.2 : 0.1);
    const a = o.offset - half;
    const b = o.offset + half;
    const zone: Zone =
      o.wall === 'north' ? { x0: a, x1: b, z0: -halfD, z1: -halfD + strip, tallOnly: o.kind === 'window' }
      : o.wall === 'south' ? { x0: a, x1: b, z0: halfD - strip, z1: halfD, tallOnly: o.kind === 'window' }
      : o.wall === 'west' ? { x0: -halfW, x1: -halfW + strip, z0: a, z1: b, tallOnly: o.kind === 'window' }
      : { x0: halfW - strip, x1: halfW, z0: a, z1: b, tallOnly: o.kind === 'window' };
    zones.push(zone);
  }

  const placed = new Map<string, Placed>();
  const sizeOf = (o: LayoutObject): Vec3 => options.resolved?.[o.id]?.size ?? o.size;
  const rectOfPlaced = (p: Placed): Rect => rectOf(p.x, p.z, p.size[0], p.size[2], p.rot);

  const zoneBlocked = (rect: Rect, tall: boolean): boolean => {
    for (const z of zones) {
      if (z.tallOnly && !tall) continue;
      if (overlaps(rect, rectOf((z.x0 + z.x1) / 2, (z.z0 + z.z1) / 2, z.x1 - z.x0, z.z1 - z.z0, 0))) return true;
    }
    return false;
  };
  const collides = (rect: Rect, size: Vec3, ignore?: string): boolean => {
    if (!insideRoom(rect, halfW, halfD)) return true;
    if (zoneBlocked(rect, size[1] > TALL)) return true;
    for (const [id, p] of placed) {
      if (id === ignore || p.phase === 'on' || p.phase === 'flat') continue;
      if (overlaps(rect, rectOfPlaced(p), GAP)) return true;
    }
    return false;
  };

  const drop = (o: LayoutObject, why: string) => {
    if (dropped.includes(o.id)) return;
    dropped.push(o.id);
    warnings.push(`Left out the ${o.name}: ${why}.`);
  };
  const place = (o: LayoutObject, phase: Phase, x: number, y: number, z: number, rot: number) => {
    placed.set(o.id, { object: o, size: sizeOf(o), x, y, z, rot: normalizeDegrees(rot), phase });
  };
  const snapFor = (o: LayoutObject) => (['table', 'storage', 'bed', 'appliance'].includes(o.category) ? 90 : 15);
  const targetPoint = (o: LayoutObject, fromX: number, fromZ: number, fallback: [number, number]): [number, number] => {
    const t = o.place.facing && o.place.facing !== 'center' ? placed.get(o.place.facing) : undefined;
    return t ? [t.x, t.z] : fallback;
  };

  const byId = new Map(layout.objects.map((o) => [o.id, o]));
  const all = layout.objects;
  const area = (o: LayoutObject) => sizeOf(o)[0] * sizeOf(o)[2];

  // 1. Wall objects, largest first.
  const wallObjects = all.filter((o) => o.place.against && !o.place.on && !isFlat(o, sizeOf(o))).sort((a, b) => area(b) - area(a));
  const failedWall: LayoutObject[] = [];
  for (const o of wallObjects) if (!placeAgainstWall(o)) failedWall.push(o);

  function placeAgainstWall(o: LayoutObject): boolean {
    const wall = o.place.against as WallSide;
    const size = sizeOf(o);
    const rot = WALL_FACING[wall];
    const alongX = wall === 'north' || wall === 'south';
    const length = alongX ? width : depth;
    const half = size[0] / 2;
    const normal = size[2] / 2 + 0.02;
    let best: { score: number; x: number; z: number } | null = null;
    for (let u = -length / 2 + half + 0.02; u <= length / 2 - half - 0.02 + 1e-9; u += 0.1) {
      const x = alongX ? u : wall === 'east' ? halfW - normal : -halfW + normal;
      const z = alongX ? (wall === 'north' ? -halfD + normal : halfD - normal) : u;
      const rect = rectOf(x, z, size[0], size[2], rot);
      if (collides(rect, size)) continue;
      const toCorner = length / 2 - Math.abs(u) - half;
      const score = (o.place.corner ? -toCorner : -Math.abs(u) * 0.3) + rng() * 0.02;
      if (!best || score > best.score) best = { score, x, z };
    }
    if (!best) return false;
    place(o, 'wall', best.x, 0, best.z, rot);
    return true;
  }

  // 2. Free search shared by free objects, failed wall objects and repairs.
  function freeCandidates(o: LayoutObject): Array<{ x: number; z: number; rot: number; score: number }> {
    const size = sizeOf(o);
    const out: Array<{ x: number; z: number; rot: number; score: number }> = [];
    const [tx, tz] = targetPoint(o, 0, 0, [0, 0]);
    const step = size[0] * size[2] > 1 ? 0.2 : 0.1;
    for (let x = -halfW + size[0] / 2; x <= halfW - size[0] / 2 + 1e-9; x += step)
      for (let z = -halfD + size[2] / 2; z <= halfD - size[2] / 2 + 1e-9; z += step) {
        const rot = snapAngle(facingToward(x, z, tx, tz), snapFor(o));
        const home = Math.hypot(x, z - homeZ);
        const score = -Math.abs(home - 1.9) * 0.5 - Math.abs(x) * 0.1 + rng() * 0.05;
        out.push({ x, z, rot, score });
      }
    return out.sort((a, b) => b.score - a.score);
  }
  function placeFree(o: LayoutObject, phase: Phase = 'free', ignore?: string): boolean {
    const size = sizeOf(o);
    for (const c of freeCandidates(o)) {
      if (collides(rectOf(c.x, c.z, size[0], size[2], c.rot), size, ignore)) continue;
      place(o, phase, c.x, 0, c.z, c.rot);
      return true;
    }
    return false;
  }

  // 3. Free objects that something else is near, then `near` objects in dependency order.
  const anchors = new Set(all.map((o) => o.place.near).filter((id): id is string => Boolean(id)));
  const nearObjects = all.filter((o) => o.place.near && !o.place.against && !o.place.on);
  const freeObjects = all.filter((o) => !o.place.against && !o.place.near && !o.place.on && !isFlat(o, sizeOf(o)));
  for (const o of failedWall) {
    if (placeFree(o)) warnings.push(`The ${o.name} did not fit against the ${o.place.against} wall and was put elsewhere.`);
    else drop(o, 'there was no room');
  }
  for (const o of freeObjects.filter((f) => anchors.has(f.id)).sort((a, b) => area(b) - area(a)))
    if (!placeFree(o)) drop(o, 'there was no room');
  let pending = [...nearObjects].sort((a, b) => area(b) - area(a));
  for (let round = 0; round < 4 && pending.length; round += 1) {
    const next: LayoutObject[] = [];
    for (const o of pending) {
      const anchorId = o.place.near as string;
      if (dropped.includes(anchorId) || !byId.has(anchorId)) {
        if (!placeFree(o)) drop(o, 'there was no room');
      } else if (!placed.has(anchorId)) next.push(o);
      else if (!placeNear(o, placed.get(anchorId) as Placed)) {
        if (placeFree(o)) warnings.push(`The ${o.name} could not go next to the ${byId.get(anchorId)?.name} and was put elsewhere.`);
        else drop(o, 'there was no room');
      }
    }
    pending = next;
  }
  for (const o of pending) if (!placeFree(o)) drop(o, 'there was no room');

  function placeNear(o: LayoutObject, anchor: Placed): boolean {
    const size = sizeOf(o);
    const a = rectOfPlaced(anchor);
    const [tx, tz] = o.place.facing ? targetPoint(o, 0, 0, [0, 0]) : [anchor.x, anchor.z];
    const centre = Math.hypot(anchor.x, anchor.z) || 1;
    const reach = Math.max(size[0], size[2]) / 2;
    let best: { score: number; x: number; z: number; rot: number } | null = null;
    for (const side of [0, 1, 2, 3]) {
      const horizontal = side < 2;
      const sign = side % 2 === 0 ? 1 : -1;
      const alongHalf = horizontal ? a.hx : a.hz;
      const tangentHalf = horizontal ? a.hz : a.hx;
      for (const gap of [0.15, 0.3, 0.5]) {
        for (let t = -tangentHalf; t <= tangentHalf + 1e-9; t += 0.1) {
          const [x, z] = horizontal ? toWorld(a, sign * (alongHalf + gap + reach), t) : toWorld(a, t, sign * (alongHalf + gap + reach));
          const rot = snapAngle(facingToward(x, z, tx, tz), snapFor(o));
          if (collides(rectOf(x, z, size[0], size[2], rot), size)) continue;
          const dx = x - anchor.x;
          const dz = z - anchor.z;
          const inward = (-anchor.x * dx - anchor.z * dz) / (centre * (Math.hypot(dx, dz) || 1));
          const score = inward - gap * 2 - Math.abs(t) * 0.2 + rng() * 0.02;
          if (!best || score > best.score) best = { score, x, z, rot };
        }
      }
    }
    if (!best) return false;
    place(o, 'near', best.x, 0, best.z, best.rot);
    return true;
  }

  for (const o of freeObjects.filter((f) => !anchors.has(f.id)).sort((a, b) => area(b) - area(a)))
    if (!placeFree(o)) drop(o, 'there was no room');

  // 4. Rugs and other flat things: under the furniture group.
  const flats = all.filter((o) => isFlat(o, sizeOf(o)) && !o.place.on);
  for (const o of flats) {
    const group = [...placed.values()].filter((p) => p.phase === 'near' || p.phase === 'free');
    const cx = group.length ? group.reduce((s, p) => s + p.x, 0) / group.length : 0;
    const cz = group.length ? group.reduce((s, p) => s + p.z, 0) / group.length : homeZ;
    const size = sizeOf(o);
    const x = Math.max(-halfW + size[0] / 2 + 0.03, Math.min(halfW - size[0] / 2 - 0.03, cx));
    const z = Math.max(-halfD + size[2] / 2 + 0.03, Math.min(halfD - size[2] / 2 - 0.03, cz));
    if (insideRoom(rectOf(x, z, size[0], size[2], 0), halfW, halfD)) place(o, 'flat', x, 0, z, 0);
    else drop(o, 'it is larger than the room');
  }

  // 5. Facing pass: turn objects towards a named target once everything is placed.
  for (const p of placed.values()) {
    const f = p.object.place.facing;
    if (!f || p.phase === 'wall' || p.phase === 'flat') continue;
    const [tx, tz] = f === 'center' ? [0, 0] : placed.has(f) ? centreOf(f) : [NaN, NaN];
    if (Number.isNaN(tx)) continue;
    const rot = snapAngle(facingToward(p.x, p.z, tx, tz), snapFor(p.object));
    if (!collides(rectOf(p.x, p.z, p.size[0], p.size[2], rot), p.size, p.object.id)) p.rot = rot;
  }

  function centreOf(id: string): [number, number] {
    const t = placed.get(id) as Placed;
    return [t.x, t.z];
  }

  // 6. `on` objects, in dependency order.
  const onObjects = all.filter((o) => o.place.on);
  let waiting = onObjects;
  for (let round = 0; round < 4 && waiting.length; round += 1) {
    const next: LayoutObject[] = [];
    for (const o of waiting) {
      const base = o.place.on as string;
      if (dropped.includes(base)) drop(o, `the ${byId.get(base)?.name} it belongs on was left out`);
      else if (!placed.has(base)) next.push(o);
      else if (!placeOn(o, placed.get(base) as Placed)) drop(o, `it does not fit on the ${byId.get(base)?.name}`);
    }
    waiting = next;
  }
  for (const o of waiting) drop(o, 'its surface could not be found');

  function placeOn(o: LayoutObject, base: Placed): boolean {
    const size = sizeOf(o);
    const top = rectOfPlaced(base);
    const topY = base.y + surfaceHeight(base.object, base.size);
    let best: { x: number; z: number; score: number } | null = null;
    const others = [...placed.values()].filter((p) => p.phase === 'on' && p.object.place.on === base.object.id);
    for (let lx = -top.hx; lx <= top.hx + 1e-9; lx += 0.05)
      for (let lz = -top.hz; lz <= top.hz + 1e-9; lz += 0.05) {
        const [x, z] = toWorld(top, lx, lz);
        const rect = rectOf(x, z, size[0], size[2], top.rot);
        if (!contains(top, rect, 0.03)) continue;
        if (others.some((p) => overlaps(rect, rectOfPlaced(p), 0.05))) continue;
        const spread = others.length ? Math.min(...others.map((p) => Math.hypot(p.x - x, p.z - z))) : 0;
        const score = (others.length ? spread : -Math.hypot(lx, lz)) + rng() * 0.01;
        if (!best || score > best.score) best = { x, z, score };
      }
    if (!best) return false;
    place(o, 'on', best.x, topY, best.z, top.rot);
    return true;
  }

  // 7. Walkability: move or drop objects until everything that matters can be reached.
  repairReach();
  function repairReach() {
    for (let guard = 0; guard < 24; guard += 1) {
      const failing = findUnreachable(toRoom());
      if (failing.length === 0) return;
      const target = failing[0];
      const movable = [...placed.values()]
        .filter((p) => (p.phase === 'free' || p.phase === 'near') && p.object.id !== target)
        .sort((a, b) => a.size[0] * a.size[2] - b.size[0] * b.size[2]);
      let fixed = false;
      for (const m of movable) {
        const saved = new Map<string, Placed>();
        for (const p of [m, ...dependents(m.object.id)]) {
          saved.set(p.object.id, p);
          placed.delete(p.object.id);
        }
        if (findUnreachable(toRoom()).includes(target)) {
          for (const [id, p] of saved) placed.set(id, p);
          continue;
        }
        // Removing it helped: put it back somewhere that keeps the target reachable, else drop it.
        const o = m.object;
        let back = false;
        const size = sizeOf(o);
        for (const c of freeCandidates(o).slice(0, 60)) {
          if (collides(rectOf(c.x, c.z, size[0], size[2], c.rot), size)) continue;
          place(o, m.phase, c.x, 0, c.z, c.rot);
          if (!findUnreachable(toRoom()).includes(target)) {
            back = true;
            break;
          }
          placed.delete(o.id);
        }
        if (back) {
          for (const [id, p] of saved) if (id !== o.id) placed.set(id, { ...p, y: p.y });
          reseat([...saved.keys()].filter((id) => id !== o.id));
        } else {
          drop(o, 'it blocked the way to other things');
          for (const id of saved.keys()) if (id !== o.id) drop(byId.get(id) as LayoutObject, 'its surface was left out');
        }
        fixed = true;
        break;
      }
      if (!fixed) {
        const p = placed.get(target);
        if (!p) return;
        placed.delete(target);
        drop(p.object, 'there was no way to walk up to it');
        for (const d of dependents(target)) {
          placed.delete(d.object.id);
          drop(d.object, 'its surface was left out');
        }
      }
    }
  }
  function dependents(id: string): Placed[] {
    const result: Placed[] = [];
    for (const p of placed.values()) if (p.object.place.on === id) result.push(p, ...dependents(p.object.id));
    return result;
  }
  /** Props that rested on a moved surface are placed again on it. */
  function reseat(ids: string[]) {
    for (const id of ids) {
      const p = placed.get(id);
      placed.delete(id);
      const base = p?.object.place.on ? placed.get(p.object.place.on) : undefined;
      if (p && base && placeOn(p.object, base)) continue;
      if (p) drop(p.object, 'it no longer fit on its surface');
    }
  }

  // 8. Output.
  function toRoom(): RoomFile {
    return buildRoomFile();
  }
  function buildRoomFile(): RoomFile {
    const lamp = [...placed.values()].find((p) => p.object.category === 'lamp');
    const objects: RoomObject[] = [];
    for (const o of all) {
      const p = placed.get(o.id);
      if (p) objects.push(toRoomObject(p));
    }
    return {
      version: 1,
      id: options.roomId ?? 'room:generated',
      name: layout.name,
      ...(layout.description ? { description: layout.description } : {}),
      shell: {
        width,
        depth,
        height,
        floor: { color: resolveColor(layout.shell.floor, '#a87b4d') },
        walls: { color: resolveColor(layout.shell.walls, '#e8dfc8') },
        ceiling: { color: lightingCeiling(layout.lighting) },
        outside: { color: lightingOutside(layout.lighting) },
        openings,
      },
      lights: lightsFor(layout.lighting, height, lamp ? [lamp.x, lamp.size[1] + 0.2, lamp.z] : [0, height - 0.4, 0]),
      camera: { position: [0, 1.5, round(camZ)], target: [0, 1.0, round(homeZ)], fov: 50 },
      home: { position: [0, 0, round(homeZ)], facing: 0 },
      objects,
    };
  }
  function toRoomObject(p: Placed): RoomObject {
    const o = p.object;
    const [w, h, d] = p.size;
    const resolved = options.resolved?.[o.id];
    const tags: NonNullable<RoomObject['tags']> = { look: { position: [0, round(h * 0.6), 0] } };
    const sittable = o.category === 'seat' || o.category === 'bed';
    const seatH = Math.min(o.seatHeight ?? (o.category === 'bed' ? 0.5 : 0.45), h);
    if (sittable) {
      tags.sit = { position: [0, round(seatH), 0.05], facing: 0 };
      tags.stand = { position: [0, 0, round(d / 2 + 0.5)], facing: 180 };
    } else if (isSurface(o) || ['storage', 'appliance'].includes(o.category)) {
      tags.stand = { position: [0, 0, round(d / 2 + 0.5)], facing: 180 };
    }
    if (isSurface(o)) tags.surface = { height: round(surfaceHeight(o, p.size)) };
    if (o.grabbable) tags.grab = { position: [0, round(h), 0] };
    if (o.idle) tags.idle = o.idle;
    return {
      id: o.id,
      name: o.name,
      position: [round(p.x), round(p.y), round(p.z)],
      rotationY: round(p.rot),
      size: [round(w), round(h), round(d)],
      ...(resolved ? { model: { ...resolved.model } } : { parts: buildParts({ category: o.category, name: o.name, size: p.size, color: resolveColor(o.color, '#b8b0a4'), seatHeight: sittable ? seatH : undefined }) }),
      ...(isFlat(o, p.size) ? { collider: 'none' as const } : {}),
      ...(o.grabbable ? { dynamic: true } : {}),
      tags,
    };
  }

  const room = buildRoomFile();
  // Stand next to a seat on a side the avatar can actually reach (a chair at a desk faces the desk).
  const walk = buildWalkability(room);
  for (const object of room.objects) {
    if (!object.tags?.sit) continue;
    const stand = reachableStand(object, walk);
    if (stand) object.tags.stand = { position: stand.position.map(round) as Vec3, facing: stand.facing };
  }
  return { room, warnings, dropped };
}

function surfaceHeight(o: LayoutObject, size: Vec3): number {
  return o.category === 'storage' ? Math.min(size[1], 1.0) : size[1];
}
const round = (n: number) => Math.round(n * 1000) / 1000;

function buildOpenings(layout: RoomLayout, warnings: string[]): RoomOpening[] {
  const { width, depth, height } = layout.shell;
  const length = (wall: WallSide) => (wall === 'north' || wall === 'south' ? width : depth);
  const result: RoomOpening[] = [];
  const doorWall = layout.shell.door?.wall;
  const doorHalf = 0.475;
  if (doorWall) {
    const max = length(doorWall) / 2 - doorHalf - 0.35;
    result.push({ wall: doorWall, kind: 'door', offset: round(max), width: 0.95, height: Math.min(2.1, height - 0.2) });
  }
  const winHeight = Math.min(1.3, height - 0.95 - 0.3);
  for (const wall of ['north', 'south', 'east', 'west'] as const) {
    const windows = layout.shell.windows.filter((w) => w.wall === wall);
    if (windows.length === 0) continue;
    const L = length(wall);
    let lo = -L / 2 + 0.3;
    let hi = L / 2 - 0.3;
    if (doorWall === wall) {
      const doorOffset = result[0].offset;
      const left = [lo, doorOffset - doorHalf - 0.25] as const;
      hi = left[1];
      lo = left[0];
    }
    const slot = (hi - lo) / windows.length;
    windows.forEach((w, i) => {
      const win = Math.min(w.width, slot - 0.3);
      if (win < 0.5) {
        warnings.push(`Left out a window on the ${wall} wall: no room for it.`);
        return;
      }
      result.push({ wall, kind: 'window', offset: round(lo + slot * (i + 0.5)), width: round(win), height: winHeight, sill: 0.95 });
    });
  }
  return result;
}
