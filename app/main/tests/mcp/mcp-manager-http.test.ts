import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { MCPManager } from '../../src/mcp/mcp-manager.js';
import { McpOAuthStore } from '../../src/mcp/clients/oauth-provider.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { DAIR_ACADEMY_PAPERS_PRESET_ID } from '../../src/mcp/presets.js';

/**
 * Manager behaviour that needs fake clients: tool names, needs-sign-in, reconnects, crashes, presets, sign-in.
 * The client classes are replaced; the OAuth provider and its callback listener are the real ones.
 */

type Tool = { name: string; description?: string; inputSchema: unknown };

// What each fake client does. Tests change these before connecting.
const state = vi.hoisted(() => ({
  tools: [] as Tool[],
  clients: [] as Array<{ url: string; auth: any; disconnect: any; callTool: any; closed?: () => void }>,
  httpConnect: null as null | ((auth: any) => Promise<void>),
  stdioConnect: null as null | (() => Promise<void>),
  finishAuth: null as null | ((code: string) => Promise<void>),
}));

function makeFake(url: string, auth: any, connect: (() => Promise<void>) | null) {
  const fake = {
    url,
    auth,
    connect: vi.fn(async () => {
      if (connect) await connect();
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn(async () => state.tools),
    callTool: vi.fn().mockResolvedValue('ok'),
    finishAuth: vi.fn(async (code: string) => state.finishAuth?.(code)),
    onToolsChanged: vi.fn(),
    closed: undefined as undefined | (() => void),
    onClosed(cb: () => void) {
      fake.closed = cb;
    },
  };
  state.clients.push(fake);
  return fake;
}

vi.mock('../../src/mcp/clients/sse-client.js', () => ({
  SSEMCPClient: vi.fn().mockImplementation(function (url: string) {
    return makeFake(url, undefined, null);
  }),
}));
vi.mock('../../src/mcp/clients/stdio-client.js', () => ({
  StdioMCPClient: vi.fn().mockImplementation(function (command: string) {
    return makeFake(command, undefined, () => state.stdioConnect?.() ?? Promise.resolve());
  }),
}));
vi.mock('../../src/mcp/clients/http-client.js', () => ({
  HTTPMCPClient: vi.fn().mockImplementation(function (url: string, auth: any) {
    return makeFake(url, auth, () => state.httpConnect?.(auth) ?? Promise.resolve());
  }),
}));
vi.mock('../../src/mcp/encryption.js', () => ({
  encryptToken: vi.fn((token: string) => `encrypted:${token}`),
  decryptToken: vi.fn((encrypted: string) => encrypted.replace('encrypted:', '')),
}));

const SCHEMA = `
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, transport_type TEXT NOT NULL,
    sse_url TEXT, sse_auth_header TEXT, sse_auth_token_encrypted TEXT,
    stdio_command TEXT, stdio_args_json TEXT, stdio_env_json_encrypted TEXT,
    http_url TEXT, http_auth_header TEXT, http_auth_token_encrypted TEXT,
    oauth INTEGER NOT NULL DEFAULT 0, oauth_scope TEXT,
    enabled INTEGER DEFAULT 1, auto_start INTEGER DEFAULT 0,
    connection_status TEXT DEFAULT 'disconnected', last_error TEXT,
    tools_discovered INTEGER DEFAULT 0, last_connected_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_tools (
    id TEXT PRIMARY KEY, server_id TEXT NOT NULL, tool_name TEXT NOT NULL, display_name TEXT,
    description TEXT, input_schema_json TEXT NOT NULL, enabled INTEGER DEFAULT 1,
    confirmation_level TEXT DEFAULT 'none', custom_description TEXT,
    discovered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_oauth (
    server_id TEXT PRIMARY KEY, client_info_encrypted TEXT, tokens_encrypted TEXT,
    code_verifier_encrypted TEXT, updated_at INTEGER NOT NULL
  );
`;

const tool = (name: string): Tool => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object', properties: {} } });

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe('MCPManager (stdio, http, OAuth)', () => {
  let db: Database;
  let dir: string;
  let registry: ToolRegistry;
  let manager: MCPManager;
  let port: number;
  const openExternal = vi.fn();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-http-test-'));
    db = new DatabaseConstructor(join(dir, 'test.db'));
    db.exec(SCHEMA);
    state.tools = [];
    state.clients = [];
    state.httpConnect = null;
    state.stdioConnect = null;
    state.finishAuth = null;
    openExternal.mockReset();
    openExternal.mockResolvedValue(undefined);
    port = await freePort();
    registry = new ToolRegistry();
    manager = new MCPManager(db, registry, { openExternal, oauthCallbackPort: port, oauthTimeoutMs: 2000 });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const addSse = (name: string) =>
    manager.addServer({ name, transportType: 'sse', sseUrl: `https://${name.replace(/\W/g, '')}.example/sse`, enabled: true, autoStart: false });

  describe('tool names for the assistant', () => {
    it('replaces invalid characters and still calls the server with the original name', async () => {
      state.tools = [tool('search.papers v2')];
      const server = await addSse('Papers');
      await manager.connectServer(server.id);

      const registered = registry.list();
      expect(registered).toHaveLength(1);
      expect(registered[0].toolName).toBe('search_papers_v2');
      expect(registered[0].toolName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

      await registry.execute(registered[0].id, { q: 1 });
      expect(state.clients[0].callTool).toHaveBeenCalledWith('search.papers v2', { q: 1 });
      expect(manager.listTools(server.id)[0]).toMatchObject({ toolName: 'search.papers v2', llmName: 'search_papers_v2' });
    });

    it('prefixes with the server name when a built-in tool has the same name', async () => {
      registry.register({
        id: 'builtin:web_search', serverId: 'builtin', toolName: 'web_search', description: '', inputSchema: {},
        enabled: true, confirmationLevel: 'none', execute: async () => null,
      });
      state.tools = [tool('web_search')];
      const server = await addSse('DAIR Academy');
      await manager.connectServer(server.id);

      const names = registry.list().map((t) => t.toolName).sort();
      expect(names).toEqual(['dair_academy__web_search', 'web_search']);
    });

    it('prefixes when another server already has the name, and truncates to 64', async () => {
      state.tools = [tool('search_papers')];
      const first = await addSse('First');
      const second = await addSse('Second');
      await manager.connectServer(first.id);
      await manager.connectServer(second.id);
      expect(registry.list().map((t) => t.toolName).sort()).toEqual(['search_papers', 'second__search_papers']);

      const long = 'x'.repeat(80);
      state.tools = [tool(long)];
      const third = await addSse('Third');
      await manager.connectServer(third.id);
      const thirdTool = registry.list().find((t) => t.serverId === third.id);
      expect(thirdTool?.toolName).toBe('x'.repeat(64));
      expect(thirdTool?.toolName.length).toBeLessThanOrEqual(64);
    });

    it('keeps the same name when a server reconnects', async () => {
      state.tools = [tool('search_papers')];
      const first = await addSse('First');
      const second = await addSse('Second');
      await manager.connectServer(first.id);
      await manager.connectServer(second.id);
      await manager.connectServer(second.id);
      expect(registry.list().map((t) => t.toolName).sort()).toEqual(['search_papers', 'second__search_papers']);
    });
  });

  describe('connecting', () => {
    it('disconnects the old client when a connected server is connected again', async () => {
      state.tools = [tool('a')];
      const server = await addSse('One');
      await manager.connectServer(server.id);
      await manager.connectServer(server.id);

      expect(state.clients).toHaveLength(2);
      expect(state.clients[0].disconnect).toHaveBeenCalled();
      expect(registry.list()).toHaveLength(1);
    });

    it('marks a server as needing sign-in on UnauthorizedError, without opening the browser', async () => {
      state.httpConnect = async (auth) => {
        // What the SDK does when there is no token: ask the provider to redirect, then fail.
        await auth.authProvider.redirectToAuthorization(new URL('https://auth.example/authorize'));
        throw new UnauthorizedError();
      };
      const server = await manager.addServer({
        name: 'Papers', transportType: 'http', httpUrl: 'https://papers.example/mcp', oauth: true, oauthScope: 'papers:read',
        enabled: true, autoStart: true,
      });
      const events: unknown[] = [];
      manager.on('server-status-changed', (e) => events.push(e));

      await manager.initialize(); // auto-start at launch

      const after = manager.listServers().find((s) => s.id === server.id);
      expect(after?.connectionStatus).toBe('needs-sign-in');
      expect(after?.lastError).toMatch(/Sign-in needed/);
      expect(openExternal).not.toHaveBeenCalled();
      expect(events).toContainEqual({ serverId: server.id, status: 'needs-sign-in' });
    });

    it('reports a plain error for other failures and closes the half-started client', async () => {
      state.stdioConnect = async () => {
        throw new Error('spawn nope ENOENT');
      };
      const server = await manager.addServer({
        name: 'Prog', transportType: 'stdio', stdioCommand: 'nope', stdioArgs: [], enabled: true, autoStart: false,
      });
      const result = await manager.connectServer(server.id);
      expect(result).toEqual({ success: false, error: 'spawn nope ENOENT' });
      expect(state.clients[0].disconnect).toHaveBeenCalled();
      expect(manager.listServers()[0].connectionStatus).toBe('error');
    });
  });

  describe('a connection that ends by itself', () => {
    it('unregisters the tools, records an error and emits a status event', async () => {
      state.tools = [tool('a'), tool('b')];
      const server = await manager.addServer({
        name: 'Prog', transportType: 'stdio', stdioCommand: 'prog', enabled: true, autoStart: false,
      });
      await manager.connectServer(server.id);
      expect(registry.list()).toHaveLength(2);
      const events: unknown[] = [];
      manager.on('server-status-changed', (e) => events.push(e));

      state.clients[0].closed?.();

      expect(registry.list()).toHaveLength(0);
      const after = manager.listServers()[0];
      expect(after.connectionStatus).toBe('error');
      expect(after.lastError).toMatch(/closed unexpectedly/);
      expect(events).toContainEqual({ serverId: server.id, status: 'error' });
    });

    it('does not treat our own disconnect as a crash', async () => {
      state.tools = [tool('a')];
      const server = await addSse('One');
      await manager.connectServer(server.id);
      await manager.disconnectServer(server.id);
      state.clients[0].closed?.();
      expect(manager.listServers()[0].connectionStatus).toBe('disconnected');
    });
  });

  it('disconnectAll closes every connected client', async () => {
    state.tools = [tool('a')];
    const one = await addSse('One');
    const two = await addSse('Two');
    await manager.connectServer(one.id);
    await manager.connectServer(two.id);
    await manager.disconnectAll();
    expect(state.clients.every((c) => c.disconnect.mock.calls.length > 0)).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  describe('presets', () => {
    it('lists the DAIR Academy preset', () => {
      expect(manager.listPresets().map((p) => p.id)).toContain(DAIR_ACADEMY_PAPERS_PRESET_ID);
    });

    it('adds a preset once; adding again returns the same server', async () => {
      const first = await manager.addPreset(DAIR_ACADEMY_PAPERS_PRESET_ID);
      const second = await manager.addPreset(DAIR_ACADEMY_PAPERS_PRESET_ID);
      expect(second.id).toBe(first.id);
      expect(manager.listServers()).toHaveLength(1);
      expect(first).toMatchObject({
        name: 'DAIR Academy papers', transportType: 'http', httpUrl: 'https://academy.dair.ai/api/mcp',
        oauth: true, oauthScope: 'papers:read', enabled: true, autoStart: true,
      });
    });

    it('rejects an unknown preset', async () => {
      await expect(manager.addPreset('nope')).rejects.toThrow(/Unknown MCP preset/);
    });
  });

  describe('sign in and out', () => {
    async function addOauthServer() {
      return manager.addServer({
        name: 'Papers', transportType: 'http', httpUrl: 'https://papers.example/mcp', oauth: true, oauthScope: 'papers:read',
        enabled: true, autoStart: false,
      });
    }

    it('opens the browser, takes the code from the callback, finishes auth and connects', async () => {
      state.tools = [tool('search_papers')];
      let signedIn = false;
      state.httpConnect = async (auth) => {
        if (signedIn) return;
        // Like the SDK: make a state, send the person to the browser, fail until they come back.
        const stateValue = await auth.authProvider.state();
        await auth.authProvider.redirectToAuthorization(new URL(`https://auth.example/authorize?state=${stateValue}`));
        throw new UnauthorizedError();
      };
      state.finishAuth = async (code) => {
        expect(code).toBe('the-code');
        signedIn = true;
      };
      // The "browser": when asked to open the URL, come back to the callback with the same state.
      openExternal.mockImplementation(async (url: string) => {
        const stateValue = new URL(url).searchParams.get('state');
        void fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?code=the-code&state=${stateValue}`);
      });
      const server = await addOauthServer();

      const result = await manager.signIn(server.id);

      expect(result).toEqual({ success: true, toolsDiscovered: 1 });
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(manager.listServers()[0].connectionStatus).toBe('connected');
      expect(registry.list()).toHaveLength(1);
    });

    it('records needs-sign-in when the person never finishes', async () => {
      state.httpConnect = async (auth) => {
        await auth.authProvider.state();
        await auth.authProvider.redirectToAuthorization(new URL('https://auth.example/authorize'));
        throw new UnauthorizedError();
      };
      manager = new MCPManager(db, registry, { openExternal, oauthCallbackPort: port, oauthTimeoutMs: 50 });
      const server = await addOauthServer();

      const result = await manager.signIn(server.id);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out/);
      expect(manager.listServers()[0].connectionStatus).toBe('needs-sign-in');
    });

    it('refuses to sign in to a server that does not use OAuth', async () => {
      const server = await addSse('Plain');
      await expect(manager.signIn(server.id)).rejects.toThrow(/does not use browser sign-in/);
    });

    it('signOut disconnects and clears the tokens but keeps the client registration', async () => {
      state.tools = [tool('a')];
      const server = await addOauthServer();
      const store = new McpOAuthStore(db);
      store.saveClientInformation(server.id, { client_id: 'cid' });
      store.saveTokens(server.id, { access_token: 'at', token_type: 'Bearer' });
      await manager.connectServer(server.id);

      await manager.signOut(server.id);

      expect(store.getTokens(server.id)).toBeUndefined();
      expect(store.getClientInformation(server.id)).toEqual({ client_id: 'cid' });
      expect(registry.list()).toHaveLength(0);
      expect(manager.listServers()[0].connectionStatus).toBe('needs-sign-in');
    });

    it('deleting a server also deletes its sign-in data', async () => {
      const server = await addOauthServer();
      new McpOAuthStore(db).saveTokens(server.id, { access_token: 'at', token_type: 'Bearer' });
      await manager.deleteServer(server.id);
      expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth').get()).toEqual({ n: 0 });
    });
  });
});
