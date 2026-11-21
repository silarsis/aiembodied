import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { MCPManager } from '../../src/mcp/mcp-manager.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { HOME_ASSISTANT_READ_TOOLS, homeAssistantReadOnlyDefault, isRiskyHomeAssistantTool } from '../../src/mcp/presets.js';
import { toServerSummary } from '../../src/mcp/server-summary.js';

/** Home Assistant as an MCP server: the ready-made list, the token staying in main, read-only defaults and confirm defaults. */

type Tool = { name: string; description?: string; inputSchema: unknown; readOnlyHint?: boolean };

const state = vi.hoisted(() => ({
  tools: [] as Array<{ name: string; description?: string; inputSchema: unknown; readOnlyHint?: boolean }>,
  clients: [] as Array<{ url: string; auth: any }>,
}));

vi.mock('../../src/mcp/clients/http-client.js', () => ({
  HTTPMCPClient: vi.fn().mockImplementation(function (url: string, auth: any) {
    const fake = {
      url,
      auth,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(async () => state.tools),
      callTool: vi.fn().mockResolvedValue('ok'),
      onToolsChanged: vi.fn(),
      onClosed: vi.fn(),
    };
    state.clients.push(fake);
    return fake;
  }),
}));
vi.mock('../../src/mcp/encryption.js', () => ({
  encryptToken: vi.fn(async (token: string) => `encrypted:${token}`),
  decryptToken: vi.fn(async (encrypted: string) => encrypted.replace('encrypted:', '')),
}));

const SCHEMA = `
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, transport_type TEXT NOT NULL,
    sse_url TEXT, sse_auth_header TEXT, sse_auth_token_encrypted TEXT,
    stdio_command TEXT, stdio_args_json TEXT, stdio_env_json_encrypted TEXT,
    http_url TEXT, http_auth_header TEXT, http_auth_token_encrypted TEXT,
    oauth INTEGER NOT NULL DEFAULT 0, oauth_scope TEXT, token_from_model_server TEXT,
    enabled INTEGER DEFAULT 1, auto_start INTEGER DEFAULT 0,
    connection_status TEXT DEFAULT 'disconnected', last_error TEXT,
    tools_discovered INTEGER DEFAULT 0, last_connected_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_tools (
    id TEXT PRIMARY KEY, server_id TEXT NOT NULL, tool_name TEXT NOT NULL, display_name TEXT,
    description TEXT, input_schema_json TEXT NOT NULL, enabled INTEGER DEFAULT 1,
    confirmation_level TEXT DEFAULT 'none', custom_description TEXT, read_only_hint INTEGER, read_only INTEGER,
    discovered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_oauth (
    server_id TEXT PRIMARY KEY, client_info_encrypted TEXT, tokens_encrypted TEXT,
    code_verifier_encrypted TEXT, updated_at INTEGER NOT NULL
  );
`;

const tool = (name: string, description = '', readOnlyHint?: boolean): Tool => ({ name, description, inputSchema: { type: 'object', properties: {} }, readOnlyHint });

describe('Home Assistant as an MCP server', () => {
  let db: Database;
  let dir: string;
  let registry: ToolRegistry;
  let manager: MCPManager;
  const tokens: Record<string, string> = { 'ha-1': 'secret-token-1' };
  const homes = [
    { id: 'ha-1', name: 'Home', url: 'http://homeassistant-1:8123/' },
    { id: 'ha-2', name: 'sg', url: 'http://sg.local:8123' },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-ha-test-'));
    db = new DatabaseConstructor(join(dir, 'test.db'));
    db.exec(SCHEMA);
    state.tools = [];
    state.clients = [];
    registry = new ToolRegistry();
    manager = new MCPManager(db, registry, { homeAssistantHomes: () => homes, modelServerToken: (id) => tokens[id] });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists a ready-made server per home, without any token', () => {
    const presets = manager.listPresets().filter((p) => p.id.startsWith('home-assistant:'));
    expect(presets.map((p) => [p.id, p.name, p.url])).toEqual([
      ['home-assistant:ha-1', 'Home Assistant: Home', 'http://homeassistant-1:8123/api/mcp'],
      ['home-assistant:ha-2', 'Home Assistant: sg', 'http://sg.local:8123/api/mcp'],
    ]);
    expect(JSON.stringify(presets)).not.toContain('secret-token-1');
  });

  it('adds one http server per home (idempotent) that keeps a reference, not the token', async () => {
    const first = await manager.addPreset('home-assistant:ha-1');
    const again = await manager.addPreset('home-assistant:ha-1');
    expect(again.id).toBe(first.id);
    expect((await manager.listServers())).toHaveLength(1);
    expect(first).toMatchObject({
      name: 'Home Assistant (Home)',
      transportType: 'http',
      httpUrl: 'http://homeassistant-1:8123/api/mcp',
      httpAuthHeader: 'Authorization',
      tokenFromModelServer: 'ha-1',
    });
    // No token anywhere in the database or in what the renderer gets.
    expect(first.httpAuthToken).toBeUndefined();
    expect(JSON.stringify(db.prepare('SELECT * FROM mcp_servers').all())).not.toContain('secret-token-1');
    const summary = JSON.stringify(toServerSummary(first));
    expect(summary).not.toContain('secret-token-1');
    expect(toServerSummary(first).hasAuthToken).toBe(true);
    await expect(manager.addPreset('home-assistant:gone')).rejects.toThrow(/Unknown MCP preset/);
  });

  it('reads the token from Models and servers when connecting, so a changed token flows through', async () => {
    const server = await manager.addPreset('home-assistant:ha-1');
    await manager.connectServer(server.id);
    expect(state.clients[0].auth).toMatchObject({ headerName: 'Authorization', headerToken: 'Bearer secret-token-1' });
    tokens['ha-1'] = 'new-token';
    await manager.connectServer(server.id);
    expect(state.clients[1].auth.headerToken).toBe('Bearer new-token');
    tokens['ha-1'] = 'secret-token-1';
  });

  it('says what is missing when the home has no token', async () => {
    const server = await manager.addPreset('home-assistant:ha-2');
    const result = await manager.connectServer(server.id);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/token/i);
  });

  it('counts Get tools as reads and everything else as changes, unless the person or the server said', async () => {
    state.tools = [tool('GetLiveContext'), tool('GetDateTime'), tool('HassTurnOn'), tool('HassLightSet'), tool('HassSetPosition'), tool('HassTurnOff', '', true)];
    const server = await manager.addPreset('home-assistant:ha-1');
    await manager.connectServer(server.id);
    const read = (name: string) => manager.listTools(server.id).find((t) => t.toolName === name)!;
    expect(read('GetLiveContext').readOnly).toBe(true);
    expect(read('GetDateTime').readOnly).toBe(true);
    expect(read('HassTurnOn').readOnly).toBe(false);
    expect(read('HassLightSet').readOnly).toBe(false);
    expect(read('HassSetPosition').readOnly).toBe(false);
    // The server's own hint beats the preset default.
    expect(read('HassTurnOff').readOnly).toBe(true);
    // The person's choice beats both.
    await manager.updateToolPreferences(read('GetLiveContext').id, { readOnly: false });
    await manager.updateToolPreferences(read('HassTurnOn').id, { readOnly: true });
    expect(read('GetLiveContext').readOnly).toBe(false);
    expect(read('HassTurnOn').readOnly).toBe(true);
    // The registered tools carry the same answer (the station trip decision uses it).
    expect(registry.list().find((t) => t.toolName === 'GetDateTime')?.readOnly).toBe(true);
  });

  it('does not apply the Home Assistant defaults to other servers', async () => {
    state.tools = [tool('GetThing')];
    const other = await manager.addServer({ name: 'Other', transportType: 'http', httpUrl: 'https://o.example/mcp', enabled: true, autoStart: false });
    await manager.connectServer(other.id);
    expect(manager.listTools(other.id)[0].readOnly).toBe(false);
    expect(manager.listTools(other.id)[0].confirmationLevel).toBe('none');
  });

  it('asks first for risky tools on first discovery only; the person keeps the last word', async () => {
    state.tools = [
      tool('HassLockUnlock', 'Locks or unlocks a lock'),
      tool('alarm_control', 'Arm or disarm the alarm panel'),
      tool('HassOpenGarage', 'Opens the garage door'),
      tool('HassTurnOn', 'Turns on a light'),
      tool('HassClimateSet', 'Sets a warm temperature'),
    ];
    const server = await manager.addPreset('home-assistant:ha-1');
    await manager.connectServer(server.id);
    const level = (name: string) => manager.listTools(server.id).find((t) => t.toolName === name)!.confirmationLevel;
    expect(level('HassLockUnlock')).toBe('confirm');
    expect(level('alarm_control')).toBe('confirm');
    expect(level('HassOpenGarage')).toBe('confirm');
    expect(level('HassTurnOn')).toBe('none');
    expect(level('HassClimateSet')).toBe('none');
    // The person lowers one; a reconnect does not put it back.
    const id = manager.listTools(server.id).find((t) => t.toolName === 'HassLockUnlock')!.id;
    await manager.updateToolPreferences(id, { confirmationLevel: 'none' });
    await manager.connectServer(server.id);
    expect(level('HassLockUnlock')).toBe('none');
  });
});

describe('Home Assistant tool rules', () => {
  it('keeps the known reads small and explicit', () => {
    expect(HOME_ASSISTANT_READ_TOOLS).toContain('GetLiveContext');
    for (const name of HOME_ASSISTANT_READ_TOOLS) expect(homeAssistantReadOnlyDefault(name)).toBe(true);
    expect(homeAssistantReadOnlyDefault('GetAnything')).toBe(true);
    expect(homeAssistantReadOnlyDefault('HassTurnOff')).toBe(false);
  });

  it('finds risky words as words, not inside other words', () => {
    expect(isRiskyHomeAssistantTool('HassUnlockDoor', undefined)).toBe(true);
    expect(isRiskyHomeAssistantTool('x', 'Disarms the alarm')).toBe(true);
    expect(isRiskyHomeAssistantTool('HassTurnOn', 'Turns on a warm light, a blockbuster')).toBe(false);
  });
});
