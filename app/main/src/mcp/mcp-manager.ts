import type { Database } from 'better-sqlite3';
import type {
  MCPServerConfig,
  MCPServerConfigInput,
  MCPToolSummary,
  MCPConnectionResult,
} from './types.js';
import type { ToolRegistry, RegisteredTool } from '../tools/tool-registry.js';
import { EventEmitter } from 'node:events';
import { SSEMCPClient } from './clients/sse-client.js';
import { StdioMCPClient } from './clients/stdio-client.js';
import type { MCPClient } from './clients/base-client.js';
import { randomUUID } from 'node:crypto';
import { encryptToken, decryptToken } from './encryption.js';

/**
 * Manages MCP server connections and tool discovery.
 * Emits events:
 * - 'server-status-changed': When a server's connection status changes
 * - 'tools-discovered': When tools are discovered from a server
 */
export class MCPManager extends EventEmitter {
  private clients: Map<string, MCPClient> = new Map();
  private toolRegistry: ToolRegistry;
  private db: Database;

  constructor(db: Database, toolRegistry: ToolRegistry) {
    super();
    this.db = db;
    this.toolRegistry = toolRegistry;
  }

  /**
   * Initialize the MCP manager.
   * Loads all enabled servers and auto-starts those marked for auto-start.
   */
  async initialize(): Promise<void> {
    const servers = this.loadServersFromDB();

    for (const server of servers) {
      if (server.enabled && server.autoStart) {
        try {
          await this.connectServer(server.id);
        } catch (error) {
          console.error(`Failed to auto-start server ${server.name}:`, error);
        }
      }
    }
  }

  /**
   * Add a new MCP server configuration.
   */
  async addServer(config: MCPServerConfigInput): Promise<MCPServerConfig> {
    const id = randomUUID();
    const now = Date.now();

    // Encrypt sensitive fields
    const sseAuthTokenEncrypted = config.sseAuthToken ? encryptToken(config.sseAuthToken) : null;
    const stdioEnvEncrypted = config.stdioEnv ? encryptToken(JSON.stringify(config.stdioEnv)) : null;

    // Insert into database
    const stmt = this.db.prepare(`
      INSERT INTO mcp_servers (
        id, name, transport_type,
        sse_url, sse_auth_header, sse_auth_token_encrypted,
        stdio_command, stdio_args_json, stdio_env_json_encrypted,
        enabled, auto_start,
        connection_status, tools_discovered,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      config.name,
      config.transportType,
      config.sseUrl || null,
      config.sseAuthHeader || null,
      sseAuthTokenEncrypted,
      config.stdioCommand || null,
      config.stdioArgs ? JSON.stringify(config.stdioArgs) : null,
      stdioEnvEncrypted,
      config.enabled ? 1 : 0,
      config.autoStart ? 1 : 0,
      'disconnected',
      0,
      now,
      now,
    );

    const server = this.getServerById(id);
    if (!server) {
      throw new Error(`Failed to retrieve newly created server with id: ${id}`);
    }
    return server;
  }

  /**
   * Update an existing MCP server configuration.
   */
  async updateServer(id: string, updates: Partial<MCPServerConfigInput>): Promise<MCPServerConfig> {
    const updateFields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      updateFields.push('name = ?');
      values.push(updates.name);
    }

    if (updates.enabled !== undefined) {
      updateFields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    if (updates.autoStart !== undefined) {
      updateFields.push('auto_start = ?');
      values.push(updates.autoStart ? 1 : 0);
    }

    if (updates.sseUrl !== undefined) {
      updateFields.push('sse_url = ?');
      values.push(updates.sseUrl);
    }

    if (updates.sseAuthHeader !== undefined) {
      updateFields.push('sse_auth_header = ?');
      values.push(updates.sseAuthHeader);
    }

    if (updates.sseAuthToken !== undefined) {
      updateFields.push('sse_auth_token_encrypted = ?');
      values.push(updates.sseAuthToken ? encryptToken(updates.sseAuthToken) : null);
    }

    if (updates.stdioCommand !== undefined) {
      updateFields.push('stdio_command = ?');
      values.push(updates.stdioCommand);
    }

    if (updates.stdioArgs !== undefined) {
      updateFields.push('stdio_args_json = ?');
      values.push(updates.stdioArgs ? JSON.stringify(updates.stdioArgs) : null);
    }

    if (updates.stdioEnv !== undefined) {
      updateFields.push('stdio_env_json_encrypted = ?');
      values.push(updates.stdioEnv ? encryptToken(JSON.stringify(updates.stdioEnv)) : null);
    }

    if (updateFields.length > 0) {
      updateFields.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);

      const stmt = this.db.prepare(`
        UPDATE mcp_servers SET ${updateFields.join(', ')} WHERE id = ?
      `);
      stmt.run(...values);
    }

    const server = this.getServerById(id);
    if (!server) {
      throw new Error(`Server not found: ${id}`);
    }
    return server;
  }

  /**
   * Connect to an MCP server and discover its tools.
   */
  async connectServer(serverId: string): Promise<MCPConnectionResult> {
    const config = this.getServerById(serverId);
    if (!config) {
      throw new Error(`Server not found: ${serverId}`);
    }

    try {
      // Create appropriate client
      const client = this.createClient(config);

      // Connect
      await client.connect();

      // Discover tools
      const tools = await client.listTools();

      // Register tools with ToolRegistry
      for (const tool of tools) {
        await this.registerTool(serverId, tool);
      }

      // Store client
      this.clients.set(serverId, client);

      // Update database
      const stmt = this.db.prepare(`
        UPDATE mcp_servers
        SET connection_status = ?, tools_discovered = ?, last_connected_at = ?, updated_at = ?, last_error = NULL
        WHERE id = ?
      `);
      stmt.run('connected', tools.length, Date.now(), Date.now(), serverId);

      this.emit('server-status-changed', { serverId, status: 'connected' });
      this.emit('tools-discovered', serverId, tools.length);

      return { success: true, toolsDiscovered: tools.length };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Update database with error
      const stmt = this.db.prepare(`
        UPDATE mcp_servers
        SET connection_status = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run('error', errorMsg, Date.now(), serverId);

      this.emit('server-status-changed', { serverId, status: 'error' });

      return { success: false, error: errorMsg };
    }
  }

  /**
   * Disconnect from an MCP server and unregister its tools.
   */
  async disconnectServer(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      await client.disconnect();
      this.clients.delete(serverId);
    }

    // Unregister all tools from this server
    const tools = this.getToolsByServer(serverId);
    for (const tool of tools) {
      this.toolRegistry.unregister(tool.id);
    }

    // Update database
    const stmt = this.db.prepare(`
      UPDATE mcp_servers
      SET connection_status = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run('disconnected', Date.now(), serverId);

    this.emit('server-status-changed', { serverId, status: 'disconnected' });
  }

  /**
   * Delete an MCP server configuration.
   * Disconnects if currently connected.
   * Cascade deletes all associated tools.
   */
  async deleteServer(serverId: string): Promise<void> {
    // Disconnect if connected
    await this.disconnectServer(serverId);

    // Delete from database (cascade will delete tools)
    const stmt = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?');
    stmt.run(serverId);
  }

  /**
   * List all MCP server configurations.
   */
  listServers(): MCPServerConfig[] {
    return this.loadServersFromDB();
  }

  /**
   * List all tools, optionally filtered by server ID.
   */
  listTools(serverId?: string): MCPToolSummary[] {
    if (serverId) {
      return this.getToolsByServer(serverId);
    }

    const stmt = this.db.prepare(`
      SELECT
        t.*,
        s.name as server_name
      FROM mcp_tools t
      JOIN mcp_servers s ON t.server_id = s.id
      ORDER BY s.name, t.tool_name
    `);

    const rows = stmt.all() as MCPToolRow[];
    return rows.map((row) => this.toolRowToSummary(row));
  }

  /**
   * Update tool preferences (enabled, confirmation level, custom description).
   */
  async updateToolPreferences(
    toolId: string,
    prefs: { enabled?: boolean; confirmationLevel?: string; customDescription?: string },
  ): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (prefs.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(prefs.enabled ? 1 : 0);
    }
    if (prefs.confirmationLevel !== undefined) {
      updates.push('confirmation_level = ?');
      values.push(prefs.confirmationLevel);
    }
    if (prefs.customDescription !== undefined) {
      updates.push('custom_description = ?');
      values.push(prefs.customDescription);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(Date.now());
      values.push(toolId);

      const stmt = this.db.prepare(`
        UPDATE mcp_tools SET ${updates.join(', ')} WHERE id = ?
      `);
      stmt.run(...values);

      // Re-sync with ToolRegistry if enabled status changed
      if (prefs.enabled !== undefined) {
        const tool = this.getToolById(toolId);
        if (tool && prefs.enabled) {
          // Re-register with updated settings
          await this.registerToolFromDB(tool);
        } else {
          // Unregister
          this.toolRegistry.unregister(toolId);
        }
      }
    }
  }

  /**
   * Test connection to an MCP server without persisting the connection.
   */
  async testConnection(serverId: string): Promise<MCPConnectionResult> {
    const config = this.getServerById(serverId);
    if (!config) {
      throw new Error(`Server not found: ${serverId}`);
    }

    try {
      const client = this.createClient(config);
      await client.connect();
      const tools = await client.listTools();
      await client.disconnect();

      return { success: true, toolsDiscovered: tools.length };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }

  // Private helper methods

  private loadServersFromDB(): MCPServerConfig[] {
    const stmt = this.db.prepare('SELECT * FROM mcp_servers ORDER BY name');
    const rows = stmt.all() as MCPServerRow[];

    return rows.map((row) => this.serverRowToConfig(row));
  }

  private getServerById(id: string): MCPServerConfig | undefined {
    const stmt = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?');
    const row = stmt.get(id) as MCPServerRow | undefined;
    return row ? this.serverRowToConfig(row) : undefined;
  }

  private serverRowToConfig(row: MCPServerRow): MCPServerConfig {
    const config: MCPServerConfig = {
      id: row.id,
      name: row.name,
      transportType: row.transport_type as 'sse' | 'stdio',
      enabled: Boolean(row.enabled),
      autoStart: Boolean(row.auto_start),
      connectionStatus: row.connection_status as 'connected' | 'disconnected' | 'error',
      lastError: row.last_error || undefined,
      toolsDiscovered: row.tools_discovered,
      lastConnectedAt: row.last_connected_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Decrypt and add SSE fields
    if (config.transportType === 'sse') {
      config.sseUrl = row.sse_url || undefined;
      config.sseAuthHeader = row.sse_auth_header || undefined;
      if (row.sse_auth_token_encrypted) {
        try {
          config.sseAuthToken = decryptToken(row.sse_auth_token_encrypted);
        } catch (error) {
          console.error('Failed to decrypt SSE auth token:', error);
        }
      }
    }

    // Decrypt and add stdio fields
    if (config.transportType === 'stdio') {
      config.stdioCommand = row.stdio_command || undefined;
      if (row.stdio_args_json) {
        try {
          const parsed = JSON.parse(row.stdio_args_json) as unknown;
          if (Array.isArray(parsed)) {
            config.stdioArgs = parsed as string[];
          }
        } catch (error) {
          console.error('Failed to parse stdio args:', error);
        }
      }
      if (row.stdio_env_json_encrypted) {
        try {
          const parsed = JSON.parse(decryptToken(row.stdio_env_json_encrypted)) as unknown;
          if (typeof parsed === 'object' && parsed !== null) {
            config.stdioEnv = parsed as Record<string, string>;
          }
        } catch (error) {
          console.error('Failed to decrypt stdio env:', error);
        }
      }
    }

    return config;
  }

  private getToolsByServer(serverId: string): MCPToolSummary[] {
    const stmt = this.db.prepare(`
      SELECT
        t.*,
        s.name as server_name
      FROM mcp_tools t
      JOIN mcp_servers s ON t.server_id = s.id
      WHERE t.server_id = ?
      ORDER BY t.tool_name
    `);

    const rows = stmt.all(serverId) as MCPToolRow[];
    return rows.map((row) => this.toolRowToSummary(row));
  }

  private getToolById(id: string): MCPToolRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM mcp_tools WHERE id = ?');
    return stmt.get(id) as MCPToolRow | undefined;
  }

  private toolRowToSummary(row: MCPToolRow): MCPToolSummary {
    return {
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      toolName: row.tool_name,
      displayName: row.display_name || row.tool_name,
      description: row.custom_description || row.description,
      enabled: Boolean(row.enabled),
      confirmationLevel: row.confirmation_level,
    };
  }

  private createClient(config: MCPServerConfig): MCPClient {
    if (config.transportType === 'sse') {
      if (!config.sseUrl) {
        throw new Error('SSE URL is required for SSE transport');
      }
      return new SSEMCPClient(config.sseUrl, config.sseAuthHeader, config.sseAuthToken);
    } else {
      if (!config.stdioCommand) {
        throw new Error('stdio command is required for stdio transport');
      }
      return new StdioMCPClient(
        config.stdioCommand,
        config.stdioArgs || [],
        config.stdioEnv || {},
      );
    }
  }

  private async registerTool(serverId: string, toolDef: { name: string; description?: string; inputSchema: unknown }): Promise<void> {
    const toolId = `${serverId}:${toolDef.name}`;
    const now = Date.now();

    // Insert or update in database
    const stmt = this.db.prepare(`
      INSERT INTO mcp_tools (
        id, server_id, tool_name, display_name, description, input_schema_json,
        enabled, confirmation_level, discovered_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        input_schema_json = excluded.input_schema_json,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      toolId,
      serverId,
      toolDef.name,
      toolDef.name,
      toolDef.description || '',
      JSON.stringify(toolDef.inputSchema),
      1, // enabled by default
      'none', // default confirmation level
      now,
      now,
    );

    // Register with ToolRegistry
    const tool = this.getToolById(toolId);
    if (tool) {
      await this.registerToolFromDB(tool);
    }
  }

  private async registerToolFromDB(dbTool: MCPToolRow): Promise<void> {
    const client = this.clients.get(dbTool.server_id);
    if (!client) return;

    const registeredTool: RegisteredTool = {
      id: dbTool.id,
      serverId: dbTool.server_id,
      toolName: dbTool.tool_name,
      description: dbTool.custom_description || dbTool.description,
      inputSchema: JSON.parse(dbTool.input_schema_json) as Record<string, unknown>,
      enabled: Boolean(dbTool.enabled),
      confirmationLevel: dbTool.confirmation_level as 'none' | 'notify' | 'confirm' | 'block',
      execute: async (params: unknown) => {
        return await client.callTool(dbTool.tool_name, params);
      },
    };

    this.toolRegistry.register(registeredTool);
  }
}

// Database row types
interface MCPServerRow {
  id: string;
  name: string;
  transport_type: string;
  sse_url: string | null;
  sse_auth_header: string | null;
  sse_auth_token_encrypted: string | null;
  stdio_command: string | null;
  stdio_args_json: string | null;
  stdio_env_json_encrypted: string | null;
  enabled: number;
  auto_start: number;
  connection_status: string;
  last_error: string | null;
  tools_discovered: number;
  last_connected_at: number | null;
  created_at: number;
  updated_at: number;
}

interface MCPToolRow {
  id: string;
  server_id: string;
  server_name: string;
  tool_name: string;
  display_name: string | null;
  description: string;
  input_schema_json: string;
  enabled: number;
  confirmation_level: string;
  custom_description: string | null;
  discovered_at: number;
  updated_at: number;
}
