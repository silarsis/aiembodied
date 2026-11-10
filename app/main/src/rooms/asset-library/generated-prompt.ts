/**
 * The picture a missing room object is made from: one product-photo style image of the object on
 * plain white, which the image-to-3D model then turns into a mesh. Pure, so it is unit tested.
 */
import type { LayoutObject } from '../room-layout.js';

const MATERIAL_WORDS = new Set([
  'wooden', 'wood', 'oak', 'walnut', 'pine', 'teak', 'bamboo', 'rattan', 'wicker', 'metal', 'steel', 'iron', 'brass', 'copper', 'chrome',
  'leather', 'fabric', 'velvet', 'linen', 'cotton', 'wool', 'glass', 'ceramic', 'porcelain', 'marble', 'stone', 'concrete', 'plastic',
  'rubber', 'paper', 'woven', 'upholstered', 'padded',
]);
const COLOUR_WORDS = new Set([
  'white', 'cream', 'ivory', 'beige', 'tan', 'grey', 'gray', 'silver', 'black', 'brown', 'red', 'burgundy', 'pink', 'orange', 'rust',
  'terracotta', 'yellow', 'mustard', 'gold', 'green', 'olive', 'sage', 'teal', 'turquoise', 'blue', 'navy', 'purple', 'lavender',
]);

/** A plain colour word for a hex colour (#rgb or #rrggbb), or null when it is not one. */
export function colourWordForHex(hex: string): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta < 0.08) return lightness > 0.85 ? 'white' : lightness < 0.2 ? 'black' : 'grey';
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let word: string;
  if (hue < 15 || hue >= 345) word = 'red';
  else if (hue < 40) word = lightness < 0.45 && saturation < 0.8 ? 'brown' : 'orange';
  else if (hue < 65) word = lightness < 0.4 ? 'brown' : 'yellow';
  else if (hue < 165) word = 'green';
  else if (hue < 200) word = 'teal';
  else if (hue < 260) word = 'blue';
  else if (hue < 300) word = 'purple';
  else word = 'pink';
  return lightness > 0.75 && word !== 'white' ? `light ${word}` : lightness < 0.25 ? `dark ${word}` : word;
}

/** Colour and material words for the object: those in its search words, then its colour (a word or a hex). */
export function appearanceWords(object: Pick<LayoutObject, 'search' | 'name' | 'color'>): string[] {
  const words: string[] = [];
  const add = (word: string | null) => {
    if (word && !words.includes(word)) words.push(word);
  };
  const color = object.color?.trim() ?? '';
  if (color) add(colourWordForHex(color) ?? (/^#/.test(color) ? null : color.toLowerCase().slice(0, 40)));
  const wordsOf = `${object.search} ${object.name}`.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const word of wordsOf) if (COLOUR_WORDS.has(word)) add(word);
  for (const word of wordsOf) if (MATERIAL_WORDS.has(word)) add(word);
  return words.slice(0, 4);
}

/** What to draw, in the framing the 3D step works best with: one object, plain white, seen from the front. */
export function buildObjectImagePrompt(object: Pick<LayoutObject, 'search' | 'name' | 'category' | 'color'>): string {
  const name = object.name.trim().toLowerCase();
  const nameWords = name.split(/[^a-z]+/);
  const extra = object.search
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 1 && !nameWords.includes(word) && !COLOUR_WORDS.has(word) && !MATERIAL_WORDS.has(word));
  const subject = extra.length ? `${name}, ${[...new Set(extra)].slice(0, 3).join(' ')}` : name;
  const look = appearanceWords(object);
  return [
    `a single ${subject}`,
    look.length ? look.join(', ') : null,
    'product photo',
    'isolated on plain white background',
    'full object in frame',
    'straight-on front view',
    'no people',
    'no text',
  ]
    .filter(Boolean)
    .join(', ');
}

export const OBJECT_IMAGE_NEGATIVE =
  'person, people, hands, room, scenery, floor shadow, multiple objects, cropped, cut off, partial object, text, watermark, logo, blurry';
