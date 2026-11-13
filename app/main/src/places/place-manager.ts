/**
 * Places: where each avatar is. Every screen shows one place. bija runs the whole app, so it keeps the
 * truth for every avatar (`avatars.locations`). Today there are two places: `home` (the room drawn on
 * this PC) and `next-door` (an offscreen place avatars can go to). Places drawn by another PC come later;
 * their `node` is that PC's device id.
 *
 * Pure: no Electron. The store, clock, timers and bus come in from outside so the tests can fake them.
 *
 * A move has two phases so the screen that will show the avatar can confirm it:
 * 1. `startMove` puts the avatar in transit. It is present nowhere (the hallway).
 * 2. The avatar arrives. At an offscreen place that happens by itself after `HALLWAY_MS`. At a place
 *    drawn here, the renderer calls `arrived` once the body is loaded and standing at the door.
 * If nothing confirms the arrival within `MOVE_DEADLINE_MS` the move fails and the avatar is back where it
 * was. The stored location only changes on arrival, so a crash in the hallway leaves the avatar at its old place.
 */
import { EventEmitter } from 'node:events';
import type { AvatarProfile } from '../avatars/avatar-registry.js';
import type { SwitchboardBus } from '../switchboard/bus.js';
import type { SwitchboardEventInput } from '../switchboard/types.js';

export const PLACES_KEY = 'places.list';
export const LOCATIONS_KEY = 'avatars.locations';
export const HOME_PLACE_ID = 'home';
export const NEXT_DOOR_PLACE_ID = 'next-door';
/** How long an avatar spends in the hallway on its way to an offscreen place. */
export const HALLWAY_MS = 1500;
/** A move that is not confirmed by then fails, and the avatar goes back. */
export const MOVE_DEADLINE_MS = 10_000;
/** How long avatars stay at a desktop room that went offline before they are sent home. */
export const OFFLINE_GRACE_MS = 60_000;

export interface Place {
  id: string;
  name: string;
  /** 'local' is the screen of this PC, 'offscreen' a place nobody draws, anything else is the device id of the PC that draws it. */
  node: 'local' | 'offscreen' | string;
  /** Only on desktop rooms (a device id as `node`): whether that PC is connected. Absent means always online. */
  online?: boolean;
  /**
   * Only on desktop rooms: the room that PC draws. A 3D room id (`room:builtin:studio-flat`, `room:<id>`) or a
   * 2D background id. The local place shows whatever the stage is set to, so it has none.
   */
  room?: string;
}

/** A new desktop room starts in the built-in Studio flat. */
export const DEFAULT_DESKTOP_ROOM = 'room:builtin:studio-flat';

const BUILT_IN_PLACES: Place[] = [
  { id: HOME_PLACE_ID, name: 'the lounge', node: 'local' },
  { id: NEXT_DOOR_PLACE_ID, name: 'next door', node: 'offscreen' },
];

export interface PlaceMove {
  avatarId: string;
  from: string;
  to: string;
  /** Why it moves ('summoned', 'called', 'chose to', ...). Journaled, never shown to a model. */
  reason: string;
  txn: string;
  startedAt: number;
}

export type StartMoveResult = { ok: true; state: PlaceMove } | { ok: false; reason: string };

export interface PlacesSnapshot {
  places: Place[];
  /** The place of every avatar in the registry (its last place while it is in transit). */
  locations: Record<string, string>;
  transit: Array<{ avatarId: string; from: string; to: string }>;
  localPlaceId: string;
}

export interface PlaceStore {
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
}

export interface PlaceManagerOptions {
  store: PlaceStore;
  registry: { list(): AvatarProfile[] };
  bus?: () => SwitchboardBus | null;
  now?: () => number;
  hallwayMs?: number;
  deadlineMs?: number;
  graceMs?: number;
  logger?: Pick<Console, 'warn' | 'debug'>;
}

/** Lowercase, hyphens and underscores as spaces, no "the", one space between words. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePlaces(raw: string | null): Place[] {
  let stored: unknown = null;
  if (raw) {
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
  }
  const byId = new Map<string, Place>();
  if (Array.isArray(stored)) {
    for (const item of stored) {
      if (!item || typeof item !== 'object') continue;
      const { id, name, node, room } = item as Record<string, unknown>;
      if (typeof id !== 'string' || !id || byId.has(id)) continue;
      const builtIn = BUILT_IN_PLACES.find((place) => place.id === id);
      byId.set(id, {
        id,
        name: typeof name === 'string' && name.trim() ? name.trim() : (builtIn?.name ?? id),
        // A built-in place keeps its node: only its name can change.
        node: builtIn ? builtIn.node : typeof node === 'string' && node ? node : 'offscreen',
        ...(typeof room === 'string' && room ? { room } : {}),
      });
    }
  }
  // Built-ins are filled in when missing, and come first.
  const places = BUILT_IN_PLACES.map((place) => byId.get(place.id) ?? { ...place });
  for (const place of byId.values()) if (!BUILT_IN_PLACES.some((builtIn) => builtIn.id === place.id)) places.push(place);
  return places;
}

function parseLocations(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [avatarId, placeId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof placeId === 'string' && placeId) out[avatarId] = placeId;
    }
    return out;
  } catch {
    return {};
  }
}

interface Pending extends PlaceMove {
  timers: Array<ReturnType<typeof setTimeout>>;
}

export class PlaceManager {
  private readonly emitter = new EventEmitter();
  private readonly options: PlaceManagerOptions;
  private readonly now: () => number;
  private readonly hallwayMs: number;
  private readonly deadlineMs: number;
  private readonly graceMs: number;
  /** Desktop rooms that are connected right now. Never stored: after a restart every desktop room is offline. */
  private readonly online = new Set<string>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly transit = new Map<string, Pending>();
  private waiters: Array<{ avatarId: string; placeId: string; resolve: (arrived: boolean) => void; timer: ReturnType<typeof setTimeout> | null; sawMove: boolean }> = [];
  private serial = 0;

  constructor(options: PlaceManagerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.hallwayMs = options.hallwayMs ?? HALLWAY_MS;
    this.deadlineMs = options.deadlineMs ?? MOVE_DEADLINE_MS;
    this.graceMs = options.graceMs ?? OFFLINE_GRACE_MS;
    this.emitter.setMaxListeners(20);
  }

  // -- Places -----------------------------------------------------------------------------------

  /** The places as stored (no `online`). */
  private stored(): Place[] {
    return parsePlaces(this.options.store.getValue(PLACES_KEY));
  }

  private persist(places: Place[]): void {
    this.options.store.setValue(PLACES_KEY, JSON.stringify(places.map(({ id, name, node, room }) => ({ id, name, node, ...(room ? { room } : {}) }))));
  }

  private isDevicePlace(place: Place): boolean {
    return place.node !== 'local' && place.node !== 'offscreen';
  }

  list(): Place[] {
    // A desktop room always has a room: one saved before rooms could be picked gets the default.
    return this.stored().map((place) =>
      this.isDevicePlace(place) ? { ...place, room: place.room ?? DEFAULT_DESKTOP_ROOM, online: this.online.has(place.id) } : { ...place },
    );
  }

  get(placeId: string): Place | null {
    return this.list().find((place) => place.id === placeId) ?? null;
  }

  /** The place drawn on this PC's screen. */
  localPlaceId(): string {
    return HOME_PLACE_ID;
  }

  /** Changes a place's name (Settings > Places). Returns the place, or null when there is none or the name is empty. */
  rename(placeId: string, name: string): Place | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const places = this.stored();
    const place = places.find((candidate) => candidate.id === placeId);
    if (!place) return null;
    place.name = trimmed.slice(0, 80);
    this.persist(places);
    this.changed();
    return this.get(placeId);
  }

  /** Picks the room a desktop room draws (Settings > Places). False when the place is not a desktop room or the id is empty. */
  setRoom(placeId: string, room: string): boolean {
    const trimmed = room.trim().slice(0, 200);
    const places = this.stored();
    const place = places.find((candidate) => candidate.id === placeId);
    if (!trimmed || !place || !this.isDevicePlace(place)) return false;
    place.room = trimmed;
    this.persist(places);
    this.changed();
    return true;
  }

  /** Adds a place drawn by another PC (`node` is that PC's device id). Null when the id is taken or invalid. */
  addPlace(input: { id: string; name: string; node: string; room?: string }): Place | null {
    const id = input.id.trim();
    const name = input.name.trim().slice(0, 80);
    if (!id || !name || !input.node || input.node === 'local' || input.node === 'offscreen') return null;
    const places = this.stored();
    if (places.some((place) => place.id === id)) return null;
    places.push({ id, name, node: input.node, room: input.room?.trim() || DEFAULT_DESKTOP_ROOM });
    this.persist(places);
    this.changed();
    return this.get(id);
  }

  /**
   * Removes a desktop room. Avatars there are put back at the local place at once (they appear where they
   * stand: the door walk needs the room to still exist). A built-in place cannot be removed.
   */
  removePlace(placeId: string): boolean {
    const places = this.stored();
    const place = places.find((candidate) => candidate.id === placeId);
    if (!place || !this.isDevicePlace(place)) return false;
    this.clearGrace(placeId);
    this.online.delete(placeId);
    for (const pending of [...this.transit.values()]) {
      if (pending.to === placeId || pending.from === placeId) this.cancelMove(pending);
    }
    const locations = this.storedLocations();
    for (const [avatarId, at] of Object.entries(locations)) if (at === placeId) delete locations[avatarId];
    this.options.store.setValue(LOCATIONS_KEY, JSON.stringify(locations));
    this.persist(places.filter((candidate) => candidate.id !== placeId));
    this.changed();
    return true;
  }

  isOnline(placeId: string): boolean {
    const place = this.get(placeId);
    return Boolean(place) && (!this.isDevicePlace(place as Place) || this.online.has(placeId));
  }

  /**
   * A desktop room connected or dropped. When it drops, its avatars get `graceMs` to come back (a Wi-Fi
   * blip); after that they are sent home, as a move with the reason 'room closed'.
   */
  setOnline(placeId: string, online: boolean): void {
    const place = this.get(placeId);
    if (!place || !this.isDevicePlace(place)) return;
    if (online) {
      this.clearGrace(placeId);
      if (this.online.has(placeId)) return;
      this.online.add(placeId);
      this.changed();
      return;
    }
    const wasOnline = this.online.delete(placeId);
    if (!this.graceTimers.has(placeId)) {
      this.graceTimers.set(
        placeId,
        this.timer(() => {
          this.graceTimers.delete(placeId);
          this.sendHome(placeId);
        }, this.graceMs),
      );
    }
    if (wasOnline) this.changed();
  }

  /** At start-up no desktop room is connected yet: start the grace clock for each, so no avatar is stuck in one forever. */
  settleOffline(): void {
    for (const place of this.stored()) if (this.isDevicePlace(place) && !this.online.has(place.id)) this.setOnline(place.id, false);
  }

  private clearGrace(placeId: string): void {
    const handle = this.graceTimers.get(placeId);
    if (handle) clearTimeout(handle);
    this.graceTimers.delete(placeId);
  }

  /** Grace is over and the room is still closed: everyone there walks in at the local place. */
  private sendHome(placeId: string): void {
    if (this.online.has(placeId)) return;
    for (const avatarId of this.avatarsAt(placeId)) this.startMove(avatarId, this.localPlaceId(), 'room closed');
  }

  /** The place a name or id means: ignores case, "the", and hyphens or underscores against spaces. Null when none fits. */
  resolvePlace(ref: string): Place | null {
    const wanted = normalise(ref);
    if (!wanted) return null;
    const places = this.list();
    return places.find((place) => normalise(place.id) === wanted) ?? places.find((place) => normalise(place.name) === wanted) ?? null;
  }

  // -- Who is where -----------------------------------------------------------------------------

  private avatarIds(): string[] {
    return this.options.registry.list().map((profile) => profile.id);
  }

  private storedLocations(): Record<string, string> {
    return parseLocations(this.options.store.getValue(LOCATIONS_KEY));
  }

  /** Where the avatar is. An avatar with no entry, or one naming an unknown place, is at home. In transit it is still at the place it left. */
  locationOf(avatarId: string): string {
    const placeId = this.storedLocations()[avatarId];
    return placeId && this.get(placeId) ? placeId : HOME_PLACE_ID;
  }

  inTransit(avatarId: string): boolean {
    return this.transit.has(avatarId);
  }

  /** The avatars at a place, in registry order. Avatars in transit are nowhere. */
  avatarsAt(placeId: string): string[] {
    return this.avatarIds().filter((avatarId) => !this.transit.has(avatarId) && this.locationOf(avatarId) === placeId);
  }

  /** At the place (this PC's by default), and not walking between places. */
  isPresent(avatarId: string, placeId: string = this.localPlaceId()): boolean {
    return this.avatarIds().includes(avatarId) && !this.transit.has(avatarId) && this.locationOf(avatarId) === placeId;
  }

  /** Avatars (registry order) that are somewhere else or on their way, for the floor to offer as candidates. */
  awayFrom(placeId: string): string[] {
    return this.avatarIds().filter((avatarId) => !this.isPresent(avatarId, placeId));
  }

  awayFromLocal(): string[] {
    return this.awayFrom(this.localPlaceId());
  }

  /** Who is where. `forPlaceId` is the place the reader draws: this PC passes nothing, a desktop room passes its own place. */
  snapshot(forPlaceId: string = this.localPlaceId()): PlacesSnapshot {
    const stored = this.storedLocations();
    const places = this.list();
    const locations: Record<string, string> = {};
    for (const avatarId of this.avatarIds()) {
      const placeId = stored[avatarId];
      locations[avatarId] = placeId && places.some((place) => place.id === placeId) ? placeId : HOME_PLACE_ID;
    }
    return {
      places,
      locations,
      transit: [...this.transit.values()].map((move) => ({ avatarId: move.avatarId, from: move.from, to: move.to })),
      localPlaceId: forPlaceId,
    };
  }

  onChanged(listener: (snapshot: PlacesSnapshot) => void): () => void {
    this.emitter.on('changed', listener);
    return () => {
      this.emitter.off('changed', listener);
    };
  }

  private changed(): void {
    // Listeners are the renderer push and the waiters; one failing must not hide the change from the others.
    try {
      this.emitter.emit('changed', this.snapshot());
    } catch (error) {
      this.options.logger?.warn('Places: a change listener threw', { message: error instanceof Error ? error.message : String(error) });
    }
    this.releaseWaiters();
  }

  // -- Moves ------------------------------------------------------------------------------------

  /** Sends an avatar to another place. It is in transit from now until it arrives (or the move fails). */
  startMove(avatarId: string, toPlaceId: string, reason: string): StartMoveResult {
    if (!this.avatarIds().includes(avatarId)) return { ok: false, reason: 'unknown avatar' };
    const target = this.get(toPlaceId);
    if (!target) return { ok: false, reason: 'unknown place' };
    if (target.online === false) return { ok: false, reason: `${target.name} is closed` };
    if (this.transit.has(avatarId)) return { ok: false, reason: 'already moving' };
    const from = this.locationOf(avatarId);
    if (from === target.id) return { ok: false, reason: 'already there' };
    const startedAt = this.now();
    const state: PlaceMove = { avatarId, from, to: target.id, reason, txn: `move:${avatarId}:${startedAt}:${++this.serial}`, startedAt };
    const pending: Pending = { ...state, timers: [] };
    this.transit.set(avatarId, pending);
    if (target.node === 'offscreen') {
      pending.timers.push(this.timer(() => this.complete(avatarId, state.txn), this.hallwayMs));
    }
    pending.timers.push(this.timer(() => this.fail(avatarId, state.txn), this.deadlineMs));
    this.journal(state, 'open', { avatarId, from, to: target.id, reason });
    this.changed();
    return { ok: true, state: { ...state } };
  }

  /** The screen that shows the target place has the avatar's body ready at the door. False when the avatar was not on its way. */
  arrived(avatarId: string): boolean {
    const pending = this.transit.get(avatarId);
    if (!pending) return false;
    this.complete(avatarId, pending.txn);
    return true;
  }

  /** Resolves true once the avatar is present at the place (the local one by default), false when it is not there after `timeoutMs` or the move failed. */
  waitForArrival(avatarId: string, timeoutMs: number, placeId: string = this.localPlaceId()): Promise<boolean> {
    if (this.isPresent(avatarId, placeId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter: (typeof this.waiters)[number] = { avatarId, placeId, resolve, timer: null, sawMove: this.transit.has(avatarId) };
      waiter.timer = this.timer(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        resolve(this.isPresent(avatarId, placeId));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private releaseWaiters(): void {
    for (const waiter of [...this.waiters]) {
      if (this.isPresent(waiter.avatarId, waiter.placeId)) {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(true);
      } else if (this.transit.has(waiter.avatarId)) {
        waiter.sawMove = true;
      } else if (waiter.sawMove) {
        // The move it waited for is over and the avatar is not here (the move failed): nothing more to wait for.
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    }
  }

  private timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  }

  private clearTimers(pending: Pending): void {
    for (const handle of pending.timers) clearTimeout(handle);
    pending.timers = [];
  }

  private complete(avatarId: string, txn: string): void {
    const pending = this.transit.get(avatarId);
    if (!pending || pending.txn !== txn) return;
    this.clearTimers(pending);
    this.transit.delete(avatarId);
    this.options.store.setValue(LOCATIONS_KEY, JSON.stringify({ ...this.storedLocations(), [avatarId]: pending.to }));
    this.journal(pending, 'done', { avatarId, from: pending.from, to: pending.to, reason: pending.reason });
    this.changed();
  }

  /** Drops a move without a journal entry about arrival (the place it involved is gone). */
  private cancelMove(pending: Pending): void {
    this.clearTimers(pending);
    this.transit.delete(pending.avatarId);
    this.journal(pending, 'failed', { avatarId: pending.avatarId, from: pending.from, to: pending.to, reason: 'place removed' });
  }

  private fail(avatarId: string, txn: string): void {
    const pending = this.transit.get(avatarId);
    if (!pending || pending.txn !== txn) return;
    this.clearTimers(pending);
    this.transit.delete(avatarId);
    this.options.logger?.warn('Places: a move was not confirmed in time; the avatar goes back', { avatarId, from: pending.from, to: pending.to });
    this.journal(pending, 'failed', { avatarId, from: pending.from, to: pending.to, reason: 'not confirmed in time' });
    this.changed();
  }

  /** Fire-and-forget; never throws. One transaction per move. */
  private journal(move: PlaceMove, state: 'open' | 'done' | 'failed', payload: Record<string, unknown>): void {
    try {
      const bus = this.options.bus?.();
      if (!bus) return;
      const event: SwitchboardEventInput = {
        type: 'avatar.move',
        producer: { kind: 'avatar', id: move.avatarId },
        to: [],
        scene: move.to,
        audience: 'private',
        txn: { id: move.txn, state },
        payload,
      };
      bus.publish(event);
    } catch {
      // Journaling must never disturb a move.
    }
  }
}

/**
 * The places as one place sees them: a desktop room's floor and summons ask "who is here" of their own place,
 * not of this PC's. Every method answers for `placeId` where the manager would answer for the local place.
 */
export type ScopedPlaces = Pick<
  PlaceManager,
  'list' | 'get' | 'localPlaceId' | 'avatarsAt' | 'awayFromLocal' | 'isPresent' | 'waitForArrival' | 'startMove' | 'inTransit' | 'snapshot' | 'onChanged'
>;

export function scopedPlaces(places: PlaceManager, placeId: string): ScopedPlaces {
  return {
    list: () => places.list(),
    get: (id) => places.get(id),
    localPlaceId: () => placeId,
    avatarsAt: (id) => places.avatarsAt(id),
    awayFromLocal: () => places.awayFrom(placeId),
    isPresent: (avatarId) => places.isPresent(avatarId, placeId),
    waitForArrival: (avatarId, timeoutMs) => places.waitForArrival(avatarId, timeoutMs, placeId),
    startMove: (avatarId, to, reason) => places.startMove(avatarId, to, reason),
    inTransit: (avatarId) => places.inTransit(avatarId),
    snapshot: (forPlaceId) => places.snapshot(forPlaceId ?? placeId),
    onChanged: (listener) => places.onChanged(listener),
  };
}

/**
 * The paragraph every avatar's prompt ends with: where it is, who is where, and how to walk to another
 * place. Null when there is only one place (nothing to say) or this is a preview.
 */
export function placesNote(manager: Pick<PlaceManager, 'list' | 'get' | 'localPlaceId' | 'avatarsAt'>, nameOf: (avatarId: string) => string): string | null {
  const places = manager.list();
  if (places.length < 2) return null;
  const here = manager.get(manager.localPlaceId());
  if (!here) return null;
  const others = places
    .filter((place) => place.id !== here.id)
    .map((place) => {
      const names = manager.avatarsAt(place.id).map(nameOf);
      const who =
        names.length === 0 ? 'nobody is there' : names.length === 1 ? `${names[0]} is there` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are there`;
      return `${place.name} (${who})`;
    });
  return `You are in ${here.name}. Other places: ${others.join('; ')}. To go to another place, write {room:<place name>} at the end of what you say: you finish speaking, walk out, and arrive a few seconds later. You only hear and see what happens in the place you are in.`;
}
