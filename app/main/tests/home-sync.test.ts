import { describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { MemoryEngineError, type MemoryEngineHomeServer, type MemoryEngineHomeStatus } from '../src/memory-engine/client.js';
import { HomeServerSync, homeServersFor } from '../src/memory-engine/home-sync.js';

const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const status = (id: string): MemoryEngineHomeStatus => ({
  id,
  name: id,
  source: 'app',
  configured: true,
  connected: true,
  url: 'http://ha',
  label: null,
  watched: 1,
  events_today: 0,
  last_event_at: null,
  error: null,
  note: null,
});
const server = (id: string, token = 'secret-token'): MemoryEngineHomeServer => ({ id, name: id, url: `http://${id}:8123`, token });

describe('homeServersFor', () => {
  it('lists Home Assistant servers that have a token', () => {
    const routing = resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [
        { id: 'ha1', name: 'Penang', type: 'homeassistant', url: 'http://penang:8123/' },
        { id: 'ha2', name: 'SG', type: 'homeassistant', url: 'http://sg:8123' },
        { id: 'lm', type: 'chat', url: 'http://gpu:1234' },
      ],
    });
    const keys: Record<string, string> = { ha1: ' tok1 ', lm: 'chatkey' };
    expect(homeServersFor(routing, (id) => keys[id])).toEqual([{ id: 'ha1', name: 'Penang', url: 'http://penang:8123', token: 'tok1' }]);
  });
});

describe('HomeServerSync', () => {
  it('sends the servers once, and nothing when there are none', async () => {
    const client = { setHomeServers: vi.fn(async (s: MemoryEngineHomeServer[]) => s.map((x) => status(x.id))), homeStatus: vi.fn() };
    const sync = new HomeServerSync({ client, logger: logger() });
    await sync.apply([]);
    expect(client.setHomeServers).not.toHaveBeenCalled();
    await sync.apply([server('a')]);
    await sync.apply([server('a')]);
    expect(client.setHomeServers).toHaveBeenCalledTimes(1);
    await sync.apply([server('a'), server('b')]);
    expect(client.setHomeServers).toHaveBeenCalledTimes(2);
    await sync.apply([]);
    expect(client.setHomeServers).toHaveBeenLastCalledWith([]);
    sync.stop();
  });

  it('sends again when the engine lost a server, and not otherwise', async () => {
    const client = { setHomeServers: vi.fn(async () => []), homeStatus: vi.fn(async () => [status('a')]) };
    const sync = new HomeServerSync({ client, logger: logger() });
    await sync.apply([server('a')]);
    await sync.check();
    expect(client.setHomeServers).toHaveBeenCalledTimes(1);
    client.homeStatus.mockResolvedValue([status('other')]);
    await sync.check();
    expect(client.setHomeServers).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it('sends again when the engine was unreachable and then answers', async () => {
    const client = { setHomeServers: vi.fn(async () => []), homeStatus: vi.fn() };
    const sync = new HomeServerSync({ client, logger: logger() });
    await sync.apply([server('a')]);
    client.homeStatus.mockRejectedValueOnce(new MemoryEngineError('down', null, true));
    await sync.check();
    expect(client.setHomeServers).toHaveBeenCalledTimes(1);
    client.homeStatus.mockResolvedValueOnce([status('a')]);
    await sync.check();
    expect(client.setHomeServers).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it('retries while the engine is down and never logs the token', async () => {
    vi.useFakeTimers();
    try {
      const log = logger();
      const client = {
        setHomeServers: vi
          .fn<(s: MemoryEngineHomeServer[]) => Promise<MemoryEngineHomeStatus[]>>()
          .mockRejectedValueOnce(new MemoryEngineError('memory engine unreachable', null, true))
          .mockResolvedValue([status('a')]),
        homeStatus: vi.fn(),
      };
      const sync = new HomeServerSync({ client, logger: log, retryMs: 1000 });
      await sync.apply([server('a')]);
      expect(client.setHomeServers).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.setHomeServers).toHaveBeenCalledTimes(2);
      expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toContain('secret-token');
      sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a refusal', async () => {
    vi.useFakeTimers();
    try {
      const client = { setHomeServers: vi.fn(async () => Promise.reject(new MemoryEngineError('bad', 400, false))), homeStatus: vi.fn() };
      const sync = new HomeServerSync({ client, logger: logger(), retryMs: 1000 });
      await sync.apply([server('a')]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(client.setHomeServers).toHaveBeenCalledTimes(1);
      sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
