/**
 * Avatars that go to another place on their own (docs/features/places.md, "Wandering between places").
 *
 * Kevin's rules: an avatar may wander to another place when it is idle, at most once per 10 minutes, and only
 * if someone used that PC lately (or another avatar is there). This file is the one place those rules are
 * written down. The idle director asks it before it runs a `{room:}` tag, bija's `places:move` asks it again
 * for a move marked as wandering, and the next-door tick asks it before it brings an avatar back. Pure: no
 * Electron, no timers; the clock is in the snapshot.
 */
import type { PlacesSnapshot } from './place-manager.js';

/** An avatar that moved (for any reason) less than this long ago does not wander. */
export const WANDER_COOLDOWN_MS = 10 * 60_000;
/** Someone using a PC counts as "there" for this long. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;
/** Kevin talked with the avatar this recently: it stays. */
export const CONVERSATION_MS = 2 * 60_000;

/** Lowercase, hyphens and underscores as spaces, no "the", one space between words. */
export function normalisePlaceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The slice of a places snapshot the rules read. */
export type WanderView = Pick<PlacesSnapshot, 'places' | 'locations' | 'transit'> & Partial<Pick<PlacesSnapshot, 'now' | 'movedAt' | 'activeAt'>>;

/** The place a name or id means, among the snapshot's places. */
export function findPlace(view: Pick<WanderView, 'places'>, ref: string): WanderView['places'][number] | null {
  const wanted = normalisePlaceName(ref);
  if (!wanted) return null;
  return view.places.find((place) => normalisePlaceName(place.id) === wanted) ?? view.places.find((place) => normalisePlaceName(place.name) === wanted) ?? null;
}

/** Someone used the PC at this place in the last `windowMs`. */
export function activeWithin(view: WanderView, placeId: string, windowMs: number, now: number = view.now ?? Date.now()): boolean {
  const at = view.activeAt?.[placeId];
  return typeof at === 'number' && now - at <= windowMs;
}

/** Avatars (other than `exceptId`) standing at the place and not in transit. */
export function othersAt(view: WanderView, placeId: string, exceptId: string): string[] {
  const moving = new Set(view.transit.map((entry) => entry.avatarId));
  return Object.entries(view.locations)
    .filter(([avatarId, at]) => at === placeId && avatarId !== exceptId && !moving.has(avatarId))
    .map(([avatarId]) => avatarId);
}

export interface WanderContext {
  /** The avatar's voice is playing right now (only the screen that plays it knows). */
  speaking?: boolean;
  /** How long ago Kevin last spoke with this avatar; null when he has not lately. */
  talkedAgoMs?: number | null;
  now?: number;
}

/**
 * Why an avatar may not wander to `targetRef` right now, or null when it may. Rules (all must hold):
 * (a) it has not changed place in the last 10 minutes; (b) the target is online and open; (c) someone used the
 * target PC in the last 10 minutes, or another avatar is there; (d) it is not speaking and not in a conversation
 * (Kevin spoke with it in the last 2 minutes).
 */
export function wanderRefusal(view: WanderView, avatarId: string, targetRef: string, context: WanderContext = {}): string | null {
  const now = context.now ?? view.now ?? Date.now();
  const target = findPlace(view, targetRef);
  if (!target) return 'unknown place';
  if (view.transit.some((entry) => entry.avatarId === avatarId)) return 'already moving';
  if ((view.locations[avatarId] ?? view.places[0]?.id) === target.id) return 'already there';
  const movedAt = view.movedAt?.[avatarId];
  if (typeof movedAt === 'number' && now - movedAt < WANDER_COOLDOWN_MS) return 'moved recently';
  if (target.online === false || target.closed === true) return `${target.name} is closed`;
  if (!activeWithin(view, target.id, ACTIVE_WINDOW_MS, now) && othersAt(view, target.id, avatarId).length === 0) return 'nobody is there';
  if (context.speaking) return 'speaking';
  if (typeof context.talkedAgoMs === 'number' && context.talkedAgoMs < CONVERSATION_MS) return 'in conversation';
  return null;
}
