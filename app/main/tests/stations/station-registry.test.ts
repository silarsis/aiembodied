import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STATIONS,
  HOME_ASSISTANT_DEFAULT_ID,
  READING_ROOM_ID,
  STUDIO_FLAT_ROOM_ID,
  STATIONS_KEY,
  StationRegistry,
  type StationServer,
} from '../../src/stations/station-registry.js';
import type { StationTool } from '../../src/stations/types.js';

const PAPERS_URL = 'https://academy.dair.ai/api/mcp';

function setup(
  options: { servers?: StationServer[]; tools?: StationTool[]; kv?: Record<string, string> } = {},
) {
  const kv = new Map<string, string>(Object.entries(options.kv ?? {}));
  const servers = { current: options.servers ?? [] };
  const tools = options.tools ?? [];
  const onChanged = vi.fn();
  const registry = new StationRegistry({
    store: {
      getValue: (key) => kv.get(key) ?? null,
      setValue: (key, value) => void kv.set(key, value),
    },
    servers: () => servers.current,
    tools: { get: (id) => tools.find((tool) => tool.id === id) },
    describeRoom: async (roomId) =>
      roomId === READING_ROOM_ID
        ? {
            name: 'Reading room',
            objects: [
              { id: 'bookshelf', name: 'bookshelf' },
              { id: 'sofa', name: 'sofa' },
            ],
          }
        : null,
    onChanged,
  });
  return { registry, kv, servers, onChanged };
}

const papersTool: StationTool = {
  id: 'srv-1:search_papers',
  serverId: 'srv-1',
  toolName: 'search_papers',
  readOnly: true,
};
const writeTool: StationTool = { id: 'srv-1:save_note', serverId: 'srv-1', toolName: 'save_note' };
const webSearch: StationTool = {
  id: 'builtin:web_search',
  serverId: 'builtin',
  toolName: 'web_search',
  readOnly: true,
};

describe('StationRegistry', () => {
  describe('default bookshelf', () => {
    it('has no stations until the papers server exists', () => {
      const { registry } = setup();
      expect(registry.list()).toEqual([]);
    });

    it('puts the papers preset on the Reading room bookshelf once its server exists (matched by address)', () => {
      const { registry, kv } = setup({ servers: [{ id: 'srv-1', httpUrl: `${PAPERS_URL}/` }] });
      const [station] = registry.list();
      expect(station).toMatchObject({
        roomId: READING_ROOM_ID,
        objectId: 'bookshelf',
        source: { kind: 'mcp', preset: 'dair-academy-papers' },
        verb: 'read',
        activity: 'pulls a book from the shelf and reads',
        trip: 'all',
        characters: 'all',
        body: {
          prop: 'book',
          seat: 'armchair',
          browse: 'runs a finger along the book spines',
          read: 'reads a book, turning a page now and then',
          note: 'pauses and jots something down',
        },
      });
      // Saved, so Kevin's later changes build on it.
      expect(JSON.parse(kv.get(STATIONS_KEY) ?? '{}').stations).toHaveLength(1);
      expect(registry.stationForTool(papersTool)?.id).toBe(DEFAULT_STATIONS[0].id);
    });

    it('gives a default saved before bodies existed the default body, and keeps a body Kevin changed (even an empty one)', () => {
      const old = { ...DEFAULT_STATIONS[0], body: undefined };
      const { registry, kv } = setup({
        servers: [{ id: 'srv-1', httpUrl: PAPERS_URL }],
        kv: { [STATIONS_KEY]: JSON.stringify({ stations: [old], removedDefaults: [] }) },
      });
      expect(registry.list()[0].body?.seat).toBe('armchair');
      registry.update(DEFAULT_STATIONS[0].id, { body: { read: '  reads {slowly} ' } });
      expect(registry.list()[0].body).toEqual({ read: 'reads slowly' });
      registry.update(DEFAULT_STATIONS[0].id, { body: {} });
      expect(registry.list()[0].body).toEqual({});
      expect(JSON.parse(kv.get(STATIONS_KEY) ?? '{}').stations[0].body).toEqual({});
    });

    it('does not add it when another station already holds that server', () => {
      const { registry } = setup({ servers: [{ id: 'srv-1', httpUrl: PAPERS_URL }] });
      registry.hold('room:abc', 'desk', { kind: 'mcp', serverId: 'srv-1' });
      expect(registry.list().map((s) => [s.roomId, s.objectId])).toEqual([['room:abc', 'desk']]);
    });

    it('stays removed after Kevin removes it', () => {
      const { registry } = setup({ servers: [{ id: 'srv-1', httpUrl: PAPERS_URL }] });
      const [station] = registry.list();
      expect(registry.remove(station.id)).toBe(true);
      expect(registry.list()).toEqual([]);
    });
  });

  describe('stationForTool', () => {
    it('finds a station by server id, by preset address, and by built-in tool name', () => {
      const { registry } = setup({
        servers: [{ id: 'srv-1', httpUrl: PAPERS_URL }, { id: 'srv-2' }],
        tools: [papersTool, webSearch],
      });
      registry.hold('room:a', 'desk', { kind: 'mcp', serverId: 'srv-2' });
      registry.hold('room:a', 'terminal', WEB);
      expect(registry.stationForTool('srv-1:search_papers')?.objectId).toBe('bookshelf');
      expect(
        registry.stationForTool({ id: 'srv-2:x', serverId: 'srv-2', toolName: 'x' })?.objectId,
      ).toBe('desk');
      expect(registry.stationForTool('builtin:web_search')?.objectId).toBe('terminal');
      expect(
        registry.stationForTool({ id: 'other:y', serverId: 'other', toolName: 'y' }),
      ).toBeNull();
      expect(registry.stationForTool('missing:tool')).toBeNull();
    });

    it('does not match an MCP tool of a server that is not added', () => {
      const { registry } = setup();
      registry.add({
        roomId: 'room:a',
        objectId: 'desk',
        source: { kind: 'mcp', preset: 'dair-academy-papers' },
      });
      expect(registry.stationForTool(papersTool)).toBeNull();
    });
  });

  describe('needsTrip and appliesTo', () => {
    it("trip 'all' is always a trip; 'writes' only for a tool that is not read-only", () => {
      const { registry } = setup({ servers: [{ id: 'srv-1', httpUrl: PAPERS_URL }] });
      const [station] = registry.list();
      expect(registry.needsTrip(station, papersTool)).toBe(true);
      expect(registry.needsTrip(station, writeTool)).toBe(true);
      const writes = registry.update(station.id, { trip: 'writes' });
      expect(registry.needsTrip(writes!, papersTool)).toBe(false);
      expect(registry.needsTrip(writes!, writeTool)).toBe(true);
      expect(registry.needsTrip(writes!, {})).toBe(true);
    });

    it('limits a station to the characters it names', () => {
      const { registry } = setup({ servers: [{ id: 'srv-1', httpUrl: PAPERS_URL }] });
      const [station] = registry.list();
      expect(registry.appliesTo(station, 'sage')).toBe(true);
      const only = registry.update(station.id, { characters: ['sage'] })!;
      expect(registry.appliesTo(only, 'sage')).toBe(true);
      expect(registry.appliesTo(only, 'echo')).toBe(false);
    });
  });

  describe('changing stations', () => {
    it('adds, updates and removes, telling the listener each time', () => {
      const { registry, onChanged } = setup({ servers: [{ id: 'srv-2' }] });
      const added = registry.add({
        roomId: 'room:a',
        objectId: 'desk',
        source: { kind: 'mcp', serverId: 'srv-2' },
        activity: 'types',
      });
      expect(added).toMatchObject({
        verb: 'use',
        trip: 'all',
        characters: 'all',
        activity: 'types',
      });
      expect(registry.update(added.id, { activity: 'writes' })?.activity).toBe('writes');
      expect(registry.update('nope', {})).toBeNull();
      expect(registry.remove(added.id)).toBe(true);
      expect(registry.remove(added.id)).toBe(false);
      expect(onChanged).toHaveBeenCalledTimes(3);
    });

    it('rejects a station without anything to hold', () => {
      const { registry } = setup();
      expect(() =>
        registry.add({ roomId: 'room:a', objectId: 'desk', source: { kind: 'mcp' } }),
      ).toThrow();
    });

    it('hold() moves a server to a new object, and clears an object with null', () => {
      const { registry } = setup({ servers: [{ id: 'srv-2' }] });
      registry.hold('room:a', 'desk', { kind: 'mcp', serverId: 'srv-2' }, { trip: 'writes' });
      registry.hold('room:a', 'shelf', { kind: 'mcp', serverId: 'srv-2' });
      expect(registry.list().map((s) => s.objectId)).toEqual(['shelf']);
      expect(registry.hold('room:a', 'shelf', null)).toBeNull();
      expect(registry.list()).toEqual([]);
    });

    it('hold() keeps the trip setting of an object when only the source changes', () => {
      const { registry } = setup({ servers: [{ id: 'srv-2' }, { id: 'srv-3' }] });
      registry.hold('room:a', 'desk', { kind: 'mcp', serverId: 'srv-2' }, { trip: 'writes' });
      const next = registry.hold('room:a', 'desk', { kind: 'mcp', serverId: 'srv-3' });
      expect(next).toMatchObject({ trip: 'writes', source: { serverId: 'srv-3' } });
    });

    it('ignores damaged saved data', () => {
      const { registry } = setup({
        kv: { [STATIONS_KEY]: '{"stations":[1,{"id":"x"}],"removedDefaults":"no"}' },
      });
      expect(registry.list()).toEqual([]);
      expect(setup({ kv: { [STATIONS_KEY]: 'not json' } }).registry.list()).toEqual([]);
    });
  });

  describe('names for the model', () => {
    it('words the description note with the object and room names', async () => {
      const { registry } = setup({ servers: [{ id: 'srv-1', httpUrl: PAPERS_URL }] });
      const [station] = registry.list();
      // Before the names are read, the ids stand in.
      expect(registry.descriptionNote(station)).toBe(
        ' (kept on the bookshelf in the room:builtin:reading-room)',
      );
      await registry.loadLabels();
      expect(registry.descriptionNote(station)).toBe(
        ' (kept on the bookshelf in the Reading room)',
      );
      expect(await registry.views()).toEqual([
        expect.objectContaining({
          serverId: 'srv-1',
          roomName: 'Reading room',
          objectName: 'bookshelf',
        }),
      ]);
    });
  });
});

describe('StationRegistry Home Assistant home panel', () => {
  const home1: StationServer = {
    id: 'ha-1',
    httpUrl: 'http://homeassistant-1:8123/api/mcp',
    homeAssistant: true,
  };
  const home2: StationServer = {
    id: 'ha-2',
    httpUrl: 'http://sg.local:8123/api/mcp',
    homeAssistant: true,
  };

  it('puts the first Home Assistant server on the Studio flat home panel: changes walk, reads do not', () => {
    const { registry } = setup({ servers: [home1, home2] });
    const stations = registry.list();
    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({
      id: HOME_ASSISTANT_DEFAULT_ID,
      roomId: STUDIO_FLAT_ROOM_ID,
      objectId: 'home-panel',
      source: { kind: 'mcp', serverId: 'ha-1' },
      verb: 'use',
      activity: 'taps at the home panel',
      trip: 'writes',
      pursuit: 'none',
    });
    expect(registry.needsTrip(stations[0], { readOnly: true })).toBe(false);
    expect(registry.needsTrip(stations[0], { readOnly: false })).toBe(true);
    // The second home waits for the Holds picker (a station is one object and one source).
    expect(
      registry.stationForTool({
        id: 'ha-2:GetLiveContext',
        serverId: 'ha-2',
        toolName: 'GetLiveContext',
      }),
    ).toBeNull();
  });

  it('does nothing without a Home Assistant server, or when a station already holds it', () => {
    expect(setup({ servers: [{ id: 'srv-2' }] }).registry.list()).toEqual([]);
    const { registry } = setup({ servers: [home1] });
    registry.hold('room:builtin:reading-room', 'home-panel', { kind: 'mcp', serverId: 'ha-1' });
    expect(registry.list().map((s) => s.roomId)).toEqual(['room:builtin:reading-room']);
    expect(registry.list()[0].pursuit).toBe('none');
  });

  it('moves on to the next home when its server is deleted, and stays removed once removed', () => {
    const { registry, servers } = setup({ servers: [home1, home2] });
    registry.list();
    servers.current = [home2];
    expect(registry.list()[0].source).toEqual({ kind: 'mcp', serverId: 'ha-2' });
    registry.remove(HOME_ASSISTANT_DEFAULT_ID);
    expect(registry.list()).toEqual([]);
  });

  it('lets another home sit on another panel with the Holds picker', () => {
    const { registry } = setup({ servers: [home1, home2] });
    registry.list();
    const second = registry.hold(
      'room:builtin:reading-room',
      'home-panel',
      { kind: 'mcp', serverId: 'ha-2' },
      { trip: 'writes' },
    );
    expect(second).toMatchObject({ trip: 'writes', pursuit: 'none' });
    expect(registry.list()).toHaveLength(2);
  });
});

const WEB = { kind: 'builtin', toolNames: ['web_search'] } as const;
