/**
 * How big a described piece is in real life, and what to call it. The helper model answers when there is
 * one; otherwise (or when its answer is unusable) a keyword table gives a sensible size.
 */
import { extractJson } from '../rooms/room-layout-llm.js';

export const MIN_DIMENSION = 0.05;
export const MAX_DIMENSION = 4;

export interface SizeEstimate {
  name: string;
  category: string;
  /** Metres. */
  width: number;
  depth: number;
  height: number;
}

/** Asks the helper model; null when there is none. */
export type AskHelper = (system: string, user: string) => Promise<string | null>;

export const SIZE_SYSTEM_PROMPT = [
  'You size furniture. The user describes one piece of furniture or decor.',
  'Reply with only a JSON object, no other text:',
  '{"name": "2-4 word name", "category": "one word such as seating, table, storage, lighting, bed, decor", "width_m": number, "depth_m": number, "height_m": number}',
  'The dimensions are the real-world size in metres of a typical piece matching the description: width left to right and depth front to back as seen from the front, height floor to top.',
].join('\n');

/** [words, category, width, depth, height]: the first row with a matching word wins, so specific rows come first. */
const FALLBACKS: Array<[string[], string, number, number, number]> = [
  [['armchair', 'recliner', 'accent chair'], 'seating', 0.85, 0.85, 0.95],
  [['sofa', 'couch', 'loveseat', 'settee'], 'seating', 2.0, 0.9, 0.85],
  [['stool'], 'seating', 0.4, 0.4, 0.65],
  [['bench'], 'seating', 1.2, 0.4, 0.45],
  [['chair'], 'seating', 0.5, 0.55, 0.9],
  [['table lamp', 'desk lamp'], 'lighting', 0.3, 0.3, 0.5],
  [['lamp', 'floor lamp'], 'lighting', 0.4, 0.4, 1.6],
  [['coffee table'], 'table', 1.1, 0.6, 0.45],
  [['side table', 'end table', 'nightstand', 'bedside table'], 'table', 0.45, 0.4, 0.55],
  [['dining table'], 'table', 1.6, 0.9, 0.75],
  [['desk'], 'table', 1.3, 0.65, 0.75],
  [['table'], 'table', 1.2, 0.8, 0.75],
  [['bookshelf', 'bookcase', 'shelf', 'shelving'], 'storage', 0.8, 0.35, 1.8],
  [['wardrobe', 'armoire'], 'storage', 1.0, 0.55, 2.0],
  [['dresser', 'chest of drawers'], 'storage', 1.2, 0.5, 0.85],
  [['cabinet', 'cupboard', 'sideboard'], 'storage', 1.0, 0.45, 0.85],
  [['tv stand', 'media console'], 'storage', 1.4, 0.4, 0.5],
  [['bed'], 'bed', 1.6, 2.0, 0.5],
  [['plant', 'palm', 'fern'], 'decor', 0.4, 0.4, 1.0],
  [['mirror'], 'decor', 0.6, 0.05, 1.6],
];
const DEFAULT_FALLBACK = ['furniture', 0.6, 0.6, 0.8] as const;

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A name from the first words of the prompt, for a piece whose helper answer is missing. */
function nameFromPrompt(prompt: string): string {
  // The first clause without a leading article: "A standing desk, with a monitor" -> "Standing desk".
  const clause = prompt.trim().split(/[,.;:!?]/)[0].replace(/^(an?|the)\s+/i, '');
  const words = clause.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : 'Furniture';
}

/** The keyword table's answer: always usable. */
export function fallbackEstimate(prompt: string): SizeEstimate {
  const text = prompt.toLowerCase();
  const row = FALLBACKS.find(([words]) => words.some((word) => new RegExp(`\\b${escape(word)}s?\\b`).test(text)));
  const [category, width, depth, height] = row ? row.slice(1) as [string, number, number, number] : DEFAULT_FALLBACK;
  return { name: nameFromPrompt(prompt), category, width, depth, height };
}

function dimension(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= MIN_DIMENSION && n <= MAX_DIMENSION ? n : null;
}

/**
 * The helper's reply as an estimate, or null when it is no usable answer. Sizes are all or nothing (a
 * half-right size is worse than the table's); a missing name or category falls back on its own.
 */
export function parseSizeEstimate(reply: string, prompt: string): SizeEstimate | null {
  let data: unknown;
  try {
    data = extractJson(reply);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const width = dimension(record.width_m);
  const depth = dimension(record.depth_m);
  const height = dimension(record.height_m);
  if (width === null || depth === null || height === null) return null;
  const fallback = fallbackEstimate(prompt);
  const name = typeof record.name === 'string' ? record.name.trim().split(/\s+/).slice(0, 4).join(' ').slice(0, 40) : '';
  const category = typeof record.category === 'string' ? record.category.trim().toLowerCase() : '';
  return {
    name: name || fallback.name,
    category: /^[a-z][a-z -]{0,23}$/.test(category) ? category : fallback.category,
    width,
    depth,
    height,
  };
}

/** The helper's estimate, or the table's when there is no helper, it fails, or its answer is unusable. Aborts still throw. */
export async function estimateFurniture(
  prompt: string,
  ask: AskHelper | undefined,
  signal?: AbortSignal,
  warn?: (message: string, details: Record<string, unknown>) => void,
): Promise<SizeEstimate> {
  if (ask) {
    try {
      const reply = await ask(SIZE_SYSTEM_PROMPT, prompt);
      const parsed = reply ? parseSizeEstimate(reply, prompt) : null;
      if (parsed) return parsed;
      // Logged so a silent fallback (wrong size, clumsy name) can be traced to the helper.
      warn?.('Furniture size helper gave no usable answer; using the keyword table.', { reply: reply?.slice(0, 300) ?? null });
    } catch (error) {
      if (signal?.aborted) throw error;
      warn?.('Furniture size helper failed; using the keyword table.', { message: error instanceof Error ? error.message : String(error) });
    }
  } else {
    warn?.('No helper model for furniture sizes (Models and servers: describe); using the keyword table.', {});
  }
  return fallbackEstimate(prompt);
}
