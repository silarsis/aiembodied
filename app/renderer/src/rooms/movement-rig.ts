/**
 * Per-avatar movement bookkeeping (docs/features/multi-avatar-movement.md, phase A).
 *
 * Phase A only needs to know which avatar a live-motion stream belongs to, so its chunks play on
 * that avatar's actor, and to keep one repeat filter per avatar. Phase B adds a scene executor and
 * a room env per avatar here (`MovementRig`); the seam is next to `filters` below.
 */
import { MoveRequestFilter } from '../avatar/live-motion.js';

/** Streams that never end cleanly (a lost connection) must not pile up. */
export const MAX_TRACKED_STREAMS = 64;

export class MovementRigs {
  private readonly streams = new Map<string, string>();
  // Phase B adds per-avatar executors and room envs next to this map.
  private readonly filters = new Map<string, MoveRequestFilter>();

  /** `{move:}` repeat filter for this avatar (made on first use), so two avatars may wave in the same breath. */
  filterFor(avatarId: string): MoveRequestFilter {
    let filter = this.filters.get(avatarId);
    if (!filter) {
      filter = new MoveRequestFilter();
      this.filters.set(avatarId, filter);
    }
    return filter;
  }

  registerStream(streamId: string, avatarId: string): void {
    this.streams.delete(streamId);
    this.streams.set(streamId, avatarId);
    while (this.streams.size > MAX_TRACKED_STREAMS) {
      const oldest = this.streams.keys().next().value;
      if (oldest === undefined) break;
      this.streams.delete(oldest);
    }
  }

  avatarForStream(streamId: string): string | undefined {
    return this.streams.get(streamId);
  }

  /** The stream ended or failed; chunks of it have all been delivered (the request resolves after the last). */
  endStream(streamId: string): void {
    this.streams.delete(streamId);
  }

  /** Stream ids still running, for barge-in. */
  streamIds(): string[] {
    return [...this.streams.keys()];
  }

  /** Forget everything about an avatar (it was removed). */
  drop(avatarId: string): void {
    this.filters.delete(avatarId);
    for (const [streamId, owner] of this.streams) {
      if (owner === avatarId) this.streams.delete(streamId);
    }
  }
}
