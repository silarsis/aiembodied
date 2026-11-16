import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundControls } from '../../src/backgrounds/background-controls.js';
import { useBackgrounds } from '../../src/backgrounds/use-backgrounds.js';
import type { BackgroundBridge } from '../../../main/src/backgrounds/types.js';
import type { StationView } from '../../../main/src/stations/types.js';
import type { McpBridge, StationsBridge } from '../../src/preload-api.js';
import { builtInRoom } from '../rooms/fixtures.js';

const reading = builtInRoom('reading-room');

const papersStation: StationView = {
  id: 'default:dair-academy-papers',
  roomId: reading.id,
  objectId: 'bookshelf',
  source: { kind: 'mcp', preset: 'dair-academy-papers' },
  verb: 'read',
  activity: 'pulls a book from the shelf and reads',
  trip: 'all',
  characters: 'all',
  serverId: 'dair',
  roomName: 'Reading room',
  objectName: 'bookshelf',
};

function Harness({ api, stations, mcp }: { api: BackgroundBridge; stations?: StationsBridge; mcp?: McpBridge }) {
  const state = useBackgrounds(api);
  return <BackgroundControls backgrounds={state} stations={stations} mcp={mcp} />;
}

function bridges(list: StationView[] = [papersStation]) {
  const api = {
    list: vi.fn().mockResolvedValue([]),
    getActive: vi.fn().mockResolvedValue(reading.id),
    setActive: vi.fn(),
    load: vi.fn().mockResolvedValue(''),
    listRooms: vi.fn().mockResolvedValue([{ id: reading.id, name: 'Reading room', builtIn: true }]),
    loadRoom: vi.fn().mockResolvedValue(reading),
    getIdleSettings: vi.fn().mockResolvedValue({ enabled: true, restlessness: 'normal', onTalk: 'turn', avatarHeight: 1.6 }),
    setIdleSettings: vi.fn(),
    getObjectSettings: vi.fn().mockResolvedValue({ enabled: true, maxPerRoom: 3, available: true }),
    setObjectSettings: vi.fn(),
    listGeneratedObjects: vi.fn().mockResolvedValue([]),
    getMakingRoom: vi.fn().mockResolvedValue(null),
    onRoomProgress: vi.fn().mockReturnValue(() => undefined),
    onRoomUpdated: vi.fn().mockReturnValue(() => undefined),
  } as unknown as BackgroundBridge;
  const stations = {
    list: vi.fn().mockResolvedValue(list),
    hold: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(true),
    onUse: vi.fn().mockReturnValue(() => undefined),
    arrived: vi.fn().mockResolvedValue(undefined),
  } satisfies StationsBridge;
  const mcp = {
    listServers: vi.fn().mockResolvedValue([
      { id: 'dair', name: 'DAIR Academy papers' },
      { id: 'ha', name: 'Home Assistant' },
    ]),
  } as unknown as McpBridge;
  return { api, stations, mcp };
}

describe('Things kept in the room', () => {
  it('shows each walkable object with what it holds, and the trip choice for one that holds something', async () => {
    const { api, stations, mcp } = bridges();
    render(<Harness api={api} stations={stations} mcp={mcp} />);
    const bookshelf = (await screen.findByLabelText('What the bookshelf holds')) as HTMLSelectElement;
    await waitFor(() => expect(bookshelf.value).toBe('mcp:dair'));
    expect(Array.from(bookshelf.options).map((option) => option.textContent)).toEqual(['None', 'DAIR Academy papers', 'Home Assistant', 'Web search']);
    expect(screen.getByLabelText('What the sofa holds')).toHaveValue('none');
    expect(screen.getByLabelText('When to walk to the bookshelf')).toHaveValue('all');
    // Only objects that hold something show the trip choice.
    expect(screen.queryByLabelText('When to walk to the sofa')).toBeNull();
    // An object with nowhere to stand is not offered.
    expect(screen.queryByLabelText('What the rug holds')).toBeNull();
  });

  it('makes an object hold a server, and clears it with None', async () => {
    const { api, stations, mcp } = bridges([]);
    render(<Harness api={api} stations={stations} mcp={mcp} />);
    fireEvent.change(await screen.findByLabelText('What the sofa holds'), { target: { value: 'mcp:ha' } });
    await waitFor(() =>
      expect(stations.hold).toHaveBeenCalledWith(reading.id, 'sofa', { kind: 'mcp', serverId: 'ha' }, { verb: 'use', activity: 'uses the sofa' }),
    );
    fireEvent.change(screen.getByLabelText('What the sofa holds'), { target: { value: 'builtin:web_search' } });
    await waitFor(() =>
      expect(stations.hold).toHaveBeenCalledWith(reading.id, 'sofa', { kind: 'builtin', toolNames: ['web_search'] }, expect.anything()),
    );
  });

  it('keeps the activity of an object that already holds something, and clears with None', async () => {
    const { api, stations, mcp } = bridges();
    render(<Harness api={api} stations={stations} mcp={mcp} />);
    const bookshelf = await screen.findByLabelText('What the bookshelf holds');
    await waitFor(() => expect(bookshelf).toHaveValue('mcp:dair'));
    fireEvent.change(bookshelf, { target: { value: 'mcp:ha' } });
    await waitFor(() => expect(stations.hold).toHaveBeenCalledWith(reading.id, 'bookshelf', { kind: 'mcp', serverId: 'ha' }, {}));
    fireEvent.change(bookshelf, { target: { value: 'none' } });
    await waitFor(() => expect(stations.hold).toHaveBeenLastCalledWith(reading.id, 'bookshelf', null, {}));
  });

  it("saves 'Every use' or 'Only changes'", async () => {
    const { api, stations, mcp } = bridges();
    render(<Harness api={api} stations={stations} mcp={mcp} />);
    const trip = await screen.findByLabelText('When to walk to the bookshelf');
    fireEvent.change(trip, { target: { value: 'writes' } });
    await waitFor(() => expect(stations.update).toHaveBeenCalledWith(papersStation.id, { trip: 'writes' }));
    expect(Array.from((trip as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(['Every use', 'Only changes']);
  });

  it('is not shown without the stations bridge', async () => {
    const { api } = bridges();
    render(<Harness api={api} />);
    await screen.findByText('When idle');
    expect(screen.queryByText('Things kept in the room')).toBeNull();
  });
});
