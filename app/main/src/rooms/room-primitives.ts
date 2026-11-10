/**
 * Simple shapes for an object with no library model: a category-specific little builder.
 * Parts are relative to the object origin (floor contact, centre of the footprint); +Z is the front.
 */
import { shade } from './room-palette.js';
import type { ObjectCategory } from './room-layout.js';
import type { RoomPart, Vec3 } from './types.js';

const box = (size: Vec3, offset: Vec3, color: string): RoomPart => ({ shape: 'box', size: size.map((n) => Math.max(0.01, round(n))) as Vec3, offset: offset.map(round) as Vec3, color });
const cyl = (radius: number, height: number, offset: Vec3, color: string): RoomPart => ({ shape: 'cylinder', radius: Math.max(0.01, round(radius)), height: Math.max(0.01, round(height)), offset: offset.map(round) as Vec3, color });
const ball = (radius: number, offset: Vec3, color: string): RoomPart => ({ shape: 'sphere', radius: Math.max(0.01, round(radius)), offset: offset.map(round) as Vec3, color });
const round = (n: number) => Math.round(n * 1000) / 1000;

export interface PrimitiveSpec {
  category: ObjectCategory;
  name: string;
  size: Vec3;
  color: string;
  seatHeight?: number;
}

export function buildParts(spec: PrimitiveSpec): RoomPart[] {
  switch (spec.category) {
    case 'seat':
      return seat(spec);
    case 'table':
      return table(spec);
    case 'storage':
      return storage(spec);
    case 'bed':
      return bed(spec);
    case 'lamp':
      return lamp(spec);
    case 'plant':
      return plant(spec);
    case 'appliance':
      return appliance(spec);
    case 'decor':
      return decor(spec);
    default:
      return prop(spec);
  }
}

function seat({ size: [w, h, d], color, seatHeight }: PrimitiveSpec): RoomPart[] {
  const sh = Math.min(seatHeight ?? 0.45, h);
  const baseH = Math.max(0.05, sh - 0.08);
  const parts = [box([w, baseH, d], [0, baseH / 2, 0], color), box([w - 0.1, 0.08, d - 0.1], [0, sh - 0.04, 0.03], shade(color, 1.15))];
  const backH = h - sh;
  if (backH > 0.15) {
    const t = Math.min(0.2, d * 0.25);
    parts.push(box([w, backH + 0.04, t], [0, sh + backH / 2 - 0.02, -d / 2 + t / 2], color));
    if (w > 0.55) {
      const armW = Math.min(0.16, w * 0.12);
      for (const side of [-1, 1]) parts.push(box([armW, 0.26, d - t], [side * (w / 2 - armW / 2), sh + 0.13 - 0.04, t / 2], shade(color, 0.88)));
    }
  }
  return parts;
}

function table({ size: [w, h, d], color }: PrimitiveSpec): RoomPart[] {
  const top = Math.min(0.05, h * 0.2);
  const leg = Math.min(0.07, w * 0.12, d * 0.12);
  const parts = [box([w, top, d], [0, h - top / 2, 0], color)];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) parts.push(box([leg, h - top, leg], [sx * (w / 2 - leg), (h - top) / 2, sz * (d / 2 - leg)], shade(color, 0.8)));
  return parts;
}

function storage({ size: [w, h, d], color }: PrimitiveSpec): RoomPart[] {
  if (h < 1) return [box([w, h - 0.03, d], [0, (h - 0.03) / 2, 0], color), box([w + 0.02, 0.03, d + 0.02], [0, h - 0.015, 0], shade(color, 1.12))];
  const side = 0.04;
  const parts = [
    box([side, h, d], [-(w / 2 - side / 2), h / 2, 0], color),
    box([side, h, d], [w / 2 - side / 2, h / 2, 0], color),
    box([w, side, d], [0, h - side / 2, 0], color),
    box([w, 0.08, d], [0, 0.04, 0], shade(color, 0.85)),
    box([w - 2 * side, h, 0.02], [0, h / 2, -d / 2 + 0.01], shade(color, 0.8)),
  ];
  const shelves = Math.max(1, Math.round(h / 0.38) - 1);
  for (let i = 1; i <= shelves; i += 1) parts.push(box([w - 2 * side, 0.03, d - 0.03], [0, (h * i) / (shelves + 1), 0.005], shade(color, 1.08)));
  return parts;
}

function bed({ size: [w, h, d], color, seatHeight }: PrimitiveSpec): RoomPart[] {
  const sh = Math.min(seatHeight ?? 0.5, h);
  const baseH = sh * 0.5;
  const parts = [
    box([w, baseH, d], [0, baseH / 2, 0], shade(color, 0.7)),
    box([w - 0.06, sh - baseH, d - 0.06], [0, baseH + (sh - baseH) / 2, 0], shade(color, 1.2)),
    box([Math.min(0.6, w * 0.4), 0.1, 0.35], [0, sh + 0.05, -d / 2 + 0.3], '#f2f0ea'),
  ];
  if (h > sh + 0.2) parts.push(box([w, h, 0.06], [0, h / 2, -d / 2 + 0.03], shade(color, 0.7)));
  return parts;
}

function lamp({ size: [w, h], color }: PrimitiveSpec): RoomPart[] {
  const shadeH = Math.min(0.28, h * 0.35);
  const poleH = Math.max(0.02, h - shadeH - 0.04);
  return [
    cyl(Math.min(0.15, w * 0.4), 0.04, [0, 0.02, 0], shade(color, 0.6)),
    cyl(0.02, poleH, [0, 0.04 + poleH / 2, 0], shade(color, 0.6)),
    cyl(Math.max(0.05, w / 2) * 0.95, shadeH, [0, h - shadeH / 2, 0], '#f1e6c8'),
  ];
}

function plant({ size: [w, h], color }: PrimitiveSpec): RoomPart[] {
  const potH = h * 0.3;
  const radius = Math.max(0.05, Math.min(w / 2, (h - potH) * 0.6));
  return [cyl(w * 0.28, potH, [0, potH / 2, 0], '#a85f3e'), ball(radius, [0, Math.min(h - radius, potH + radius * 0.85), 0], /green|olive|sage|mint|teal/.test(color) || color === '#b8b0a4' ? '#4f8a52' : color)];
}

function appliance({ size: [w, h, d], color }: PrimitiveSpec): RoomPart[] {
  return [box([w, h, d], [0, h / 2, 0], color), box([w * 0.85, h * 0.78, 0.02], [0, h / 2, d / 2 + 0.005], shade(color, 0.35))];
}

function decor({ size: [w, h, d], name, color }: PrimitiveSpec): RoomPart[] {
  if (h <= 0.06 || /\b(rug|carpet|mat)\b/i.test(name)) {
    const t = Math.max(0.01, Math.min(h, 0.02));
    return [box([w, t, d], [0, t / 2, 0], color), box([w * 0.88, t * 1.1, d * 0.88], [0, (t * 1.1) / 2, 0], shade(color, 1.18))];
  }
  return [box([w, h * 0.85, d], [0, (h * 0.85) / 2, 0], color), box([w * 0.7, h * 0.15, d * 0.7], [0, h * 0.85 + (h * 0.15) / 2, 0], shade(color, 1.2))];
}

function prop({ size: [w, h, d], name, color }: PrimitiveSpec): RoomPart[] {
  if (/mug|cup|bottle|glass|can|vase|bowl|jar|candle|pot/i.test(name)) return [cyl(Math.min(w, d) / 2, h, [0, h / 2, 0], color)];
  return [box([w, h, d], [0, h / 2, 0], color)];
}
