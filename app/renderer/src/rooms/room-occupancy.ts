/**
 * Who stands, sits and carries what in a room (docs/features/multi-avatar-movement.md, phase C).
 * Pure bookkeeping, no WebGL: spots (where each avatar stands and the goal it is walking to),
 * seat and object claims, and a first-in-first-out mutex so only one avatar walks at a time.
 * One lives in each RoomSceneController.
 */

export interface Spot {
  x: number;
  z: number;
}

export interface OtherAvatar {
  id: string;
  x: number;
  z: number;
  goal?: Spot;
}

export type ClaimKind = 'seat' | 'object';

/** An avatar's own view of the occupancy: every call is already bound to its id. */
export interface AvatarOccupancy {
  freeSpotNear(wanted: Spot, closestWalkable: (p: Spot) => Spot, radius?: number, maxShift?: number): Spot | null;
  claimSpot(spot: Spot): void;
  releaseSpot(): void;
  standing(spot: Spot): void;
  claim(kind: ClaimKind, id: string): boolean;
  release(kind: ClaimKind, id: string): void;
  /** Id of the avatar holding the claim, if any. */
  holder(kind: ClaimKind, id: string): string | null;
  /** Releases this avatar's seat and object claims except the ones it still keeps. */
  keepOnly(keep: { seat?: string; object?: string }): void;
  /** Display name of an avatar (its id when no name is known). */
  nameOf(avatarId: string): string;
  acquireWalk(timeoutMs?: number): Promise<() => void>;
  /** Drops this avatar's place in the walking queue (it was interrupted) without touching its claims. */
  cancelWalk(): void;
  releaseAll(): void;
}

export const SPOT_RADIUS = 0.45;
export const MAX_SHIFT = 1;
export const WALK_TIMEOUT_MS = 15000;
const RING_DIRECTIONS = 8;

interface Waiter {
  avatarId: string;
  resolve: (release: () => void) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const noop = (): void => undefined;

export class RoomOccupancy {
  private readonly stands = new Map<string, Spot>();
  private readonly goals = new Map<string, Spot>();
  private readonly claims = new Map<string, string>();
  private walker: { avatarId: string; token: object } | null = null;
  private waiters: Waiter[] = [];
  private names: Record<string, string> = {};

  /** Display names by avatar id, for the reasons the model reads ("Sage is sitting on the sofa"). */
  setNames(names: Record<string, string>): void {
    this.names = { ...names };
  }

  nameOf(avatarId: string): string {
    return this.names[avatarId]?.trim() || avatarId;
  }

  // -- Spots ----------------------------------------------------------------------------------

  claimSpot(avatarId: string, spot: Spot): void {
    this.goals.set(avatarId, { x: spot.x, z: spot.z });
  }

  releaseSpot(avatarId: string): void {
    this.goals.delete(avatarId);
  }

  standing(avatarId: string, spot: Spot): void {
    this.stands.set(avatarId, { x: spot.x, z: spot.z });
  }

  others(avatarId: string): OtherAvatar[] {
    const ids = new Set([...this.stands.keys(), ...this.goals.keys()]);
    ids.delete(avatarId);
    const result: OtherAvatar[] = [];
    for (const id of ids) {
      const goal = this.goals.get(id);
      const stand = this.stands.get(id) ?? goal;
      if (!stand) continue;
      result.push({ id, x: stand.x, z: stand.z, ...(goal ? { goal: { ...goal } } : {}) });
    }
    return result;
  }

  private spotFree(avatarId: string, spot: Spot, radius: number): boolean {
    for (const other of this.others(avatarId)) {
      if (Math.hypot(other.x - spot.x, other.z - spot.z) < radius) return false;
      if (other.goal && Math.hypot(other.goal.x - spot.x, other.goal.z - spot.z) < radius) return false;
    }
    return true;
  }

  /**
   * `wanted` when nobody else stands or is heading within `radius` of it; else the nearest free point
   * on rings around it (8 directions at half the maximum shift and at the maximum, each snapped with
   * `closestWalkable` and checked again); null when there is none.
   */
  freeSpotNear(
    avatarId: string,
    wanted: Spot,
    closestWalkable: (p: Spot) => Spot,
    radius = SPOT_RADIUS,
    maxShift = MAX_SHIFT,
  ): Spot | null {
    if (this.spotFree(avatarId, wanted, radius)) return wanted;
    let best: { spot: Spot; distance: number } | null = null;
    for (const ring of [maxShift / 2, maxShift]) {
      for (let i = 0; i < RING_DIRECTIONS; i += 1) {
        const angle = (i * 2 * Math.PI) / RING_DIRECTIONS;
        const snapped = closestWalkable({ x: wanted.x + ring * Math.cos(angle), z: wanted.z + ring * Math.sin(angle) });
        const distance = Math.hypot(snapped.x - wanted.x, snapped.z - wanted.z);
        if (distance > maxShift + 1e-6) continue;
        if (!this.spotFree(avatarId, snapped, radius)) continue;
        if (!best || distance < best.distance - 1e-9) best = { spot: snapped, distance };
      }
    }
    return best ? best.spot : null;
  }

  // -- Seats and objects ----------------------------------------------------------------------

  private key(kind: ClaimKind, id: string): string {
    return `${kind}:${id}`;
  }

  /** False when another avatar holds it; true when it is free or already this avatar's. */
  claim(kind: ClaimKind, id: string, avatarId: string): boolean {
    const key = this.key(kind, id);
    const holder = this.claims.get(key);
    if (holder && holder !== avatarId) return false;
    this.claims.set(key, avatarId);
    return true;
  }

  release(kind: ClaimKind, id: string, avatarId: string): void {
    const key = this.key(kind, id);
    if (this.claims.get(key) === avatarId) this.claims.delete(key);
  }

  holder(kind: ClaimKind, id: string): string | null {
    return this.claims.get(this.key(kind, id)) ?? null;
  }

  /** Releases the avatar's seat and object claims except `keep`. */
  keepOnly(avatarId: string, keep: { seat?: string; object?: string }): void {
    for (const [key, holder] of [...this.claims]) {
      if (holder !== avatarId) continue;
      const [kind, ...rest] = key.split(':');
      const id = rest.join(':');
      if (kind === 'seat' && id === keep.seat) continue;
      if (kind === 'object' && id === keep.object) continue;
      this.claims.delete(key);
    }
  }

  // -- Walking mutex --------------------------------------------------------------------------

  /**
   * Resolves with a release function once this avatar may walk. At once when nobody walks or this
   * avatar already holds it (that release does nothing); else in turn. After `timeoutMs` it resolves
   * anyway with a release that does nothing, so a stuck walker cannot freeze the others.
   */
  acquireWalk(avatarId: string, timeoutMs = WALK_TIMEOUT_MS): Promise<() => void> {
    if (!this.walker) return Promise.resolve(this.take(avatarId));
    if (this.walker.avatarId === avatarId) return Promise.resolve(noop);
    return new Promise((resolve) => {
      const waiter: Waiter = { avatarId, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        resolve(noop);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Drops the avatar's place in the queue (its waiting acquire resolves with a no-op release). */
  cancelWalk(avatarId: string): void {
    for (const waiter of this.waiters.filter((entry) => entry.avatarId === avatarId)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(noop);
    }
    this.waiters = this.waiters.filter((entry) => entry.avatarId !== avatarId);
  }

  private take(avatarId: string): () => void {
    const token = {};
    this.walker = { avatarId, token };
    return () => {
      if (this.walker?.token !== token) return;
      this.walker = null;
      this.next();
    };
  }

  private next(): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(this.take(waiter.avatarId));
  }

  // -- Everything -----------------------------------------------------------------------------

  /** The avatar is leaving, reset or interrupted for good: its goal, claims, walk and queue place all go. */
  releaseAll(avatarId: string): void {
    this.goals.delete(avatarId);
    this.keepOnly(avatarId, {});
    this.cancelWalk(avatarId);
    if (this.walker?.avatarId === avatarId) {
      this.walker = null;
      this.next();
    }
  }

  /** Forgets the avatar completely, including where it stands. */
  forget(avatarId: string): void {
    this.releaseAll(avatarId);
    this.stands.delete(avatarId);
  }

  /** The room changed: nothing is claimed or standing any more. */
  clear(): void {
    this.stands.clear();
    this.goals.clear();
    this.claims.clear();
    this.walker = null;
    for (const waiter of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(noop);
    }
    this.waiters = [];
  }

  /** The handle one avatar's planner and executor use. */
  forAvatar(avatarId: string): AvatarOccupancy {
    return {
      freeSpotNear: (wanted, closestWalkable, radius, maxShift) =>
        this.freeSpotNear(avatarId, wanted, closestWalkable, radius, maxShift),
      claimSpot: (spot) => this.claimSpot(avatarId, spot),
      releaseSpot: () => this.releaseSpot(avatarId),
      standing: (spot) => this.standing(avatarId, spot),
      claim: (kind, id) => this.claim(kind, id, avatarId),
      release: (kind, id) => this.release(kind, id, avatarId),
      holder: (kind, id) => this.holder(kind, id),
      keepOnly: (keep) => this.keepOnly(avatarId, keep),
      nameOf: (id) => this.nameOf(id),
      acquireWalk: (timeoutMs) => this.acquireWalk(avatarId, timeoutMs),
      cancelWalk: () => this.cancelWalk(avatarId),
      releaseAll: () => this.releaseAll(avatarId),
    };
  }
}
