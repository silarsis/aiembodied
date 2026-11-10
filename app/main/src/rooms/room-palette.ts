/**
 * Plain colour words (what the layout model writes) to hex, and the lighting presets. Pure.
 */
import type { RoomLight } from './types.js';

const WORDS: Record<string, string> = {
  white: '#f2f0ea', 'off white': '#ece8dc', cream: '#e8dfc8', ivory: '#efe8d4', beige: '#d6c6a5', sand: '#d8c49a', tan: '#c4a57b',
  grey: '#9a9a9a', gray: '#9a9a9a', 'light grey': '#c4c4c4', 'light gray': '#c4c4c4', 'dark grey': '#555555', 'dark gray': '#555555',
  charcoal: '#3a3a3e', black: '#222222', silver: '#bfc3c7',
  brown: '#7a5233', 'dark brown': '#4b3220', 'light brown': '#a67c52', chocolate: '#4a2f1d', walnut: '#5c3d28', mahogany: '#4e2a1e',
  oak: '#b08a5a', 'warm oak': '#a87b4d', 'light oak': '#c9a672', pine: '#c8a56a', wood: '#9a7248', wooden: '#9a7248', bamboo: '#c9b26f', teak: '#8a5a33',
  red: '#a8372f', crimson: '#8f2430', burgundy: '#6e2233', maroon: '#6a2430', pink: '#e0a1b4', rose: '#d98aa0', salmon: '#e8907c',
  orange: '#d9772b', rust: '#a4502a', terracotta: '#b9593b', coral: '#e5775f', peach: '#f0c0a0',
  yellow: '#e6c744', mustard: '#c9a227', gold: '#c8a24a', lemon: '#f0e07a',
  green: '#4f8a52', 'dark green': '#2f5a3a', 'forest green': '#2f5a3a', olive: '#7a8040', sage: '#9fb095', mint: '#a8d8c0', 'light green': '#9cc88f', emerald: '#2a7d5a',
  teal: '#2f7f82', turquoise: '#40b0b0', cyan: '#5cc0d0', aqua: '#7fd0d0',
  blue: '#3c6cb0', 'light blue': '#9cc0e4', 'sky blue': '#8cc4ec', 'dark blue': '#233a66', navy: '#1f2f56', 'baby blue': '#b6d4ee', denim: '#3f5f8a',
  purple: '#7a4f9a', violet: '#7a58b0', lavender: '#b8a8d8', lilac: '#c8b0d8', plum: '#6a3a5a', mauve: '#a07890',
  'soft cream': '#eadfc6', 'warm white': '#f0e6d2', 'soft grey': '#b8b8b8', 'soft blue': '#a8c4e0', 'soft green': '#a8c8a0', 'soft pink': '#ecc4cc', 'pale yellow': '#f2e6a8',
  concrete: '#8d8d8a', stone: '#9a968c', marble: '#e4e2dc', brick: '#9a4a38', slate: '#5a6068', copper: '#b4693c', bronze: '#8a6a3a', brass: '#b89c4a', chrome: '#c8ccd0',
  terracota: '#b9593b', linen: '#e4dcc8', leather: '#6e4630', 'tan leather': '#a06f45',
};

export const DEFAULT_COLOR = '#b8b0a4';

/** A hex colour (#rgb or #rrggbb) as typed, or the colour a word stands for; `fallback` when it is neither. */
export function resolveColor(word: unknown, fallback: string = DEFAULT_COLOR): string {
  if (typeof word !== 'string') return fallback;
  const text = word.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(text)) return text;
  if (WORDS[text]) return WORDS[text];
  // "warm oak" style: try the last word, then any known word inside.
  const parts = text.split(/[\s-]+/).filter(Boolean);
  for (let length = parts.length; length >= 1; length -= 1) {
    for (let start = 0; start + length <= parts.length; start += 1) {
      const found = WORDS[parts.slice(start, start + length).join(' ')];
      if (found) return found;
    }
  }
  return fallback;
}

/** Multiplies each channel; used for the darker/lighter shades of a part. */
export function shade(hex: string, factor: number): string {
  const clean = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const channels = [1, 3, 5].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(i, i + 2), 16) * factor))));
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

export const LIGHTING_PRESETS = ['warm evening', 'bright day', 'soft morning', 'cool night', 'neutral'] as const;
export type LightingPreset = (typeof LIGHTING_PRESETS)[number];

interface PresetSpec {
  outside: string;
  ceiling: string;
  hemi: [string, string, number];
  sun: [string, number, [number, number, number]];
  lamp: [string, number];
}
const PRESETS: Record<LightingPreset, PresetSpec> = {
  'warm evening': { outside: '#e9a86a', ceiling: '#efe9dd', hemi: ['#fff4e0', '#7a5c3e', 0.9], sun: ['#ffd7a0', 1.0, [-1.5, 2.6, 2.0]], lamp: ['#ffcf8a', 3] },
  'bright day': { outside: '#a9cdea', ceiling: '#f4f1ea', hemi: ['#ffffff', '#8a8a80', 1.2], sun: ['#fff8ea', 1.5, [1.5, 2.6, 2.0]], lamp: ['#fff2d8', 1] },
  'soft morning': { outside: '#c8dcea', ceiling: '#f0ede6', hemi: ['#f4f6ff', '#8a8478', 1.0], sun: ['#ffeccc', 1.0, [2.0, 2.4, 1.0]], lamp: ['#ffe8c0', 1.2] },
  'cool night': { outside: '#1e2b4a', ceiling: '#d8dae0', hemi: ['#a8b8e0', '#30343c', 0.6], sun: ['#9ab0e8', 0.5, [-1.0, 2.6, 2.0]], lamp: ['#ffd9a0', 3.5] },
  neutral: { outside: '#a9cdea', ceiling: '#efede8', hemi: ['#ffffff', '#808078', 1.0], sun: ['#ffffff', 1.0, [0, 2.6, 2.0]], lamp: ['#fff0dc', 1.5] },
};

export function lightingOutside(preset: LightingPreset): string {
  return PRESETS[preset].outside;
}
export function lightingCeiling(preset: LightingPreset): string {
  return PRESETS[preset].ceiling;
}

/** Hemisphere + sun + one point light (placed by the caller near a lamp or the centre). */
export function lightsFor(preset: LightingPreset, height: number, lampPosition: [number, number, number]): RoomLight[] {
  const spec = PRESETS[preset];
  return [
    { type: 'hemisphere', color: spec.hemi[0], groundColor: spec.hemi[1], intensity: spec.hemi[2] },
    { type: 'directional', color: spec.sun[0], intensity: spec.sun[1], position: spec.sun[2] },
    { type: 'point', color: spec.lamp[0], intensity: spec.lamp[1], position: [lampPosition[0], Math.min(lampPosition[1], height - 0.3), lampPosition[2]] },
  ];
}
