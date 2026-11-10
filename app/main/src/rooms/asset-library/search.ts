/**
 * Local search over a model catalog. No embedder: tokens of the object's search words, name and
 * category are scored against the entry's name, tags and categories (exact, plural/stem and a small
 * synonym table), and the entry's categories must suit the object's category.
 */
import type { ObjectCategory } from '../room-layout.js';
import type { CatalogEntry } from './types.js';

export interface SearchQuery {
  search: string;
  name: string;
  category: ObjectCategory;
}
export interface SearchResult {
  entry: CatalogEntry;
  score: number;
}

export const MATCH_THRESHOLD = 2.0;

const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'for', 'old', 'new', 'small', 'large', 'big', 'little', 'modern', 'simple', 'wooden', 'wood']);
const GROUPS: string[][] = [
  ['sofa', 'couch', 'settee', 'loveseat', 'sectional'],
  ['armchair', 'chair', 'recliner', 'lounger'],
  ['chair', 'stool'],
  ['table', 'desk'],
  ['bookshelf', 'bookcase', 'shelf', 'shelves', 'bookshelves', 'shelving'],
  ['wardrobe', 'cabinet', 'closet', 'cupboard', 'dresser', 'sideboard', 'drawer', 'drawers'],
  ['lamp', 'light', 'lantern', 'sconce'],
  ['tv', 'television', 'monitor'],
  ['plant', 'houseplant', 'potted', 'fern', 'succulent', 'cactus', 'flower', 'flowers'],
  ['mug', 'cup', 'teacup'],
  ['bed', 'mattress', 'bunk'],
  ['rug', 'carpet', 'mat'],
  ['fridge', 'refrigerator'],
  ['painting', 'picture', 'frame', 'artwork', 'poster'],
  ['vase', 'jar', 'pot', 'planter'],
  ['book', 'books', 'notebook'],
  ['clock', 'watch'],
  ['bin', 'trash', 'wastebasket', 'basket'],
  ['sink', 'basin'],
  ['stove', 'cooker', 'oven'],
];
const SYNONYMS = new Map<string, Set<string>>();
for (const group of GROUPS)
  for (const word of group) {
    const set = SYNONYMS.get(word) ?? new Set<string>();
    for (const other of group) if (other !== word) set.add(other);
    SYNONYMS.set(word, set);
  }

/** Words in an entry's categories or tags that make it a plausible item of an object category. */
const COMPATIBLE: Partial<Record<ObjectCategory, string[]>> = {
  seat: ['furniture', 'seating', 'chair', 'chairs', 'sofa', 'couch', 'stool', 'bench', 'armchair', 'seat'],
  table: ['furniture', 'table', 'tables', 'desk', 'counter', 'surface'],
  storage: ['furniture', 'storage', 'shelf', 'shelves', 'bookshelf', 'cabinet', 'drawer', 'wardrobe', 'dresser', 'cupboard', 'sideboard', 'closet'],
  bed: ['furniture', 'bed', 'beds', 'bedroom', 'mattress', 'sleeping'],
  lamp: ['lighting', 'lamp', 'lamps', 'light', 'lights', 'furniture', 'decor', 'decorative'],
  plant: ['plant', 'plants', 'nature', 'vegetation', 'flower', 'flowers', 'tree', 'potted', 'houseplant', 'decor', 'decorative'],
  appliance: ['appliance', 'appliances', 'electronics', 'kitchen', 'household', 'tv', 'television', 'fridge', 'device', 'furniture'],
};

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 1 && !STOP.has(word));
}

function matchFactor(query: string, candidate: string): number {
  if (query === candidate) return 1;
  const a = singular(query);
  const b = singular(candidate);
  if (a === b) return 0.9;
  if (SYNONYMS.get(a)?.has(b) || SYNONYMS.get(query)?.has(candidate)) return 0.8;
  return 0;
}

function compatible(entry: CatalogEntry, category: ObjectCategory): boolean {
  const allowed = COMPATIBLE[category];
  if (!allowed) return true;
  const words = new Set([...entry.categories, ...entry.tags, entry.name].flatMap(tokens).map(singular));
  return allowed.some((word) => words.has(singular(word)));
}

export function scoreEntry(entry: CatalogEntry, query: SearchQuery): number {
  const queryTokens = [...new Set([...tokens(query.search), ...tokens(query.name)])];
  if (queryTokens.length === 0) return 0;
  const nameTokens = tokens(`${entry.name} ${entry.id}`);
  const tagTokens = entry.tags.flatMap(tokens);
  const categoryTokens = entry.categories.flatMap(tokens);
  let score = 0;
  for (const word of queryTokens) {
    let best = 0;
    for (const candidate of nameTokens) best = Math.max(best, 3 * matchFactor(word, candidate));
    for (const candidate of tagTokens) best = Math.max(best, 2 * matchFactor(word, candidate));
    for (const candidate of categoryTokens) best = Math.max(best, 1 * matchFactor(word, candidate));
    score += best;
  }
  // Prefer the more specific entry: a few unmatched name words cost a little.
  const unmatched = new Set(nameTokens).size;
  return score - 0.05 * unmatched;
}

/** The best entry above the threshold, or null. Ties go to the shorter name, then the id. */
export function findBestModel(catalog: CatalogEntry[], query: SearchQuery): SearchResult | null {
  let best: SearchResult | null = null;
  for (const entry of catalog) {
    if (!compatible(entry, query.category)) continue;
    const score = scoreEntry(entry, query);
    if (score < MATCH_THRESHOLD) continue;
    if (
      !best ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && entry.id < best.entry.id)
    )
      best = { entry, score };
  }
  return best;
}
