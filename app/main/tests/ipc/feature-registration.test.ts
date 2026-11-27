import { describe, expect, it, vi } from 'vitest';
import { createHandleIpc, getIpcHandler, type HandleIpc } from '../../src/ipc/handle-ipc.js';
import { registerMetricsIpc } from '../../src/metrics/ipc.js';
import { registerConversationIpc } from '../../src/conversation/ipc.js';
import { registerStationsIpc } from '../../src/stations/ipc.js';
import { registerPresenceIpc } from '../../src/presence/ipc.js';
import { PlacePresence } from '../../src/presence/place-presence.js';

type Listener = (event: unknown, ...args: unknown[]) => unknown;

function fakeHandle() {
  const handlers = new Map<string, Listener>();
  const handle: HandleIpc = (channel, listener) => {
    handlers.set(channel, listener as Listener);
  };
  return { handle, handlers };
}

describe('createHandleIpc', () => {
  it('gives Electron the handler and remembers it for the room hub', () => {
    const ipcMain = { handle: vi.fn() };
    const handle = createHandleIpc(ipcMain);
    const listener = () => 'pong';

    handle('test:ping', listener);

    expect(ipcMain.handle).toHaveBeenCalledWith('test:ping', listener);
    expect(getIpcHandler('test:ping')).toBe(listener);
  });
});

describe('feature IPC registration', () => {
  it('registers a feature on the handle it is given, with its own dependencies', async () => {
    const { handle, handlers } = fakeHandle();
    const observeLatency = vi.fn();
    registerMetricsIpc({
      handle,
      metrics: { observeLatency } as never,
    });
    registerConversationIpc({ handle, conversation: null });

    expect([...handlers.keys()].sort()).toEqual([
      'conversation:announce',
      'conversation:append-message',
      'conversation:get-history',
      'metrics:observe-latency',
    ]);
    expect(handlers.get('metrics:observe-latency')?.({}, { metric: 'turn', valueMs: 12 })).toBe(
      true,
    );
    expect(observeLatency).toHaveBeenCalledWith('turn', 12);
    expect(() => handlers.get('conversation:get-history')?.({})).toThrow(
      'Conversation manager is not initialized.',
    );
  });

  it('reads late-created services through getters', () => {
    const { handle, handlers } = fakeHandle();
    let registry: { views: () => string[] } | null = null;
    registerStationsIpc({
      handle,
      stationRegistry: () => registry as never,
      stationTrips: () => null,
    });

    expect(() => handlers.get('stations:list')?.({})).toThrow('Stations are unavailable.');
    registry = { views: () => ['bookshelf'] };
    expect(handlers.get('stations:list')?.({})).toEqual(['bookshelf']);
  });

  it('keeps bija’s presence apart from a desktop room’s', () => {
    const { handle, handlers } = fakeHandle();
    const placePresence = new PlacePresence();
    const update = vi.spyOn(placePresence, 'update');
    registerPresenceIpc({
      handle,
      presence: {} as never,
      placePresence,
      placeOf: (event) => (event as { placeId?: string }).placeId ?? 'home',
      localPlaceId: () => 'home',
    });

    expect(handlers.get('presence:update')?.({ placeId: 'office' }, { listening: true })).toBe(
      true,
    );
    expect(update).toHaveBeenCalledWith('office', { listening: true });
  });
});
