import { describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../src/config/config-manager.js';
import {
  builtInServers,
  databaseUrlWithPassword,
  defaultRoutes,
  resolveModelRouting,
  sanitizeStoredModels,
  splitDatabasePassword,
} from '../src/config/model-routing.js';
import { probeMemoryDatabase } from '../src/config/model-server-probe.js';
import { InMemoryPreferencesStore } from '../src/config/preferences-store.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { InMemorySecretStore } from '../src/config/secret-store.js';
import { MemoryEngineError, MemoryStorageSync, memoryStorageTargets } from '../src/memory-engine/index.js';

const SUPABASE = 'postgresql://postgres.abcd@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const builtIns = () => builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' });
const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('memory database routing', () => {
  it('keeps memory on this PC with no mirror until the user picks otherwise', () => {
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS));
    expect(routing.routes.memory).toEqual({ server: 'local-memory' });
    expect(routing.routes.memorymirror).toEqual({ server: '' });
    expect(routing.servers.find((server) => server.id === 'local-memory')).toMatchObject({ type: 'memory', managed: true });
    expect(memoryStorageTargets(routing, () => undefined)).toEqual({ database: null, mirror: null });
  });

  it('routes to an added database, puts its password back in for the engine only, and keeps the mirror off when asked', () => {
    const stored = sanitizeStoredModels({
      servers: [{ id: 'supa', type: 'memory', url: SUPABASE }],
      routes: { memory: { server: 'supa' }, memorymirror: { server: '' } },
    });
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), stored);
    expect(routing.routes.memory.server).toBe('supa');
    expect(routing.routes.memorymirror.server).toBe('');
    expect(memoryStorageTargets(routing, (id) => (id === 'supa' ? 'p@ss word' : undefined))).toEqual({
      database: 'postgresql://postgres.abcd:p%40ss%20word@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres',
      mirror: null,
    });
  });

  it('mirrors this PC’s memory to another database', () => {
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [{ id: 'supa', type: 'memory', url: SUPABASE }],
      routes: { memorymirror: { server: 'supa' } },
    });
    expect(memoryStorageTargets(routing, () => undefined)).toEqual({ database: null, mirror: SUPABASE });
  });

  it('does not let the built-in database be pointed elsewhere', () => {
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [{ id: 'local-memory', url: SUPABASE }],
    });
    expect(routing.servers.find((server) => server.id === 'local-memory')?.url).toBe('postgresql://127.0.0.1:5433/memory');
  });

  it('splits a password out of a pasted connection string, and puts it back', () => {
    expect(splitDatabasePassword('postgresql://postgres.abcd:s3cr%40t@db.example.com:5432/postgres/')).toEqual({
      url: 'postgresql://postgres.abcd@db.example.com:5432/postgres',
      password: 's3cr@t',
    });
    expect(splitDatabasePassword(SUPABASE)).toEqual({ url: SUPABASE });
    expect(databaseUrlWithPassword(SUPABASE, undefined)).toBe(SUPABASE);
    // A password already in the address wins.
    expect(databaseUrlWithPassword('postgresql://u:a@h/d', 'b')).toBe('postgresql://u:a@h/d');
  });
});

describe('ConfigManager memory databases', () => {
  it('saves the address without its password and keeps the password in the key store', async () => {
    const preferencesStore = new InMemoryPreferencesStore();
    const secretStore = new InMemorySecretStore();
    const config = new ConfigManager({ env: {}, preferencesStore, secretStore, logger: quiet });
    await config.load();
    const id = await config.saveModelServer({ name: 'Supabase', type: 'memory', url: 'postgresql://postgres.abcd:hunter2@db.example.com:5432/postgres' });
    await config.setModelRoute('memory', { server: id });
    expect(JSON.stringify(await preferencesStore.load())).not.toContain('hunter2');
    expect(config.getServerKey(id)).toBe('hunter2');
    expect(config.getModelRoutingView().servers.find((server) => server.id === id)).toMatchObject({
      url: 'postgresql://postgres.abcd@db.example.com:5432/postgres',
      hasKey: true,
    });
    await expect(config.saveModelServer({ type: 'memory', url: 'http://db.example.com' })).rejects.toThrow(/postgresql:\/\//);
    await expect(config.setModelRoute('llm', { server: id })).rejects.toThrow(/can't do this job/);
  });
});

describe('probeMemoryDatabase', () => {
  const engine = (overrides: Partial<{ health: () => Promise<{ database: string }>; testStorage: (url: string) => Promise<{ ok: boolean; error?: string }> }> = {}) => ({
    health: vi.fn(async () => ({ database: 'ready' })),
    testStorage: vi.fn(async () => ({ ok: true, version: '16.4' })),
    ...overrides,
  });

  it('asks the engine about its own database through its health', async () => {
    const tester = engine();
    expect((await probeMemoryDatabase({ url: 'x', local: true }, tester)).status).toBe('up');
    expect(tester.testStorage).not.toHaveBeenCalled();
  });

  it('has the engine test another database, and reports why it failed', async () => {
    const tester = engine({ testStorage: async () => ({ ok: false, error: 'the user name or password was refused' }) });
    expect(await probeMemoryDatabase({ url: SUPABASE, local: false }, tester)).toMatchObject({
      status: 'needs-key',
      message: 'The user name or password was refused.',
    });
    const noVector = engine({ testStorage: async () => ({ ok: false, error: 'the pgvector extension is not available there' }) });
    expect((await probeMemoryDatabase({ url: SUPABASE, local: false }, noVector)).status).toBe('error');
  });

  it('says so when memory is off or the engine is down', async () => {
    expect((await probeMemoryDatabase({ url: SUPABASE, local: false }, null)).message).toMatch(/turned off/);
    const down = engine({
      testStorage: async () => {
        throw new Error('fetch failed');
      },
    });
    expect((await probeMemoryDatabase({ url: SUPABASE, local: false }, down)).status).toBe('down');
  });
});

describe('MemoryStorageSync', () => {
  const view = { database: { local: true, where: 'this PC' }, mirror: null, moving: false };

  it('sends a change once, and nothing when it is unchanged', async () => {
    const setStorage = vi.fn(async () => view);
    const sync = new MemoryStorageSync({ client: { setStorage }, logger: quiet });
    await sync.apply({ database: null, mirror: null });
    await sync.apply({ database: null, mirror: null });
    await sync.apply({ database: null, mirror: SUPABASE });
    expect(setStorage.mock.calls).toEqual([[{ database: null, mirror: null }], [{ database: null, mirror: SUPABASE }]]);
    sync.stop();
  });

  it('keeps trying while the engine is down, but not after it refuses', async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const setStorage = vi.fn(async () => {
        if (!up) throw new MemoryEngineError('down', null, true);
        return view;
      });
      const sync = new MemoryStorageSync({ client: { setStorage }, logger: quiet, retryMs: 1000 });
      await sync.apply({ database: SUPABASE, mirror: null });
      expect(setStorage).toHaveBeenCalledTimes(1);
      up = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(setStorage).toHaveBeenCalledTimes(2);

      const refused = vi.fn(async () => {
        throw new MemoryEngineError('bad address', 400, false);
      });
      const strict = new MemoryStorageSync({ client: { setStorage: refused }, logger: quiet, retryMs: 1000 });
      await strict.apply({ database: 'postgresql://x/y', mirror: null });
      await vi.advanceTimersByTimeAsync(5000);
      expect(refused).toHaveBeenCalledTimes(1);
      sync.stop();
      strict.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
