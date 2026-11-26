/**
 * Station trips: what happens in main when an avatar uses a tool that lives at a station.
 *
 * Three cases, decided by where the avatar is when the tool starts:
 * - The avatar stands in the 3D room that holds the station: `station:use` goes to the screen that draws it,
 *   its renderer walks the avatar to the object and acts the activity, and answers `station:arrived`. The tool
 *   is NOT delayed by the walk. After the tool returns, the answer waits for the arrival (at most
 *   STATION_ARRIVAL_HOLD_MS), so the avatar is at the bookshelf when it speaks.
 * - The avatar is in another 3D room, and some place draws the station's room: the avatar moves to that place
 *   (a normal place move), that place's renderer walks it to the object, and when the tool is done it moves back.
 *   The answer waits for the way back (at most STATION_ERRAND_CAP_MS for the whole errand).
 * - The avatar is in another 3D room and no place draws the station's room: it goes to `next-door` (offscreen)
 *   as an errand and comes back the same way.
 * An avatar that is not in a 3D room (a 2D background, away, already moving) makes no trip at all.
 *
 * Pure: no Electron. Places, the registry, the sender and the clock come in from outside so the tests can fake them.
 */
import { randomUUID } from 'node:crypto';
import { MOVE_DEADLINE_MS, NEXT_DOOR_PLACE_ID, type PlaceManager } from '../places/place-manager.js';
import type { Place } from '../shared/places/place-manager-types.js';
import type { StationRegistry } from './station-registry.js';
import type { StationTool } from './types.js';
import type { Station, StationUseEvent } from '../shared/stations/types.js';

/** How long the answer waits for the avatar to reach the object in its own room. */
export const STATION_ARRIVAL_HOLD_MS = 6000;
/** How long a whole errand to another place may take (out, the tool, and back); two place moves plus a margin. */
export const STATION_ERRAND_CAP_MS = 2 * MOVE_DEADLINE_MS + 5000;

type TripPlaces = Pick<PlaceManager, 'localPlaceId' | 'locationOf' | 'inTransit' | 'list' | 'get' | 'isClosed' | 'startMove' | 'waitForArrival'>;
type TripStations = Pick<StationRegistry, 'stationForTool' | 'needsTrip' | 'appliesTo' | 'labelsFor'>;

export interface StationTripsOptions {
  stations: TripStations;
  places: TripPlaces;
  /** The room the local place draws: a 3D room id (`room:...`), or null for a 2D background or none. */
  activeRoom: () => string | null;
  /**
   * Sends `station:use` to the screen that draws the avatar's place. False when nobody could receive it
   * (no window, the satellite is gone): the avatar then simply does not make the trip.
   */
  send: (avatarId: string, event: StationUseEvent) => boolean;
  holdMs?: number;
  errandCapMs?: number;
  logger?: Pick<Console, 'info' | 'warn'>;
}

/** One trip in progress; the voice calls `settle` after the tool returned. */
export interface StationUse {
  /** The tool finished (`ok`: it worked). Resolves when the answer may be spoken: arrived, back, or out of time. */
  settle(ok: boolean, signal?: AbortSignal): Promise<void>;
}

/** A trip made for a pursuit (reading at the bookshelf): the same trip, plus what the avatar does there. */
export interface StationVisit extends StationUse {
  /** Resolves when the avatar is at the object (or the walk failed or timed out). Never rejects. */
  arrived(): Promise<void>;
  /** The avatar acts something else at the object ("jots down notes"). Ignored until it has arrived at a screen that draws the room. */
  activity(text: string, step?: string): void;
}

/** Resolves when the promise does, or as soon as the signal aborts (the turn was cancelled). */
function until<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    signal.addEventListener('abort', () => resolve(undefined), { once: true });
    promise.then(resolve, reject);
  });
}

type Plan =
  | { kind: 'same'; station: Station }
  | { kind: 'errand'; station: Station; placeId: string; toStation: boolean };

export class StationTrips {
  private readonly holdMs: number;
  private readonly errandCapMs: number;
  /** Trips waiting for the renderer to say it arrived. */
  private readonly waiting = new Map<string, () => void>();
  /** What each same-room trip is, for the log lines written when the renderer answers. */
  private readonly meta = new Map<string, { info: Record<string, unknown>; startedAt: number }>();

  constructor(private readonly options: StationTripsOptions) {
    this.holdMs = options.holdMs ?? STATION_ARRIVAL_HOLD_MS;
    this.errandCapMs = options.errandCapMs ?? STATION_ERRAND_CAP_MS;
  }

  /** The renderer got the avatar to the object (or could not walk): the answer may go on. */
  arrived(useId: string): boolean {
    const release = this.waiting.get(useId);
    if (!release) return false;
    const meta = this.meta.get(useId);
    this.options.logger?.info('Stations: trip arrived', { ...meta?.info, waitedMs: meta ? Date.now() - meta.startedAt : undefined });
    release();
    return true;
  }

  /** The 3D room a place draws, or null (2D background, offscreen, unknown). */
  private roomOf(placeId: string): string | null {
    const place = this.options.places.get(placeId);
    if (!place || place.node === 'offscreen') return null;
    const room = placeId === this.options.places.localPlaceId() ? this.options.activeRoom() : (place.room ?? null);
    return room && room.startsWith('room:') ? room : null;
  }

  /** A place other than `except` that is open and draws `roomId`. */
  private placeShowing(roomId: string, except: string): Place | null {
    const { places } = this.options;
    return (
      places.list().find((place) => place.id !== except && place.node !== 'offscreen' && place.online !== false && !places.isClosed(place.id) && this.roomOf(place.id) === roomId) ?? null
    );
  }

  /** What this avatar would do for this tool right now, or null for no trip. */
  private plan(avatarId: string, tool: StationTool): Plan | null {
    const planned = this.planWhy(avatarId, tool);
    return typeof planned === 'string' ? null : planned;
  }

  /** Like `plan`, but a no-trip answer says why (a short text for the log). */
  private planWhy(avatarId: string, tool: StationTool): Plan | string {
    const { stations } = this.options;
    const station = stations.stationForTool(tool);
    if (!station) return 'the tool is not kept at a station';
    if (!stations.appliesTo(station, avatarId)) return 'the station is not for this character';
    if (!stations.needsTrip(station, tool)) return 'this tool does not need a trip (a read at a writes-only station)';
    return this.planFor(avatarId, station);
  }

  /** What this avatar would do to get to this station right now; a text (the reason) when there is no trip. */
  private planFor(avatarId: string, station: Station): Plan | string {
    const { places } = this.options;
    if (places.inTransit(avatarId)) return 'the avatar is already moving';
    const here = places.locationOf(avatarId);
    const hereRoom = this.roomOf(here);
    if (!hereRoom) return 'the avatar is not in a 3D room';
    if (hereRoom === station.roomId) return { kind: 'same', station };
    const there = this.placeShowing(station.roomId, here);
    if (there) return { kind: 'errand', station, placeId: there.id, toStation: true };
    const nextDoor = places.get(NEXT_DOOR_PLACE_ID);
    if (nextDoor && here !== nextDoor.id) return { kind: 'errand', station, placeId: nextDoor.id, toStation: false };
    return 'no place shows the station room and there is no next door';
  }

  /** The log fields that name a trip: who, where and which of the three cases. */
  private tripInfo(avatarId: string, plan: Plan, source: 'pursuit' | 'tool'): Record<string, unknown> {
    return {
      avatarId,
      stationId: plan.station.id,
      source,
      case: plan.kind === 'same' ? 'same-room' : plan.toStation ? 'other-place' : 'errand',
    };
  }

  /** Logs "no trip" with the reason; returns null so the callers can `return this.none(...)`. */
  private none(avatarId: string, stationId: string | null, why: string, source: 'pursuit' | 'tool'): null {
    this.options.logger?.info('Stations: trip none', { avatarId, stationId, source, case: 'none', why });
    return null;
  }

  /**
   * What the avatar says while the tool runs, when the station has something to say: "Let me check the bookshelf."
   * or, for a trip to another place, "I'll go and check the bookshelf." Null leaves the tool's own notice.
   */
  noticeFor(avatarId: string, tool: StationTool & { spokenNotice?: string }): string | null {
    const station = this.options.stations.stationForTool(tool);
    if (!station) return null;
    const { objectName } = this.options.stations.labelsFor(station);
    if (this.plan(avatarId, tool)?.kind === 'errand') return `I'll go and check the ${objectName}.`;
    return tool.spokenNotice ? null : `Let me check the ${objectName}.`;
  }

  /** A tool is about to run for this avatar. Returns the trip, or null when the avatar stays where it is. */
  begin(avatarId: string, tool: StationTool): StationVisit | null {
    const plan = this.planWhy(avatarId, tool);
    if (typeof plan === 'string') {
      // A tool that lives nowhere is not worth a line; every other no-trip case is.
      const station = this.options.stations.stationForTool(tool);
      return station ? this.none(avatarId, station.id, plan, 'tool') : null;
    }
    return plan.kind === 'same' ? this.beginSameRoom(avatarId, plan.station, 'tool') : this.beginErrand(avatarId, plan, 'tool');
  }

  /**
   * A pursuit goes to a station (no tool involved): the same walk, or errand to another place, as a tool would
   * make. Null when the avatar stays where it is (a 2D background, away, already moving, nobody could get the event).
   * `settle` ends the visit: the end event, and the way back from an errand.
   */
  beginAt(avatarId: string, station: Station): StationVisit | null {
    if (!this.options.stations.appliesTo(station, avatarId)) return this.none(avatarId, station.id, 'the station is not for this character', 'pursuit');
    const plan = this.planFor(avatarId, station);
    if (typeof plan === 'string') return this.none(avatarId, station.id, plan, 'pursuit');
    return plan.kind === 'same' ? this.beginSameRoom(avatarId, plan.station, 'pursuit') : this.beginErrand(avatarId, plan, 'pursuit');
  }

  private event(avatarId: string, station: Station, useId: string, phase: StationUseEvent['phase'], ok?: boolean, source: 'pursuit' | 'tool' = 'tool'): StationUseEvent {
    return {
      ...(source === 'pursuit' ? { source, ...(station.body ? { body: station.body } : {}) } : {}),
      useId,
      avatarId,
      stationId: station.id,
      roomId: station.roomId,
      objectId: station.objectId,
      activity: station.activity,
      phase,
      ...(ok === undefined ? {} : { ok }),
    };
  }

  // -- Same room ----------------------------------------------------------------------------------

  private beginSameRoom(avatarId: string, station: Station, source: 'pursuit' | 'tool'): StationVisit | null {
    const useId = randomUUID();
    const info = this.tripInfo(avatarId, { kind: 'same', station }, source);
    if (!this.options.send(avatarId, this.event(avatarId, station, useId, 'start', undefined, source))) {
      return this.none(avatarId, station.id, 'no screen could receive the walk', source);
    }
    this.options.logger?.info('Stations: trip start', { ...info, objectId: station.objectId });
    const startedAt = Date.now();
    this.meta.set(useId, { info, startedAt });
    // Listen from now: the renderer may report arrival before the tool is done.
    const arrival = this.waitForArrival(useId, this.holdMs);
    return {
      arrived: () => arrival,
      activity: (text, step) => {
        this.options.send(avatarId, { ...this.event(avatarId, station, useId, 'activity', undefined, source), activity: text, ...(step ? { step } : {}) });
      },
      settle: async (ok, signal) => {
        const heldFrom = Date.now();
        await until(arrival, signal);
        // `held`: how long the answer waited for the arrival (0 when the avatar was already there).
        this.options.logger?.info('Stations: trip held', { ...info, heldMs: Date.now() - heldFrom, cancelled: signal?.aborted === true });
        this.meta.delete(useId);
        this.options.send(avatarId, this.event(avatarId, station, useId, 'end', ok, source));
        this.options.logger?.info('Stations: trip end', { ...info, ok, totalMs: Date.now() - startedAt });
      },
    };
  }

  /** Resolves when `arrived(useId)` is called, or after `ms`. */
  private waitForArrival(useId: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      // The cap runs from the start of the tool, so a slow tool leaves no extra wait.
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const waiting = this.waiting;
      function done(): void {
        clearTimeout(timer);
        waiting.delete(useId);
        resolve();
      }
      waiting.set(useId, done);
    });
  }

  // -- Another place ------------------------------------------------------------------------------

  private beginErrand(avatarId: string, plan: Extract<Plan, { kind: 'errand' }>, source: 'pursuit' | 'tool'): StationVisit | null {
    const { places, logger } = this.options;
    const origin = places.locationOf(avatarId);
    const objectName = this.options.stations.labelsFor(plan.station).objectName;
    const started = places.startMove(avatarId, plan.placeId, `went to the ${objectName}`);
    if (!started.ok) {
      logger?.info('Station: the avatar could not go', { avatarId, placeId: plan.placeId, reason: started.reason });
      return this.none(avatarId, plan.station.id, `the move was refused: ${started.reason ?? 'unknown'}`, source);
    }
    const useId = randomUUID();
    const startedAt = Date.now();
    const info = { ...this.tripInfo(avatarId, plan, source), placeId: plan.placeId };
    logger?.info('Stations: trip start', info);
    const left = (): number => Math.max(0, this.errandCapMs - (Date.now() - startedAt));
    // Out: wait for the arrival, then (at a place with a screen) let its renderer walk to the object.
    let atObject = false;
    const out = places.waitForArrival(avatarId, left(), plan.placeId).then((arrived) => {
      logger?.info('Stations: trip arrived', { ...info, arrived, waitedMs: Date.now() - startedAt });
      if (arrived && plan.toStation) {
        atObject = this.options.send(avatarId, this.event(avatarId, plan.station, useId, 'start', undefined, source));
      }
      return arrived;
    });
    // Everything after the tool: the end event, then the way back. It always waits for the outbound move to end
    // (arrived or failed) before moving back, also when the turn was cancelled meanwhile: a second move while the
    // first is still going is refused ("already moving") and the avatar would stay away.
    const comeBack = async (ok: boolean): Promise<void> => {
      const arrived = await out.catch(() => false);
      if (arrived && plan.toStation) this.options.send(avatarId, this.event(avatarId, plan.station, useId, 'end', ok, source));
      if (!arrived) {
        // The move failed or timed out. If the avatar is on its way somewhere, wait for that to end.
        logger?.warn('Station: the avatar did not get there', { avatarId, placeId: plan.placeId });
        if (places.locationOf(avatarId) === origin && !places.inTransit(avatarId)) return;
      }
      const back = places.startMove(avatarId, origin, 'came back');
      if (!back.ok) {
        logger?.warn('Station: the avatar could not go back', { avatarId, origin, reason: back.reason });
        return;
      }
      const home = await places.waitForArrival(avatarId, left(), origin);
      if (!home) logger?.warn('Station: the avatar was not back in time', { avatarId, origin });
      logger?.info('Stations: trip end', { ...info, ok, backHome: home, totalMs: Date.now() - startedAt });
    };
    return {
      arrived: async () => {
        await out.then(() => undefined, () => undefined);
      },
      activity: (text, step) => {
        if (atObject) this.options.send(avatarId, { ...this.event(avatarId, plan.station, useId, 'activity', undefined, source), activity: text, ...(step ? { step } : {}) });
      },
      settle: async (ok, signal) => {
        // A cancelled turn stops waiting at once; the avatar still goes home, in the background.
        // `held`: the answer waits for the way back.
        logger?.info('Stations: trip held', { ...info, errandCapMs: this.errandCapMs });
        const home = comeBack(ok).catch((error: unknown) => {
          logger?.warn('Station: the way back failed', { avatarId, message: error instanceof Error ? error.message : String(error) });
        });
        await until(home, signal);
      },
    };
  }
}
