import type { Database } from 'better-sqlite3';
import type {
  MCPServerConfig,
  MCPServerConfigInput,
  MCPToolSummary,
  MCPConnectionResult,
  MCPConnectionStatus,
} from './types.js';
import type { ToolRegistry, RegisteredTool } from '../tools/tool-registry.js';
import { EventEmitter } from 'node:events';
import { SSEMCPClient } from './clients/sse-client.js';
import { StdioMCPClient } from './clients/stdio-client.js';
import { HTTPMCPClient } from './clients/http-client.js';
import { McpOAuthProvider, McpOAuthStore } from './clients/oauth-provider.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { chooseToolName, isValidToolName } from './tool-names.js';
import { findPreset, listPresetSummaries, type MCPPresetSummary } from './presets.js';
import type { MCPClient } from './clients/base-client.js';
import { randomUUID } from 'node:crypto';
import { encryptToken, decryptToken } from './encryption.js';

export interface MCPManagerOptions {
  /** Opens a URL in the system browser (Electron shell.openExternal). Needed for OAuth sign-in. */
  openExternal?: (url: string) => Promise<void>;
  /** Override the sign-in callback port (default: MCP_OAUTH_CALLBACK_PORT or 8797). */
  oauthCallbackPort?: number;
  /** Override how long a sign-in waits for the browser (default 5 minutes). */
  oauthTimeoutMs?: number;
}

const SIGN_IN_NEEDED = 'Sign-in needed. Press "Sign in" to connect.';

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
  private options: MCPManagerOptions;
  // Servers with a sign-in in progress (only one at a time per server; the callback port is shared).
  private signingIn: Set<string> = new Set();

  constructor(db: Database, toolRegistry: ToolRegistry, options: MCPManagerOptions = {}) {
    super();
    this.db = db;
    this.toolRegistry = toolRegistry;
    this.options = options;
  }

  /**
   * Initialize the MCP manager.
   * Loads all enabled servers and auto-starts those marked for auto-start.
   */
  async initialize(): Promise<void> {
    const servers = this.loadServersFromDB().filter((server) => server.enabled && server.autoStart);

    // Start them side by side so one slow server does not hold up the others.
    // connectServer records its own failures in the database; this only guards against surprises.
    await Promise.all(
      servers.map(async (server) => {
        try {
          await this.connectServer(server.id);
        } catch (error) {
          console.error(`Failed to auto-start server ${server.name}:`, error);
        }
      }),
    );
  }

  /**
   * Disconnect every server. Called when the app quits so stdio child processes are not left running.
   */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.clients.keys());
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.disconnectServer(id);
        } catch (error) {
          console.error(`Failed to disconnect MCP server ${id}:`, error);
        }
      }),
    );
  }

  /** The ready-made servers the person can add. */
  listPresets(): MCPPresetSummary[] {
    return listPresetSummaries();
  }

  /**
   * Add a ready-made server. If a server with the same address already exists it is returned
   * unchanged, so pressing Add twice never makes a duplicate.
   */
  async addPreset(presetId: string): Promise<MCPServerConfig> {
    const preset = findPreset(presetId);
    if (!preset) {
      throw new Error(`Unknown MCP preset: ${presetId}`);
    }
    const url = preset.config.httpUrl ?? preset.config.sseUrl;
    const existing = this.loadServersFromDB().find((server) => (server.httpUrl ?? server.sseUrl) === url);
    if (existing) return existing;
    return await this.addServer(preset.config);
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
    const httpAuthTokenEncrypted = config.httpAuthToken ? encryptToken(config.httpAuthToken) : null;

    // Insert into database
    const stmt = this.db.prepare(`
      INSERT INTO mcp_servers (
        id, name, transport_type,
        sse_url, sse_auth_header, sse_auth_token_encrypted,
        stdio_command, stdio_args_json, stdio_env_json_encrypted,
        http_url, http_auth_header, http_auth_token_encrypted, oauth, oauth_scope,
        enabled, auto_start,
        connection_status, tools_discovered,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      config.httpUrl || null,
      config.httpAuthHeader || null,
      httpAuthTokenEncrypted,
      config.oauth ? 1 : 0,
      config.oauthScope || null,
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

    if (updates.httpUrl !== undefined) {
      updateFields.push('http_url = ?');
      values.push(updates.httpUrl);
    }

    if (updates.httpAuthHeader !== undefined) {
      updateFields.push('http_auth_header = ?');
      values.push(updates.httpAuthHeader);
    }

    if (updates.httpAuthToken !== undefined) {
      updateFields.push('http_auth_token_encrypted = ?');
      values.push(updates.httpAuthToken ? encryptToken(updates.httpAuthToken) : null);
    }

    if (updates.oauth !== undefined) {
      updateFields.push('oauth = ?');
      values.push(updates.oauth ? 1 : 0);
    }

    if (updates.oauthScope !== undefined) {
      updateFields.push('oauth_scope = ?');
      values.push(updates.oauthScope || null);
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
   * An existing connection to the same server is closed first.
   * Never opens the browser: a server that needs OAuth sign-in ends up as 'needs-sign-in'.
   */
  async connectServer(serverId: string): Promise<MCPConnectionResult> {
    const config = this.getServerById(serverId);
    if (!config) {
      throw new Error(`Server not found: ${serverId}`);
    }

    // Close the old client (and unregister its tools) so nothing is leaked.
    await this.teardown(serverId);

    let client: MCPClient | undefined;
    try {
      client = this.createClient(config);
      await client.connect();
      return await this.adoptClient(serverId, client);
    } catch (error) {
      // Make sure a half-started client (e.g. a child process) does not stay around.
      if (client) {
        try {
          await client.disconnect();
        } catch {
          // Already failing; ignore.
        }
      }
      if (this.clients.get(serverId) === client) this.clients.delete(serverId);

      if (error instanceof UnauthorizedError) {
        this.recordStatus(serverId, 'needs-sign-in', SIGN_IN_NEEDED);
        return { success: false, error: SIGN_IN_NEEDED };
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.recordStatus(serverId, 'error', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Sign in to a server that uses OAuth: open the browser, wait for the person to approve,
   * then connect. Only this method ever opens the browser.
   */
  async signIn(serverId: string): Promise<MCPConnectionResult> {
    const config = this.getServerById(serverId);
    if (!config) {
      throw new Error(`Server not found: ${serverId}`);
    }
    if (config.transportType !== 'http' || !config.oauth) {
      throw new Error('This server does not use browser sign-in.');
    }
    if (!this.options.openExternal) {
      throw new Error('Cannot open the browser for sign-in.');
    }
    if (this.signingIn.has(serverId)) {
      throw new Error('Sign-in is already in progress for this server.');
    }
    this.signingIn.add(serverId);

    await this.teardown(serverId);
    const provider = this.createOAuthProvider(config);
    // Where we are, so a failure is recorded the right way: trouble waiting for the browser still
    // means "sign-in needed", while a failure to reach the server is a plain error.
    let waitingForBrowser = false;
    let client: HTTPMCPClient | undefined;
    try {
      // The listener must be up before the browser is sent back to it.
      await provider.beginSignIn();
      client = new HTTPMCPClient(config.httpUrl ?? '', {
        headerName: config.httpAuthHeader,
        headerToken: config.httpAuthToken,
        authProvider: provider,
      });
      try {
        // With no usable token this makes the SDK call redirectToAuthorization (opens the browser)
        // and throw UnauthorizedError. With a good token it simply connects.
        await client.connect();
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        waitingForBrowser = true;
        const code = await provider.waitForCode();
        await client.finishAuth(code);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.recordStatus(serverId, waitingForBrowser ? 'needs-sign-in' : 'error', errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      await client?.disconnect();
      await provider.endSignIn();
      this.signingIn.delete(serverId);
    }

    // Tokens are saved now; connect for real (no browser needed any more).
    return await this.connectServer(serverId);
  }

  /**
   * Sign out of an OAuth server: disconnect and forget the tokens.
   * The client registration is kept so the next sign-in does not register again.
   */
  async signOut(serverId: string): Promise<void> {
    const config = this.getServerById(serverId);
    if (!config) {
      throw new Error(`Server not found: ${serverId}`);
    }
    await this.disconnectServer(serverId);
    new McpOAuthStore(this.db).clearTokens(serverId);
    if (config.oauth) {
      this.recordStatus(serverId, 'needs-sign-in', SIGN_IN_NEEDED);
    }
  }

  /**
   * Disconnect from an MCP server and unregister its tools.
   */
  async disconnectServer(serverId: string): Promise<void> {
    await this.teardown(serverId);

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

    // Delete from database (cascade will delete tools; the sign-in data is removed explicitly
    // because SQLite only cascades when foreign keys are switched on).
    new McpOAuthStore(this.db).clearAll(serverId);
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
    prefs: {
      enabled?: boolean;
      confirmationLevel?: string;
      customDescription?: string;
      /** true/false = the person's choice; null = back to the server's hint */
      readOnly?: boolean | null;
    },
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

    if (prefs.readOnly !== undefined) {
      updates.push('read_only = ?');
      values.push(prefs.readOnly === null ? null : prefs.readOnly ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(Date.now());
      values.push(toolId);

      const stmt = this.db.prepare(`
        UPDATE mcp_tools SET ${updates.join(', ')} WHERE id = ?
      `);
      stmt.run(...values);

      // Re-sync with ToolRegistry if enabled status or the read-only state changed
      if (prefs.enabled !== undefined || prefs.readOnly !== undefined) {
        const tool = this.getToolById(toolId);
        if (tool && Boolean(tool.enabled)) {
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
      try {
        await client.connect();
        const tools = await client.listTools();
        return { success: true, toolsDiscovered: tools.length };
      } finally {
        await client.disconnect();
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return { success: false, error: SIGN_IN_NEEDED };
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }

  // Private helper methods

  /**
   * Store a connected client: list its tools, register them, and record 'connected'.
   */
  private async adoptClient(serverId: string, client: MCPClient): Promise<MCPConnectionResult> {
    const tools = await client.listTools();

    // Store the client first: registering a tool looks it up to route calls.
    this.clients.set(serverId, client);

    // If the connection ends by itself (program died, session gone), tidy up and say so.
    client.onClosed?.((detail) => this.handleUnexpectedClose(serverId, client, detail));

    for (const tool of tools) {
      await this.registerTool(serverId, tool);
    }

    const stmt = this.db.prepare(`
      UPDATE mcp_servers
      SET connection_status = ?, tools_discovered = ?, last_connected_at = ?, updated_at = ?, last_error = NULL
      WHERE id = ?
    `);
    stmt.run('connected', tools.length, Date.now(), Date.now(), serverId);

    this.emit('server-status-changed', { serverId, status: 'connected' });
    this.emit('tools-discovered', serverId, tools.length);

    return { success: true, toolsDiscovered: tools.length };
  }

  /**
   * Close the client of a server (if any) and unregister its tools.
   * The client is removed from the map first so its close event is not mistaken for a crash.
   */
  private async teardown(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    if (client) {
      await client.disconnect();
    }
    for (const tool of this.getToolsByServer(serverId)) {
      this.toolRegistry.unregister(tool.id);
    }
  }

  /** Write a status (and message) to the database and tell listeners. */
  private recordStatus(serverId: string, status: MCPConnectionStatus, message: string | null): void {
    this.db
      .prepare('UPDATE mcp_servers SET connection_status = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(status, message, Date.now(), serverId);
    this.emit('server-status-changed', { serverId, status });
  }

  /** A connected server's transport closed without us asking. */
  private handleUnexpectedClose(serverId: string, client: MCPClient, detail?: string): void {
    // Ignore if this is no longer the current client (we replaced or closed it ourselves).
    if (this.clients.get(serverId) !== client) return;
    this.clients.delete(serverId);
    for (const tool of this.getToolsByServer(serverId)) {
      this.toolRegistry.unregister(tool.id);
    }
    const message = detail
      ? `The connection closed unexpectedly. Last output:\n${detail}`
      : 'The connection closed unexpectedly.';
    this.recordStatus(serverId, 'error', message);
  }

  private createOAuthProvider(config: MCPServerConfig): McpOAuthProvider {
    return new McpOAuthProvider({
      db: this.db,
      serverId: config.id,
      scope: config.oauthScope,
      openExternal: this.options.openExternal ?? (() => Promise.reject(new Error('Cannot open the browser.'))),
      callbackPort: this.options.oauthCallbackPort,
      timeoutMs: this.options.oauthTimeoutMs,
    });
  }

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
      transportType: row.transport_type as MCPServerConfig['transportType'],
      enabled: Boolean(row.enabled),
      autoStart: Boolean(row.auto_start),
      connectionStatus: row.connection_status as MCPConnectionStatus,
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

    // Decrypt and add Streamable HTTP fields
    if (config.transportType === 'http') {
      config.httpUrl = row.http_url || undefined;
      config.httpAuthHeader = row.http_auth_header || undefined;
      config.oauth = Boolean(row.oauth);
      config.oauthScope = row.oauth_scope || undefined;
      if (row.http_auth_token_encrypted) {
        try {
          config.httpAuthToken = decryptToken(row.http_auth_token_encrypted);
        } catch (error) {
          console.error('Failed to decrypt HTTP auth token:', error);
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
      serverName: row.server_name ?? '',
      toolName: row.tool_name,
      // display_name holds the name the assistant sees (chosen when the tool is registered).
      llmName: row.display_name || row.tool_name,
      displayName: row.display_name || row.tool_name,
      description: row.custom_description || row.description,
      enabled: Boolean(row.enabled),
      confirmationLevel: row.confirmation_level,
      readOnly: effectiveReadOnly(row),
      readOnlyOverride: row.read_only === null || row.read_only === undefined ? null : Boolean(row.read_only),
    };
  }

  private createClient(config: MCPServerConfig): MCPClient {
    if (config.transportType === 'sse') {
      if (!config.sseUrl) {
        throw new Error('SSE URL is required for SSE transport');
      }
      return new SSEMCPClient(config.sseUrl, config.sseAuthHeader, config.sseAuthToken);
    }
    if (config.transportType === 'http') {
      if (!config.httpUrl) {
        throw new Error('A web address is required for HTTP transport');
      }
      return new HTTPMCPClient(config.httpUrl, {
        headerName: config.httpAuthHeader,
        headerToken: config.httpAuthToken,
        // Without an active sign-in this provider never opens the browser.
        authProvider: config.oauth ? this.createOAuthProvider(config) : undefined,
      });
    }
    if (!config.stdioCommand) {
      throw new Error('stdio command is required for stdio transport');
    }
    return new StdioMCPClient(config.stdioCommand, config.stdioArgs || [], config.stdioEnv || {});
  }

  private async registerTool(
    serverId: string,
    toolDef: { name: string; description?: string; inputSchema: unknown; readOnlyHint?: boolean },
  ): Promise<void> {
    const toolId = `${serverId}:${toolDef.name}`;
    const now = Date.now();

    // Insert or update in database
    const stmt = this.db.prepare(`
      INSERT INTO mcp_tools (
        id, server_id, tool_name, display_name, description, input_schema_json,
        enabled, confirmation_level, discovered_at, updated_at, read_only_hint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tool_name = excluded.tool_name,
        description = excluded.description,
        input_schema_json = excluded.input_schema_json,
        read_only_hint = excluded.read_only_hint,
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
      toolDef.readOnlyHint === undefined ? null : toolDef.readOnlyHint ? 1 : 0,
    );

    // Register with ToolRegistry
    const tool = this.getToolById(toolId);
    if (tool) {
      await this.registerToolFromDB(tool);
    }
  }

  private async registerToolFromDB(dbTool: MCPToolRow): Promise<void> {
    if (!this.clients.has(dbTool.server_id)) return;

    // The name the assistant sees. Kept stable across reconnects when still valid and free.
    const llmName = this.resolveLlmName(dbTool);

    const registeredTool: RegisteredTool = {
      id: dbTool.id,
      serverId: dbTool.server_id,
      toolName: llmName,
      description: dbTool.custom_description || dbTool.description,
      inputSchema: JSON.parse(dbTool.input_schema_json) as Record<string, unknown>,
      enabled: Boolean(dbTool.enabled),
      confirmationLevel: dbTool.confirmation_level as 'none' | 'notify' | 'confirm' | 'block',
      readOnly: effectiveReadOnly(dbTool),
      execute: async (params: unknown) => {
        // Look the client up at call time so a reconnected server is used, and a dropped one gives a clear error.
        const current = this.clients.get(dbTool.server_id);
        if (!current) {
          throw new Error(`MCP server is not connected: ${dbTool.server_name ?? dbTool.server_id}`);
        }
        // The server knows the tool by its own name, not the cleaned-up one.
        return await current.callTool(dbTool.tool_name, params);
      },
    };

    this.toolRegistry.register(registeredTool);
  }

  /**
   * Decide the LLM-facing name of a tool and save it in display_name.
   * Reuses the saved name when it is valid and nobody else has it; otherwise cleans up the server's
   * name, and prefixes it with the server name when it would clash (see tool-names.ts).
   */
  private resolveLlmName(dbTool: MCPToolRow): string {
    const taken = new Set(
      this.toolRegistry
        .listAll()
        .filter((tool) => tool.id !== dbTool.id)
        .map((tool) => tool.toolName),
    );
    const saved = dbTool.display_name;
    let name: string;
    if (saved && isValidToolName(saved) && !taken.has(saved)) {
      name = saved;
    } else {
      const server = this.getServerById(dbTool.server_id);
      name = chooseToolName(dbTool.tool_name, server?.name ?? dbTool.server_id, taken);
    }
    if (name !== saved) {
      this.db.prepare('UPDATE mcp_tools SET display_name = ? WHERE id = ?').run(name, dbTool.id);
    }
    return name;
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
  http_url: string | null;
  http_auth_header: string | null;
  http_auth_token_encrypted: string | null;
  oauth: number;
  oauth_scope: string | null;
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
  server_name?: string;
  tool_name: string;
  display_name: string | null;
  description: string;
  input_schema_json: string;
  enabled: number;
  confirmation_level: string;
  custom_description: string | null;
  read_only_hint?: number | null;
  read_only?: number | null;
  discovered_at: number;
  updated_at: number;
}

/** A tool only reads when the person said so; otherwise what the server said; otherwise we assume it changes things. */
function effectiveReadOnly(row: { read_only?: number | null; read_only_hint?: number | null }): boolean {
  if (row.read_only !== null && row.read_only !== undefined) return Boolean(row.read_only);
  if (row.read_only_hint !== null && row.read_only_hint !== undefined) return Boolean(row.read_only_hint);
  return false;
}
