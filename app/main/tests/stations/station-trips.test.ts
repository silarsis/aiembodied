import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HALLWAY_MS, PlaceManager } from '../../src/places/place-manager.js';
import { READING_ROOM_ID, StationRegistry } from '../../src/stations/station-registry.js';
import { STATION_ARRIVAL_HOLD_MS, StationTrips } from '../../src/stations/station-trips.js';
import type { StationTool, StationUseEvent } from '../../src/stations/types.js';

const STUDIO = 'room:builtin:studio-flat';
const papers: StationTool = { id: 'srv-1:search_papers', serverId: 'srv-1', toolName: 'search_papers', readOnly: true };
const saveNote: StationTool = { id: 'srv-1:save_note', serverId: 'srv-1', toolName: 'save_note' };

interface Sent {
  avatarId: string;
  /** Where the avatar was when the event went out (which screen got it). */
  placeId: string;
  event: StationUseEvent;
}

function setup(options: { active?: string | null; attic?: string | null; sendOk?: boolean } = {}) {
  const kv = new Map<string, string>();
  const store = { getValue: (key: string) => kv.get(key) ?? null, setValue: (key: string, value: string) => void kv.set(key, value) };
  const places = new PlaceManager({
    store,
    registry: { list: () => [{ id: 'echo', name: 'Echo', vrmModelId: null }, { id: 'sage', name: 'Sage', vrmModelId: null }] },
  });
  if (options.attic !== undefined && options.attic !== null) {
    places.addPlace({ id: 'attic', name: 'the attic', node: 'pc-2', room: options.attic });
    places.setOnline('attic', true);
  }
  // The renderer of every place confirms an avatar standing at the door as soon as the move starts.
  const screen = { answers: true };
  places.onChanged((snapshot) => {
    for (const move of snapshot.transit) {
      if (move.to !== 'next-door' && screen.answers) queueMicrotask(() => places.arrived(move.avatarId));
    }
  });
  const stations = new StationRegistry({
    store,
    servers: () => [{ id: 'srv-1', httpUrl: 'https://academy.dair.ai/api/mcp' }],
    describeRoom: async () => ({ name: 'Reading room', objects: [{ id: 'bookshelf', name: 'bookshelf' }] }),
  });
  const sent: Sent[] = [];
  const active = { room: options.active === undefined ? READING_ROOM_ID : options.active };
  const trips = new StationTrips({
    stations,
    places,
    activeRoom: () => active.room,
    send: (avatarId, event) => {
      if (options.sendOk === false) return false;
      sent.push({ avatarId, placeId: places.locationOf(avatarId), event });
      return true;
    },
    holdMs: STATION_ARRIVAL_HOLD_MS,
    errandCapMs: 20_000,
  });
  return { trips, places, stations, sent, active, screen };
}

/** Lets promises and the zero-time timers they wait on run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('StationTrips', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('in the room that holds the station', () => {
    it('sends station:use at once, and the answer waits for station:arrived', async () => {
      const { trips, sent } = setup();
      const use = trips.begin('echo', papers);
      expect(use).not.toBeNull();
      expect(sent).toHaveLength(1);
      expect(sent[0].event).toMatchObject({
        avatarId: 'echo',
        roomId: READING_ROOM_ID,
        objectId: 'bookshelf',
        activity: 'pulls a book from the shelf and reads',
        phase: 'start',
      });

      let done = false;
      const settled = use!.settle(true).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(2000);
      expect(done).toBe(false);

      expect(trips.arrived(sent[0].event.useId)).toBe(true);
      await settled;
      expect(sent[1].event).toMatchObject({ phase: 'end', ok: true, useId: sent[0].event.useId });
    });

    it('does not wait when the renderer already said it arrived while the tool was running', async () => {
      const { trips, sent } = setup();
      const use = trips.begin('echo', papers)!;
      trips.arrived(sent[0].event.useId);
      await use.settle(false);
      expect(sent[1].event).toMatchObject({ phase: 'end', ok: false });
    });

    it('gives up waiting after the cap', async () => {
      const { trips } = setup();
      const use = trips.begin('echo', papers)!;
      let done = false;
      void use.settle(true).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(STATION_ARRIVAL_HOLD_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    });

    it('stops waiting when the turn is cancelled', async () => {
      const { trips } = setup();
      const use = trips.begin('echo', papers)!;
      const controller = new AbortController();
      let done = false;
      void use.settle(true, controller.signal).then(() => (done = true));
      controller.abort();
      await flush();
      expect(done).toBe(true);
    });

    it('knows an arrival report that matches no trip', () => {
      expect(setup().trips.arrived('nobody')).toBe(false);
    });
  });

  describe('no trip', () => {
    it('stays put with a 2D background, or no room', () => {
      const { trips, sent, active } = setup({ active: 'builtin:garden' });
      expect(trips.begin('echo', papers)).toBeNull();
      active.room = null;
      expect(trips.begin('echo', papers)).toBeNull();
      expect(sent).toHaveLength(0);
    });

    it('stays put for a tool that holds no station', () => {
      const { trips } = setup();
      expect(trips.begin('echo', { id: 'x:y', serverId: 'x', toolName: 'y' })).toBeNull();
    });

    it("respects the station's characters", () => {
      const { trips, stations } = setup();
      const [station] = stations.list();
      stations.update(station.id, { characters: ['sage'] });
      expect(trips.begin('echo', papers)).toBeNull();
      expect(trips.begin('sage', papers)).not.toBeNull();
    });

    it("skips a read-only tool when the trip is 'writes' only", () => {
      const { trips, stations } = setup();
      stations.update(stations.list()[0].id, { trip: 'writes' });
      expect(trips.begin('echo', papers)).toBeNull();
      expect(trips.begin('echo', saveNote)).not.toBeNull();
    });

    it('stays put when nobody could receive the event', () => {
      expect(setup({ sendOk: false }).trips.begin('echo', papers)).toBeNull();
    });

    it('stays put while the avatar is already moving', () => {
      const { trips, places } = setup({ active: STUDIO });
      places.startMove('echo', 'next-door', 'test');
      expect(trips.begin('echo', papers)).toBeNull();
    });
  });

  describe('in another room that another place shows', () => {
    it('moves the avatar there, lets that place walk it to the object, and brings it back', async () => {
      const { trips, places, sent } = setup({ active: STUDIO, attic: READING_ROOM_ID });
      const use = trips.begin('echo', papers)!;
      expect(places.inTransit('echo')).toBe(true);
      await flush();
      expect(places.locationOf('echo')).toBe('attic');
      // The attic's renderer got the walk, not this PC's.
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ placeId: 'attic', event: { phase: 'start', objectId: 'bookshelf' } });

      await use.settle(true);
      expect(sent[1]).toMatchObject({ placeId: 'attic', event: { phase: 'end', ok: true } });
      expect(places.locationOf('echo')).toBe('home');
      expect(places.inTransit('echo')).toBe(false);
    });

    it("moves the avatar to this PC when the stage shows the station's room and the avatar is on the attic's other room", async () => {
      const { trips, places, sent } = setup({ active: READING_ROOM_ID, attic: STUDIO });
      places.startMove('echo', 'attic', 'test');
      await flush();
      expect(places.locationOf('echo')).toBe('attic');
      const use = trips.begin('echo', papers)!;
      await flush();
      expect(places.locationOf('echo')).toBe('home');
      expect(sent[0]).toMatchObject({ placeId: 'home', event: { phase: 'start' } });
      await use.settle(true);
      expect(places.locationOf('echo')).toBe('attic');
    });

    it('goes next door instead when that place is offline', async () => {
      const { trips, places } = setup({ active: STUDIO, attic: READING_ROOM_ID });
      places.setOnline('attic', false);
      trips.begin('echo', papers);
      await vi.advanceTimersByTimeAsync(HALLWAY_MS);
      expect(places.locationOf('echo')).toBe('next-door');
    });
  });

  describe('in another room that no place shows', () => {
    it('sends the avatar next door on an errand and brings it back', async () => {
      const { trips, places, sent } = setup({ active: STUDIO });
      const use = trips.begin('echo', papers)!;
      expect(use).not.toBeNull();
      await vi.advanceTimersByTimeAsync(HALLWAY_MS);
      expect(places.locationOf('echo')).toBe('next-door');
      // Nobody draws next door: no walk is sent.
      expect(sent).toHaveLength(0);

      await use.settle(true);
      expect(places.locationOf('echo')).toBe('home');
      expect(sent).toHaveLength(0);
    });

    it('stops waiting when the way back is never confirmed', async () => {
      const { trips, screen } = setup({ active: STUDIO });
      const use = trips.begin('echo', papers)!;
      await vi.advanceTimersByTimeAsync(HALLWAY_MS);
      // This PC's screen stops confirming arrivals, so the way back never completes.
      screen.answers = false;
      let done = false;
      void use.settle(true).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(5000);
      expect(done).toBe(false);
      // The place move itself gives up after its own deadline (MOVE_DEADLINE_MS), well inside the errand cap.
      await vi.advanceTimersByTimeAsync(6000);
      expect(done).toBe(true);
    });
  });

  describe('the errand cap', () => {
    it('is longer than two place moves, and ends the wait even when moves are slow', async () => {
      const kv = new Map<string, string>();
      const places = new PlaceManager({
        store: { getValue: (key) => kv.get(key) ?? null, setValue: (key, value) => void kv.set(key, value) },
        registry: { list: () => [{ id: 'echo', name: 'Echo', vrmModelId: null }] },
        deadlineMs: 60_000,
      });
      const stations = new StationRegistry({ store: { getValue: (key) => kv.get(key) ?? null, setValue: (key, value) => void kv.set(key, value) }, servers: () => [{ id: 'srv-1', httpUrl: 'https://academy.dair.ai/api/mcp' }] });
      const trips = new StationTrips({ stations, places, activeRoom: () => STUDIO, send: () => true, errandCapMs: 8000 });
      const use = trips.begin('echo', papers)!;
      await vi.advanceTimersByTimeAsync(HALLWAY_MS);
      expect(places.locationOf('echo')).toBe('next-door');
      let done = false;
      void use.settle(true).then(() => (done = true));
      // Home never confirms, and the move's own deadline is a minute away: only the cap ends the wait.
      await vi.advanceTimersByTimeAsync(5000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(done).toBe(true);
    });
  });

  describe('what the avatar says while the tool runs', () => {
    it('says it will check the object, or go and check it on an errand', () => {
      const here = setup();
      expect(here.trips.noticeFor('echo', papers)).toBe('Let me check the bookshelf.');
      const away = setup({ active: STUDIO });
      expect(away.trips.noticeFor('echo', papers)).toBe("I'll go and check the bookshelf.");
    });

    it('lets a tool with its own notice keep it when there is no errand', () => {
      const { trips } = setup();
      expect(trips.noticeFor('echo', { ...papers, spokenNotice: 'Hold on.' })).toBeNull();
      expect(trips.noticeFor('echo', { id: 'x:y', serverId: 'x', toolName: 'y' })).toBeNull();
    });
  });
});
