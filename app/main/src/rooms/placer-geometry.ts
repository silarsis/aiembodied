/** 2D helpers for the room placer: rotated rectangles on the floor plan (x, z), degrees as in RoomObject. */
export interface Rect {
  cx: number;
  cz: number;
  /** Half extents along the rectangle's own x and z axes. */
  hx: number;
  hz: number;
  /** Degrees; a facing of theta points along (sin theta, cos theta). */
  rot: number;
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;

export function rectOf(cx: number, cz: number, width: number, depth: number, rot: number): Rect {
  return { cx, cz, hx: width / 2, hz: depth / 2, rot };
}

/** Local (x, z) of a rect to world (x, z); same maths as objectToWorld in the renderer. */
export function toWorld(rect: Pick<Rect, 'cx' | 'cz' | 'rot'>, lx: number, lz: number): [number, number] {
  const a = rad(rect.rot);
  return [rect.cx + lx * Math.cos(a) + lz * Math.sin(a), rect.cz - lx * Math.sin(a) + lz * Math.cos(a)];
}

export function toLocal(rect: Pick<Rect, 'cx' | 'cz' | 'rot'>, x: number, z: number): [number, number] {
  const a = rad(rect.rot);
  const dx = x - rect.cx;
  const dz = z - rect.cz;
  return [dx * Math.cos(a) - dz * Math.sin(a), dx * Math.sin(a) + dz * Math.cos(a)];
}

export function corners(rect: Rect): Array<[number, number]> {
  return [
    toWorld(rect, -rect.hx, -rect.hz),
    toWorld(rect, rect.hx, -rect.hz),
    toWorld(rect, rect.hx, rect.hz),
    toWorld(rect, -rect.hx, rect.hz),
  ];
}

/** Separating-axis test. `gap` is the clear distance required between the two (split evenly). */
export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  const ia = { ...a, hx: a.hx + gap / 2, hz: a.hz + gap / 2 };
  const ib = { ...b, hx: b.hx + gap / 2, hz: b.hz + gap / 2 };
  const ca = corners(ia);
  const cb = corners(ib);
  const axes: Array<[number, number]> = [
    [Math.cos(rad(a.rot)), -Math.sin(rad(a.rot))],
    [Math.sin(rad(a.rot)), Math.cos(rad(a.rot))],
    [Math.cos(rad(b.rot)), -Math.sin(rad(b.rot))],
    [Math.sin(rad(b.rot)), Math.cos(rad(b.rot))],
  ];
  for (const [ax, az] of axes) {
    const pa = ca.map(([x, z]) => x * ax + z * az);
    const pb = cb.map(([x, z]) => x * ax + z * az);
    if (Math.max(...pa) <= Math.min(...pb) + 1e-9 || Math.max(...pb) <= Math.min(...pa) + 1e-9) return false;
  }
  return true;
}

/** True when every corner of `rect` is inside the room interior (shrunk by `margin`). */
export function insideRoom(rect: Rect, halfW: number, halfD: number, margin = 0.02): boolean {
  return corners(rect).every(([x, z]) => Math.abs(x) <= halfW - margin + 1e-9 && Math.abs(z) <= halfD - margin + 1e-9);
}

/** True when `inner` lies completely inside `outer` (both rotated rectangles). */
export function contains(outer: Rect, inner: Rect, margin = 0): boolean {
  return corners(inner).every(([x, z]) => {
    const [lx, lz] = toLocal(outer, x, z);
    return Math.abs(lx) <= outer.hx - margin + 1e-9 && Math.abs(lz) <= outer.hz - margin + 1e-9;
  });
}

/** Distance from a point to the rectangle (0 inside). */
export function distanceToRect(rect: Rect, x: number, z: number): number {
  const [lx, lz] = toLocal(rect, x, z);
  return Math.hypot(Math.max(Math.abs(lx) - rect.hx, 0), Math.max(Math.abs(lz) - rect.hz, 0));
}

/** The facing (degrees) that points from (fx, fz) towards (tx, tz). */
export function facingToward(fx: number, fz: number, tx: number, tz: number): number {
  return (Math.atan2(tx - fx, tz - fz) * 180) / Math.PI;
}

export function snapAngle(degrees: number, step: number): number {
  return normalizeDegrees(Math.round(degrees / step) * step);
}

/** Into (-180, 180]. */
export function normalizeDegrees(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** Small deterministic generator (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
