/**
 * Swaps a placed object's simple shapes for a model made afterwards. The object keeps its position
 * and turn (the renderer centres a model's footprint on the object origin); its size becomes the
 * model's real size. If the new footprint would run into a wall, the avatar's spot or another
 * object, the shapes stay and a reason comes back. Pure.
 */
import { corners, insideRoom, overlaps, rectOf, type Rect } from './placer-geometry.js';
import type { ResolvedModel } from './room-placer.js';
import type { RoomFile, RoomObject, Vec3 } from './types.js';

/** Half-width of the square around the avatar's home spot that nothing may stand in. */
const HOME_CLEAR = 0.7;
const ON_SURFACE = 0.05;
/** The most an object is slid to keep its new footprint inside the walls. */
const MAX_NUDGE = 0.25;
const WALL_MARGIN = 0.02;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** How far to move a rectangle so it clears the walls (with the placer's 2 cm margin). */
function overshoot(rect: Rect, halfW: number, halfD: number): [number, number] {
  const points = corners(rect);
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  const axis = (low: number, high: number, half: number) =>
    Math.max(0, -half + WALL_MARGIN - low) - Math.max(0, high - (half - WALL_MARGIN));
  return [axis(Math.min(...xs), Math.max(...xs), halfW), axis(Math.min(...zs), Math.max(...zs), halfD)];
}

export type RefitResult = { ok: true; room: RoomFile } | { ok: false; reason: string };

export function refitObject(room: RoomFile, objectId: string, resolved: ResolvedModel): RefitResult {
  const object = room.objects.find((o) => o.id === objectId);
  if (!object) return { ok: false, reason: 'it is no longer in the room' };
  const [w, h, d] = resolved.size;
  const rotation = object.rotationY ?? 0;
  const halfW = room.shell.width / 2;
  const halfD = room.shell.depth / 2;
  let [x, , z] = object.position;
  let rect = rectOf(x, z, w, d, rotation);
  if (!insideRoom(rect, halfW, halfD)) {
    // An object that stood flush against a wall may be a little deeper than the shapes were:
    // slide it in by the overshoot, as long as that is small.
    const [dx, dz] = overshoot(rect, halfW, halfD);
    if (Math.abs(dx) > MAX_NUDGE || Math.abs(dz) > MAX_NUDGE) return { ok: false, reason: 'it would stick out through a wall' };
    x += dx;
    z += dz;
    rect = rectOf(x, z, w, d, rotation);
    if (!insideRoom(rect, halfW, halfD)) return { ok: false, reason: 'it would stick out through a wall' };
  }
  if (object.collider !== 'none' && object.dynamic !== true) {
    const home = rectOf(room.home.position[0], room.home.position[2], HOME_CLEAR * 2, HOME_CLEAR * 2, 0);
    if (overlaps(rect, home)) return { ok: false, reason: 'it would be in the way of the spot where the avatar stands' };
  }
  // Things resting on other things (y above the floor) only compete with others at that height.
  const raised = object.position[1] > ON_SURFACE;
  for (const other of room.objects) {
    if (other.id === objectId || other.collider === 'none') continue;
    if (raised !== other.position[1] > ON_SURFACE) continue;
    if (overlaps(rect, rectOf(other.position[0], other.position[2], other.size[0], other.size[2], other.rotationY ?? 0))) {
      return { ok: false, reason: `it would overlap the ${other.name}` };
    }
  }

  const oldDepth = object.size[2];
  const tags = object.tags ? structuredClone(object.tags) : undefined;
  if (tags?.look) tags.look.position = [tags.look.position[0], round(h * 0.6), tags.look.position[2]];
  if (tags?.stand) {
    // The spot in front of the object moves with its front edge.
    const [x, y, z] = tags.stand.position;
    tags.stand.position = [x, y, round(z + Math.sign(z || 1) * ((d - oldDepth) / 2))] as Vec3;
  }
  const next: RoomObject = {
    ...object,
    position: [round(x), object.position[1], round(z)],
    size: [round(w), round(h), round(d)],
    model: { ...resolved.model },
    ...(tags ? { tags } : {}),
  };
  delete next.parts;
  return { ok: true, room: { ...room, objects: room.objects.map((o) => (o.id === objectId ? next : o)) } };
}
