import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import type { MCPServerSummary } from '../../../main/src/mcp/types.js';
import type { Station, StationBody, StationSource, StationView } from '../../../main/src/stations/types.js';
import type { McpBridge, StationsBridge } from '../preload-api.js';
import type { BackgroundController } from './use-backgrounds.js';

/** The built-in web search, which can also live at an object. */
const WEB_SEARCH_VALUE = 'builtin:web_search';
const WEB_SEARCH_SOURCE: StationSource = { kind: 'builtin', toolNames: ['web_search'] };

/** The value of the "Holds" dropdown for a station (or 'none'). */
export function holdsValue(station: StationView | undefined): string {
  if (!station) return 'none';
  if (station.source.kind === 'builtin') return WEB_SEARCH_VALUE;
  const serverId = station.serverId ?? station.source.serverId;
  return serverId ? `mcp:${serverId}` : 'none';
}

/**
 * "Things kept in rooms": pick a room, and for each object you can walk to, say what it holds. A server that is
 * kept on the bookshelf makes the avatar walk to the bookshelf whenever it uses that server's tools.
 */
export function RoomStations({
  backgrounds,
  stations,
  mcp,
}: {
  backgrounds: BackgroundController;
  stations?: StationsBridge;
  mcp?: McpBridge;
}) {
  const { rooms, loadRoom, activeId } = backgrounds;
  const [roomId, setRoomId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomFile | null>(null);
  const [servers, setServers] = useState<MCPServerSummary[]>([]);
  const [list, setList] = useState<StationView[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The room being edited: the one picked here, else the one on stage, else the first.
  const shownId = roomId ?? (rooms.some((entry) => entry.id === activeId) ? activeId : null) ?? rooms[0]?.id ?? null;

  const reload = useCallback(async () => {
    if (!stations) return;
    const [nextList, nextServers] = await Promise.all([stations.list().catch(() => [] as StationView[]), mcp?.listServers().catch(() => [] as MCPServerSummary[]) ?? []]);
    setList(nextList);
    setServers(nextServers);
  }, [stations, mcp]);

  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    if (!shownId) return undefined;
    loadRoom(shownId)
      .then((loaded) => {
        if (!cancelled) setRoom(loaded);
      })
      .catch(() => {
        if (!cancelled) setRoom(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shownId, loadRoom]);

  // Only objects an avatar can stand at can hold something.
  const objects = useMemo(() => (room && room.id === shownId ? room.objects.filter((object) => object.tags?.stand) : []), [room, shownId]);

  // What a reading character can sit on, and what it can take from the object.
  const seats = useMemo(() => (room && room.id === shownId ? room.objects.filter((object) => object.tags?.sit) : []), [room, shownId]);
  const takeable = useMemo(() => (room && room.id === shownId ? room.objects.filter((object) => object.dynamic === true && object.tags?.grab) : []), [room, shownId]);

  if (!stations) return null;

  const stationAt = (objectId: string): StationView | undefined => list.find((station) => station.roomId === shownId && station.objectId === objectId);

  const save = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Couldn’t save that.');
    }
    await reload();
  };

  const changeHolds = (objectName: string, objectId: string, value: string) => {
    if (!shownId) return;
    const source: StationSource | null =
      value === 'none' ? null : value === WEB_SEARCH_VALUE ? WEB_SEARCH_SOURCE : { kind: 'mcp', serverId: value.slice('mcp:'.length) };
    const existing = stationAt(objectId);
    // A new station gets a plain activity; an existing one keeps what it had.
    const extra: Partial<Pick<Station, 'activity' | 'verb'>> = existing ? {} : { verb: 'use', activity: `uses the ${objectName}` };
    void save(() => stations.hold(shownId, objectId, source, extra));
  };

  /** Set one part of a station's body plan ('' clears it); the gestures it already has are kept. */
  const changeBody = (station: StationView, key: 'seat' | 'prop', value: string) => {
    const body: StationBody = { ...(station.body ?? {}) };
    if (value) body[key] = value;
    else delete body[key];
    void save(() => stations.update(station.id, { body }));
  };

  return (
    <section className="backgroundControls__idle" aria-labelledby="room-stations-title">
      <h3 id="room-stations-title">Things kept in the room</h3>
      <p className="kiosk__helper">
        Choose what an object holds. When a character uses a tool that is kept there, it walks to the object while the tool runs.
      </p>
      {rooms.length > 1 ? (
        <div className="control">
          <label htmlFor="stations-room">Room</label>
          <select id="stations-room" value={shownId ?? ''} onChange={(event) => setRoomId(event.target.value)}>
            {rooms.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {objects.length === 0 ? <p className="kiosk__helper">This room has no objects to walk to.</p> : null}
      <ul className="toolsSettings__list" aria-label="Objects in the room">
        {objects.map((object) => {
          const station = stationAt(object.id);
          return (
            <li key={object.id} className="toolsSettings__tool">
              <strong>{object.name}</strong>
              <label>
                Holds{' '}
                <select
                  aria-label={`What the ${object.name} holds`}
                  value={holdsValue(station)}
                  onChange={(event) => changeHolds(object.name, object.id, event.target.value)}
                >
                  <option value="none">None</option>
                  {servers.map((server) => (
                    <option key={server.id} value={`mcp:${server.id}`}>
                      {server.name}
                    </option>
                  ))}
                  <option value={WEB_SEARCH_VALUE}>Web search</option>
                </select>
              </label>
              {station ? (
                <label>
                  Walk over{' '}
                  <select
                    aria-label={`When to walk to the ${object.name}`}
                    value={station.trip}
                    onChange={(event) => void save(() => stations.update(station.id, { trip: event.target.value as 'all' | 'writes' }))}
                  >
                    <option value="all">Every use</option>
                    <option value="writes">Only changes</option>
                  </select>
                </label>
              ) : null}
              {station ? (
                <label>
                  Read at{' '}
                  <select
                    aria-label={`Where to read what is kept on the ${object.name}`}
                    value={station.body?.seat ?? ''}
                    onChange={(event) => changeBody(station, 'seat', event.target.value)}
                  >
                    <option value="">Stay standing</option>
                    {seats.map((seat) => (
                      <option key={seat.id} value={seat.id}>
                        {seat.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {station ? (
                <label>
                  Take{' '}
                  <select
                    aria-label={`What to take from the ${object.name}`}
                    value={station.body?.prop ?? ''}
                    onChange={(event) => changeBody(station, 'prop', event.target.value)}
                  >
                    <option value="">Nothing</option>
                    {takeable.map((prop) => (
                      <option key={prop.id} value={prop.id}>
                        {prop.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
