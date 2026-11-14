/**
 * What the satellite's tray icon says about the devices: the tooltip ("Study: mic live / doorbell only / off")
 * and a small icon with a coloured dot (green live, amber doorbell only, grey off). The icon is drawn from raw
 * pixels, so it needs no image files and no canvas.
 */
import type { DeviceGateState, DeviceLevel } from './device-gate.js';

/** "the study" -> "Study". */
export function trayRoomName(placeName: string | null): string {
  const bare = (placeName ?? '').trim().replace(/^the\s+/i, '');
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : 'This room';
}

const WORDS: Record<DeviceLevel, string> = { live: 'mic live', doorbell: 'doorbell only', off: 'off' };

export function trayTooltip(placeName: string | null, state: Pick<DeviceGateState, 'mic'>): string {
  return `${trayRoomName(placeName)}: ${WORDS[state.mic]}`;
}

const DOT_COLORS: Record<DeviceLevel, [number, number, number]> = {
  live: [34, 197, 94],
  doorbell: [245, 158, 11],
  off: [148, 163, 184],
};

export interface IconBitmap {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Buffer;
}

/** A dark round badge with a coloured dot in the bottom right corner. */
export function stateIcon(level: DeviceLevel, size = 32): IconBitmap {
  const data = Buffer.alloc(size * size * 4);
  const [red, green, blue] = DOT_COLORS[level];
  const centre = (size - 1) / 2;
  const badge = size * 0.48;
  const dotX = size * 0.68;
  const dotY = size * 0.68;
  const dot = size * 0.24;
  const rim = size * 0.29;
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const at = (y * size + x) * 4;
    data[at] = r;
    data[at + 1] = g;
    data[at + 2] = b;
    data[at + 3] = 255;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const toDot = Math.hypot(x - dotX, y - dotY);
      if (toDot <= dot) put(x, y, red, green, blue);
      else if (toDot <= rim) put(x, y, 15, 23, 42);
      else if (Math.hypot(x - centre, y - centre) <= badge) put(x, y, 51, 65, 85);
    }
  }
  return { width: size, height: size, data };
}

/** Electron's `nativeImage.createFromBitmap` wants BGRA. */
export function toBgra(rgba: Buffer): Buffer {
  const out = Buffer.from(rgba);
  for (let at = 0; at + 3 < out.length; at += 4) {
    out[at] = rgba[at + 2];
    out[at + 2] = rgba[at];
  }
  return out;
}
