/** The renderer's bridge to places: who is where, and moving avatars between places. Types only. */
import type { Place, PlacesSnapshot } from './place-manager.js';
import type { CallResult } from './summon.js';

export type { Place, PlacesSnapshot, CallResult };

export interface PlaceMoveResult {
  ok: boolean;
  /** Why a move did not start ('unknown place', 'already there', ...). */
  reason?: string;
}

export interface PlacesBridge {
  snapshot(): Promise<PlacesSnapshot>;
  /** Pushed on every change: someone left, arrived, or a place was renamed. Returns the unsubscribe function. */
  onChanged(listener: (snapshot: PlacesSnapshot) => void): () => void;
  /**
   * An avatar walks to another place. `placeRef` is a place id or name ("next door", "the lounge").
   * The renderer calls this when an avatar's `{room:}` exit walk is done, and from the Call button (reason 'called').
   */
  move(avatarId: string, placeRef: string, reason?: 'called' | 'chose to' | 'wandered'): Promise<PlaceMoveResult>;
  /** The avatar's body is loaded and standing at the door of this PC's place. */
  arrived(avatarId: string): Promise<void>;
  /**
   * Nobody is in this room and Kevin pressed the talk key (or tapped): call someone over. bija picks the avatar
   * Kevin last talked with, else Echo, else the first one, and says who is coming. It does not wait for the walk.
   */
  summon?(): Promise<CallResult>;
  /**
   * The idle director asks before it lets an avatar walk to another place on its own: has it moved in the last 10
   * minutes, is the place open, was someone there lately, is it talking? Answered by bija with fresh data
   * (`places/wander.ts`). `speaking` is what only the screen knows.
   */
  canWander?(avatarId: string, placeRef: string, speaking?: boolean): Promise<PlaceMoveResult>;
}
