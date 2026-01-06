import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MCPManager } from '../../src/mcp/mcp-manager.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { Database } from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MCPServerConfigInput } from '../../src/mcp/types.js';

// Mock the MCP clients
vi.mock('../../src/mcp/clients/sse-client.js', () => ({
  SSEMCPClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ]),
    callTool: vi.fn().mockResolvedValue('tool result'),
    onToolsChanged: vi.fn(),
  })),
}));

vi.mock('../../src/mcp/clients/stdio-client.js', () => ({
  StdioMCPClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockRejectedValue(new Error('stdio not implemented')),
    onToolsChanged: vi.fn(),
  })),
}));

vi.mock('../../src/mcp/encryption.js', () => ({
  encryptToken: vi.fn((token: string) => `encrypted:${token}`),
  decryptToken: vi.fn((encrypted: string) => encrypted.replace('encrypted:', '')),
}));

describe('MCPManager', () => {
  let db: Database;
  let toolRegistry: ToolRegistry;
  let manager: MCPManager;
  let tempDir: string;

  beforeEach(() => {
    // Create temp directory and database
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    const dbPath = join(tempDir, 'test.db');
    db = new DatabaseConstructor(dbPath);

    // Create tables
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport_type TEXT NOT NULL,
        sse_url TEXT,
        sse_auth_header TEXT,
        sse_auth_token_encrypted TEXT,
        stdio_command TEXT,
        stdio_args_json TEXT,
        stdio_env_json_encrypted TEXT,
        enabled INTEGER DEFAULT 1,
        auto_start INTEGER DEFAULT 0,
        connection_status TEXT DEFAULT 'disconnected',
        last_error TEXT,
        tools_discovered INTEGER DEFAULT 0,
        last_connected_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE mcp_tools (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        display_name TEXT,
        description TEXT,
        input_schema_json TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        confirmation_level TEXT DEFAULT 'none',
        custom_description TEXT,
        discovered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_mcp_tools_server ON mcp_tools(server_id);
      CREATE INDEX idx_mcp_tools_enabled ON mcp_tools(enabled);

      CREATE TABLE mcp_tool_executions (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        params_json TEXT,
        result_json TEXT,
        error_message TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        triggered_by TEXT,
        executed_at INTEGER NOT NULL,
        FOREIGN KEY (tool_id) REFERENCES mcp_tools(id)
      );
    `);

    toolRegistry = new ToolRegistry();
    manager = new MCPManager(db, toolRegistry);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('addServer', () => {
    it('adds an SSE server configuration', async () => {
      const config: MCPServerConfigInput = {
        name: 'Test SSE Server',
        transportType: 'sse',
        sseUrl: 'https://example.com/sse',
        sseAuthHeader: 'Authorization',
        sseAuthToken: 'secret-token',
        enabled: true,
        autoStart: false,
      };

      const result = await manager.addServer(config);

      expect(result.id).toBeDefined();
      expect(result.name).toBe('Test SSE Server');
      expect(result.transportType).toBe('sse');
      expect(result.sseUrl).toBe('https://example.com/sse');
      expect(result.sseAuthToken).toBe('secret-token');
      expect(result.enabled).toBe(true);
      expect(result.connectionStatus).toBe('disconnected');
    });

    it('adds a stdio server configuration', async () => {
      const config: MCPServerConfigInput = {
        name: 'Test Stdio Server',
        transportType: 'stdio',
        stdioCommand: 'node',
        stdioArgs: ['server.js'],
        stdioEnv: { NODE_ENV: 'production' },
        enabled: true,
        autoStart: true,
      };

      const result = await manager.addServer(config);

      expect(result.id).toBeDefined();
      expect(result.name).toBe('Test Stdio Server');
      expect(result.transportType).toBe('stdio');
      expect(result.stdioCommand).toBe('node');
      expect(result.stdioArgs).toEqual(['server.js']);
      expect(result.stdioEnv).toEqual({ NODE_ENV: 'production' });
      expect(result.autoStart).toBe(true);
    });

    it('encrypts sensitive fields', async () => {
      const config: MCPServerConfigInput = {
        name: 'Secure Server',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        sseAuthToken: 'my-token',
        enabled: true,
        autoStart: false,
      };

      await manager.addServer(config);

      // Check database directly
      const row = db
        .prepare('SELECT sse_auth_token_encrypted FROM mcp_servers WHERE name = ?')
        .get('Secure Server') as { sse_auth_token_encrypted: string };

      expect(row.sse_auth_token_encrypted).toBe('encrypted:my-token');
    });
  });

  describe('updateServer', () => {
    it('updates server name', async () => {
      const server = await manager.addServer({
        name: 'Original Name',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        enabled: true,
        autoStart: false,
      });

      const updated = await manager.updateServer(server.id, {
        name: 'Updated Name',
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.sseUrl).toBe('https://example.com');
    });

    it('updates enabled status', async () => {
      const server = await manager.addServer({
        name: 'Test Server',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        enabled: true,
        autoStart: false,
      });

      const updated = await manager.updateServer(server.id, {
        enabled: false,
      });

      expect(updated.enabled).toBe(false);
    });

    it('throws error when server not found', async () => {
      await expect(
        manager.updateServer('non-existent-id', { name: 'New Name' }),
      ).rejects.toThrow('Server not found');
    });
  });

  describe('deleteServer', () => {
    it('deletes a server', async () => {
      const server = await manager.addServer({
        name: 'To Delete',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        enabled: true,
        autoStart: false,
      });

      await manager.deleteServer(server.id);

      const servers = manager.listServers();
      expect(servers.find((s) => s.id === server.id)).toBeUndefined();
    });

    it('cascades delete to tools', async () => {
      const server = await manager.addServer({
        name: 'Server with Tools',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        enabled: true,
        autoStart: false,
      });

      // Connect to discover tools
      await manager.connectServer(server.id);

      // Verify tools exist
      const toolsBefore = manager.listTools(server.id);
      expect(toolsBefore.length).toBeGreaterThan(0);

      // Delete server
      await manager.deleteServer(server.id);

      // Verify tools are gone
      const toolsAfter = manager.listTools(server.id);
      expect(toolsAfter.length).toBe(0);
    });
  });

  describe('connectServer', () => {
    it('connects to SSE server and discovers tools', async () => {
      const server = await manager.addServer({
        name: 'SSE Server',
        transportType: 'sse',
        sseUrl: 'https://example.com/sse',
        enabled: true,
        autoStart: false,
      });

      const result = await manager.connectServer(server.id);

      expect(result.success).toBe(true);
      expect(result.toolsDiscovered).toBe(1);

      const updated = manager.listServers().find((s) => s.id === server.id);
      expect(updated?.connectionStatus).toBe('connected');
      expect(updated?.toolsDiscovered).toBe(1);
    });

    it('registers tools with ToolRegistry', async () => {
      const server = await manager.addServer({
        name: 'SSE Server',
        transportType: 'sse',
        sseUrl: 'https://example.com/sse',
        enabled: true,
        autoStart: false,
      });

      await manager.connectServer(server.id);

      const tools = toolRegistry.listAll();
      expect(tools.length).toBe(1);
      expect(tools[0].toolName).toBe('test-tool');
    });

    it('emits server-status-changed event', async () => {
      const server = await manager.addServer({
        name: 'SSE Server',
        transportType: 'sse',
        sseUrl: 'https://example.com/sse',
        enabled: true,
        autoStart: false,
      });

      return new Promise<void>((resolve) => {
        manager.on('server-status-changed', (event) => {
          expect(event.serverId).toBe(server.id);
          expect(event.status).toBe('connected');
          resolve();
        });
        manager.connectServer(server.id);
      });
    });

    it('emits tools-discovered event', async () => {
      const server = await manager.addServer({
        name: 'SSE Server',
        transportType: 'sse',
        sseUrl: 'https://example.com/sse',
        enabled: true,
        autoStart: false,
      });

      return new Promise<void>((resolve) => {
        manager.on('tools-discovered', (serverId, count) => {
          expect(serverId).toBe(server.id);
          expect(count).toBe(1);
          resolve();
        });
        manager.connectServer(server.id);
      });
    });

    it('handles connection errors gracefully', async () => {
      const { SSEMCPClient } = await import('../../src/mcp/clients/sse-client.js');
      vi.mocked(SSEMCPClient).mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockRejectedValue(new Error('Connection failed')),
            disconnect: vi.fn(),
            listTools: vi.fn(),
            callTool: vi.fn(),
            onToolsChanged: vi.fn(),
          }) as any,
      );

      const server = await manager.addServer({
        name: 'Failing Server',
        transportType: 'sse',
        sseUrl: 'https://example.com/sse',
        enabled: true,
        autoStart: false,
      });

      const result = await manager.connectServer(server.id);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection failed');

      const updated = manager.listServers().find((s) => s.id === server.id);
      expect(updated?.connectionStatus).toBe('error');
      expect(updated?.lastError).toBe('Connection failed');
    });
  });

  describe('disconnectServer', () => {
    it('disconnects from server and unregisters tools', async () => {
      const server = await manager.addServer({
        name: 'SSE Server',
        transportType: 'sse',
        sseUrl: 'https://example.com/sse',
        enabled: true,
        autoStart: false,
      });

      await manager.connectServer(server.id);
      expect(toolRegistry.listAll().length).toBe(1);

      await manager.disconnectServer(server.id);

      const updated = manager.listServers().find((s) => s.id === server.id);
      expect(updated?.connectionStatus).toBe('disconnected');
      expect(toolRegistry.listAll().length).toBe(0);
    });
  });

  describe('listServers', () => {
    it('returns all servers', async () => {
      await manager.addServer({
        name: 'Server 1',
        transportType: 'sse',
        sseUrl: 'https://example.com/1',
        enabled: true,
        autoStart: false,
      });

      await manager.addServer({
        name: 'Server 2',
        transportType: 'stdio',
        stdioCommand: 'node',
        enabled: true,
        autoStart: false,
      });

      const servers = manager.listServers();
      expect(servers.length).toBe(2);
    });

    it('returns empty array when no servers', () => {
      const servers = manager.listServers();
      expect(servers).toEqual([]);
    });
  });

  describe('listTools', () => {
    it('returns tools from specific server', async () => {
      const server1 = await manager.addServer({
        name: 'Server 1',
        transportType: 'sse',
        sseUrl: 'https://example.com/1',
        enabled: true,
        autoStart: false,
      });

      const server2 = await manager.addServer({
        name: 'Server 2',
        transportType: 'sse',
        sseUrl: 'https://example.com/2',
        enabled: true,
        autoStart: false,
      });

      await manager.connectServer(server1.id);
      await manager.connectServer(server2.id);

      const tools1 = manager.listTools(server1.id);
      expect(tools1.length).toBe(1);
      expect(tools1[0].serverId).toBe(server1.id);
    });

    it('returns all tools when no server specified', async () => {
      const server1 = await manager.addServer({
        name: 'Server 1',
        transportType: 'sse',
        sseUrl: 'https://example.com/1',
        enabled: true,
        autoStart: false,
      });

      const server2 = await manager.addServer({
        name: 'Server 2',
        transportType: 'sse',
        sseUrl: 'https://example.com/2',
        enabled: true,
        autoStart: false,
      });

      await manager.connectServer(server1.id);
      await manager.connectServer(server2.id);

      const allTools = manager.listTools();
      expect(allTools.length).toBe(2);
    });
  });

  describe('updateToolPreferences', () => {
    it('updates tool enabled status', async () => {
      const server = await manager.addServer({
        name: 'Server',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        enabled: true,
        autoStart: false,
      });

      await manager.connectServer(server.id);

      const tools = manager.listTools(server.id);
      const toolId = tools[0].id;

      await manager.updateToolPreferences(toolId, { enabled: false });

      const updated = manager.listTools(server.id);
      expect(updated[0].enabled).toBe(false);
    });

    it('updates tool custom description', async () => {
      const server = await manager.addServer({
        name: 'Server',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        enabled: true,
        autoStart: false,
      });

      await manager.connectServer(server.id);

      const tools = manager.listTools(server.id);
      const toolId = tools[0].id;

      await manager.updateToolPreferences(toolId, {
        customDescription: 'Custom description',
      });

      const updated = manager.listTools(server.id);
      expect(updated[0].description).toBe('Custom description');
    });
  });

  describe('initialize', () => {
    it('auto-starts enabled servers', async () => {
      await manager.addServer({
        name: 'Auto Start Server',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        enabled: true,
        autoStart: true,
      });

      await manager.addServer({
        name: 'Manual Server',
        transportType: 'sse',
        sseUrl: 'https://example.com/2',
        enabled: true,
        autoStart: false,
      });

      // Create new manager to test initialize
      const newManager = new MCPManager(db, new ToolRegistry());
      await newManager.initialize();

      const servers = newManager.listServers();
      const autoStart = servers.find((s) => s.name === 'Auto Start Server');
      const manual = servers.find((s) => s.name === 'Manual Server');

      expect(autoStart?.connectionStatus).toBe('connected');
      expect(manual?.connectionStatus).toBe('disconnected');
    });
  });

  describe('testConnection', () => {
    it('tests connection without persisting', async () => {
      const server = await manager.addServer({
        name: 'Test Server',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        enabled: true,
        autoStart: false,
      });

      const result = await manager.testConnection(server.id);

      expect(result.success).toBe(true);
      expect(result.toolsDiscovered).toBe(1);

      // Verify server is still disconnected
      const updated = manager.listServers().find((s) => s.id === server.id);
      expect(updated?.connectionStatus).toBe('disconnected');
    });
  });
});
