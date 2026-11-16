/**
 * The stations Kevin has set up, saved in the settings store under `rooms.stations`.
 *
 * The registry answers "does this tool live somewhere?" (`stationForTool`), "does using it mean a walk?"
 * (`needsTrip`) and "does this avatar make that walk?" (`appliesTo`). It also keeps the names of the room
 * and the object so a tool's description can say where the tool is kept.
 *
 * Pure: the store, the list of MCP servers and the room reader come in from outside so tests can fake them.
 */
import { randomUUID } from 'node:crypto';
import { findPreset } from '../mcp/presets.js';
import type { Station, StationLabels, StationSource, StationTool, StationView } from './types.js';

export const STATIONS_KEY = 'rooms.stations';

/** The Reading room of the built-in rooms (assets/rooms/reading-room.json). */
export const READING_ROOM_ID = 'room:builtin:reading-room';

/**
 * Stations that exist without Kevin setting them up: a built-in room that has a natural place for a preset.
 * Each is added (once) as soon as the preset's server exists and no other station holds that server. If Kevin
 * removes it, it stays removed (`removedDefaults` in the saved data).
 */
export const DEFAULT_STATIONS: Station[] = [
  {
    id: 'default:dair-academy-papers',
    roomId: READING_ROOM_ID,
    objectId: 'bookshelf',
    source: { kind: 'mcp', preset: 'dair-academy-papers' },
    verb: 'read',
    activity: 'pulls a book from the shelf and reads',
    trip: 'all',
    characters: 'all',
  },
];

/** What the registry needs to know about an MCP server: its id and address. */
export interface StationServer {
  id: string;
  httpUrl?: string;
  sseUrl?: string;
}

export interface StationRoomInfo {
  name: string;
  objects: Array<{ id: string; name: string }>;
}

export interface StationRegistryOptions {
  store: { getValue(key: string): string | null; setValue(key: string, value: string): void };
  /** The MCP servers that exist (connected or not). */
  servers: () => StationServer[];
  /** Reads a room's name and object names; null when the room is gone. Used for the labels. */
  describeRoom?: (roomId: string) => Promise<StationRoomInfo | null>;
  /** Looks a tool up by id (the ToolRegistry). */
  tools?: { get(id: string): StationTool | undefined };
  /** Called after any change, so the voice can offer the new descriptions. */
  onChanged?: () => void;
}

interface Saved {
  stations: Station[];
  removedDefaults: string[];
}

/** What a caller may give when adding a station. Missing fields get plain defaults. */
export type StationInput = Partial<Omit<Station, 'id'>> & Pick<Station, 'roomId' | 'objectId' | 'source'>;

function sanitizeSource(input: unknown): StationSource | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (value.kind === 'mcp') {
    const serverId = typeof value.serverId === 'string' && value.serverId ? value.serverId : undefined;
    const preset = typeof value.preset === 'string' && value.preset ? value.preset : undefined;
    if (!serverId && !preset) return null;
    return { kind: 'mcp', ...(serverId ? { serverId } : {}), ...(preset ? { preset } : {}) };
  }
  if (value.kind === 'builtin' && Array.isArray(value.toolNames)) {
    const toolNames = value.toolNames.filter((name): name is string => typeof name === 'string' && name.length > 0);
    return toolNames.length ? { kind: 'builtin', toolNames } : null;
  }
  return null;
}

/** One saved station, or null when it is unusable. Anything unreadable falls back to a default for that field. */
export function sanitizeStation(input: unknown): Station | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const source = sanitizeSource(value.source);
  if (typeof value.id !== 'string' || !value.id || typeof value.roomId !== 'string' || !value.roomId) return null;
  if (typeof value.objectId !== 'string' || !value.objectId || !source) return null;
  const characters =
    Array.isArray(value.characters) && value.characters.every((id) => typeof id === 'string')
      ? (value.characters as string[])
      : 'all';
  return {
    id: value.id,
    roomId: value.roomId,
    objectId: value.objectId,
    source,
    verb: typeof value.verb === 'string' && value.verb.trim() ? value.verb.trim() : 'use',
    activity: typeof value.activity === 'string' && value.activity.trim() ? value.activity.trim() : `uses the ${value.objectId}`,
    trip: value.trip === 'writes' ? 'writes' : 'all',
    characters,
  };
}

function sameSource(a: StationSource, b: StationSource): boolean {
  if (a.kind === 'mcp' && b.kind === 'mcp') return (a.serverId ?? null) === (b.serverId ?? null) && (a.preset ?? null) === (b.preset ?? null);
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.toolNames.join('\n') === b.toolNames.join('\n');
  return false;
}

/** Compare web addresses loosely: case and a trailing slash do not matter. */
function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const clean = (url: string) => url.trim().toLowerCase().replace(/\/+$/, '');
  return clean(a) === clean(b);
}

export class StationRegistry {
  private readonly labels = new Map<string, { room: StationRoomInfo | null }>();

  constructor(private readonly options: StationRegistryOptions) {}

  // -- Reading and saving -------------------------------------------------------------------------

  private read(): Saved {
    const raw = this.options.store.getValue(STATIONS_KEY);
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const stations = (Array.isArray(value.stations) ? value.stations : []).map(sanitizeStation).filter((s): s is Station => s !== null);
    const removedDefaults = Array.isArray(value.removedDefaults) ? value.removedDefaults.filter((id): id is string => typeof id === 'string') : [];
    return { stations, removedDefaults };
  }

  private write(saved: Saved): void {
    this.options.store.setValue(STATIONS_KEY, JSON.stringify(saved));
  }

  /** The id of the MCP server a source names, or null when that server does not exist (yet). */
  resolveServerId(source: StationSource): string | null {
    if (source.kind !== 'mcp') return null;
    const servers = this.options.servers();
    if (source.serverId && servers.some((server) => server.id === source.serverId)) return source.serverId;
    if (source.preset) {
      // A preset names a server by its address: the server added by the "add preset" button.
      const url = findPreset(source.preset)?.config.httpUrl;
      const match = servers.find((server) => sameUrl(server.httpUrl, url) || sameUrl(server.sseUrl, url));
      if (match) return match.id;
    }
    return null;
  }

  /** The stations, with built-in defaults added when their server exists and nobody holds it. */
  list(): Station[] {
    const saved = this.read();
    let changed = false;
    for (const fallback of DEFAULT_STATIONS) {
      if (saved.removedDefaults.includes(fallback.id) || saved.stations.some((s) => s.id === fallback.id)) continue;
      const serverId = this.resolveServerId(fallback.source);
      if (serverId === null) continue;
      // Someone else (Kevin, on another object) already holds this server: leave it alone.
      if (saved.stations.some((s) => this.resolveServerId(s.source) === serverId)) continue;
      saved.stations.push({ ...fallback });
      changed = true;
    }
    if (changed) this.write(saved);
    return saved.stations;
  }

  get(id: string): Station | null {
    return this.list().find((station) => station.id === id) ?? null;
  }

  add(input: StationInput): Station {
    const station = sanitizeStation({ ...input, id: `station-${randomUUID()}` });
    if (!station) throw new Error('This station needs a room, an object and something to hold.');
    const saved = this.read();
    saved.stations.push(station);
    this.write(saved);
    this.changed();
    return station;
  }

  update(id: string, changes: Partial<Omit<Station, 'id'>>): Station | null {
    this.list(); // so a default that was never saved can be changed
    const saved = this.read();
    const index = saved.stations.findIndex((station) => station.id === id);
    if (index < 0) return null;
    const next = sanitizeStation({ ...saved.stations[index], ...changes, id });
    if (!next) throw new Error('This station could not be saved.');
    saved.stations[index] = next;
    this.write(saved);
    this.changed();
    return next;
  }

  remove(id: string): boolean {
    this.list();
    const saved = this.read();
    const before = saved.stations.length;
    saved.stations = saved.stations.filter((station) => station.id !== id);
    if (saved.stations.length === before) return false;
    // A removed default must not come back the next time the list is read.
    if (DEFAULT_STATIONS.some((fallback) => fallback.id === id) && !saved.removedDefaults.includes(id)) saved.removedDefaults.push(id);
    this.write(saved);
    this.changed();
    return true;
  }

  /**
   * What the "Holds" dropdown of an object does: make this object hold `source` (or nothing, when null).
   * A source lives in one place, so any other station that holds it is removed. Settings that Kevin did not
   * touch (verb, activity, trip, characters) are kept when the object already had a station.
   */
  hold(roomId: string, objectId: string, source: StationSource | null, extra: Partial<Pick<Station, 'verb' | 'activity' | 'trip' | 'characters'>> = {}): Station | null {
    this.list();
    const saved = this.read();
    const here = saved.stations.find((station) => station.roomId === roomId && station.objectId === objectId);
    const dropped = (station: Station): boolean =>
      station !== here && source !== null && (sameSource(station.source, source) || (this.resolveServerId(station.source) !== null && this.resolveServerId(station.source) === this.resolveServerId(source)));
    const removed = saved.stations.filter((station) => dropped(station) || (source === null && station === here));
    saved.stations = saved.stations.filter((station) => !removed.includes(station));
    for (const station of removed) {
      if (DEFAULT_STATIONS.some((fallback) => fallback.id === station.id) && !saved.removedDefaults.includes(station.id)) saved.removedDefaults.push(station.id);
    }
    let result: Station | null = null;
    if (source !== null) {
      const next = sanitizeStation({ ...(here ?? { verb: 'use', trip: 'all', characters: 'all' }), ...extra, id: here?.id ?? `station-${randomUUID()}`, roomId, objectId, source });
      if (!next) throw new Error('This station could not be saved.');
      saved.stations = here ? saved.stations.map((station) => (station === here ? next : station)) : [...saved.stations, next];
      result = next;
    }
    this.write(saved);
    this.changed();
    return result;
  }

  // -- Questions ----------------------------------------------------------------------------------

  /** The station that holds a tool (given as an id or the tool itself), or null. */
  stationForTool(tool: string | StationTool): Station | null {
    const found = typeof tool === 'string' ? this.options.tools?.get(tool) : tool;
    if (!found) return null;
    for (const station of this.list()) {
      if (station.source.kind === 'builtin') {
        if (found.serverId === 'builtin' && station.source.toolNames.includes(found.toolName)) return station;
      } else if (this.resolveServerId(station.source) === found.serverId) {
        return station;
      }
    }
    return null;
  }

  /** Using this tool at this station is a trip: always, or (trip 'writes') only when the tool changes things. */
  needsTrip(station: Station, tool: Pick<StationTool, 'readOnly'>): boolean {
    return station.trip === 'all' ? true : tool.readOnly !== true;
  }

  /** Whether this avatar is one of the station's characters. */
  appliesTo(station: Station, avatarId: string): boolean {
    return station.characters === 'all' || station.characters.includes(avatarId);
  }

  // -- Names for the model ------------------------------------------------------------------------

  /** Reads the names of the rooms and objects of all stations (call before a turn; cheap once cached). */
  async loadLabels(): Promise<void> {
    const read = this.options.describeRoom;
    if (!read) return;
    for (const roomId of new Set(this.list().map((station) => station.roomId))) {
      if (this.labels.has(roomId)) continue;
      try {
        this.labels.set(roomId, { room: await read(roomId) });
      } catch {
        this.labels.set(roomId, { room: null });
      }
    }
  }

  /** Forget the cached names (a room was edited). */
  clearLabels(): void {
    this.labels.clear();
  }

  /** The names of the room and the object, from what `loadLabels` read; the ids when not read. */
  labelsFor(station: Station): StationLabels {
    const room = this.labels.get(station.roomId)?.room ?? null;
    return {
      roomName: room?.name ?? station.roomId,
      objectName: room?.objects.find((object) => object.id === station.objectId)?.name ?? station.objectId,
    };
  }

  /** The stations with names and the resolved server, for the settings. */
  async views(): Promise<StationView[]> {
    await this.loadLabels();
    return this.list().map((station) => ({ ...station, ...this.labelsFor(station), serverId: this.resolveServerId(station.source) }));
  }

  /** " (kept on the bookshelf in the Reading room)", appended to the description the model sees. */
  descriptionNote(station: Station): string {
    const { roomName, objectName } = this.labelsFor(station);
    return ` (kept on the ${objectName} in the ${roomName})`;
  }

  private changed(): void {
    try {
      this.options.onChanged?.();
    } catch {
      /* A listener must not break saving. */
    }
  }
}
