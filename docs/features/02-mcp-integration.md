# MCP Server Integration Design

> **Priority**: High
> **Status**: Implementation In Progress
> **Last Updated**: 2026-01-05

## Overview

This document describes the integration of Model Context Protocol (MCP) servers into the Embodied ChatGPT Assistant, enabling the LLM to execute actions via external tools and services through a unified interface. Users can configure MCP servers via a dedicated UI tab, and discovered tools become available for function calling during voice conversations.

## Goals

1. **Universal MCP Support** - Support both stdio and SSE transport types for maximum compatibility
2. **User-Friendly Configuration** - Dedicated UI tab for managing MCP servers with paste-to-import support
3. **Seamless LLM Integration** - Automatically inject MCP tools into OpenAI Realtime API sessions
4. **Security First** - Encrypted token storage, confirmation flows for sensitive actions, audit logging
5. **Extensibility** - Architecture supports unlimited MCP servers and tools

## Architecture Overview

### High-Level Flow

```
User Voice ──► Realtime API ──► Tool Call Decision ──► Tool Registry
                                                            │
                    ┌───────────────────────────────────────┤
                    ▼                   ▼                   ▼
            MCP Server 1        MCP Server 2        MCP Server N
            (Home Assistant)    (Filesystem)        (GitHub)
                    │                   │                   │
                    ▼                   ▼                   ▼
             Smart Devices        Local Files        Repositories
```

### Component Stack

| Layer | Components | Responsibilities |
|-------|-----------|------------------|
| **Renderer** | MCP Tab UI, Tool List, Server Config Dialog | User configuration, tool management |
| **IPC Bridge** | MCPBridge interface | Communication between renderer and main |
| **Main Process** | MCPManager, ToolRegistry, MCP Clients | Server lifecycle, tool discovery, execution |
| **Database** | mcp_servers, mcp_tools, mcp_tool_executions | Persistent configuration and audit logs |
| **External** | MCP Servers (stdio/SSE) | Tool providers |

## 1. UI Design - New "MCP" Tab

### 1.1 Tab Addition

**Location**: [app/renderer/src/App.tsx:45-50](app/renderer/src/App.tsx#L45-L50)

Add a fourth tab to the existing three tabs:

```typescript
type TabId = 'chatgpt' | 'character' | 'local' | 'mcp';

const TABS: TabDefinition[] = [
  { id: 'chatgpt', label: 'Voice' },
  { id: 'character', label: 'Character' },
  { id: 'local', label: 'Device' },
  { id: 'mcp', label: 'MCP Servers' }  // NEW
];
```

### 1.2 MCP Tab Layout

The MCP tab contains three main sections:

```
┌─────────────────────────────────────────────────────────────┐
│ MCP SERVERS TAB                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ 1. SERVER CONNECTIONS                                 │   │
│ │                                                        │   │
│ │  Configured Servers (2)                [+ Add Server] │   │
│ │  ─────────────────────────────────────────────────────│   │
│ │  ┌────────────────────────────────────────────────┐  │   │
│ │  │ 🏠 Home Assistant              [Connected ●]   │  │   │
│ │  │    SSE: http://192.168.1.100:8123/api/mcp      │  │   │
│ │  │    23 tools discovered                          │  │   │
│ │  │    [Edit] [Test] [Disconnect] [Delete]         │  │   │
│ │  └────────────────────────────────────────────────┘  │   │
│ │  ┌────────────────────────────────────────────────┐  │   │
│ │  │ 🤖 Local Filesystem MCP        [Running ●]     │  │   │
│ │  │    stdio: npx @modelcontextprotocol/server-fs  │  │   │
│ │  │    4 tools discovered                           │  │   │
│ │  │    [Edit] [Restart] [Stop] [Delete]            │  │   │
│ │  └────────────────────────────────────────────────┘  │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                              │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ 2. DISCOVERED TOOLS                                   │   │
│ │                                                        │   │
│ │  [Filter by server ▾] [Show: All ▾] [Search...]      │   │
│ │  ─────────────────────────────────────────────────────│   │
│ │  Total: 27 tools | Enabled: 25 | Available to LLM: 25│   │
│ │                                                        │   │
│ │  Home Assistant (23)                                  │   │
│ │   ☑ light.turn_on               Confirmation: None   │   │
│ │   ☑ light.turn_off              Confirmation: None   │   │
│ │   ☑ climate.set_temperature     Confirmation: Notify │   │
│ │   ☑ lock.lock                   Confirmation: Required│  │
│ │   ☐ script.factory_reset        [Disabled by user]   │   │
│ │                                                        │   │
│ │  Local Filesystem (4)                                 │   │
│ │   ☑ fs.read_file                Confirmation: None   │   │
│ │   ☑ fs.list_directory           Confirmation: None   │   │
│ │   ☑ fs.write_file               Confirmation: Confirm│   │
│ │   ☑ fs.delete_file              Confirmation: Required│  │
│ └──────────────────────────────────────────────────────┘   │
│                                                              │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ 3. LLM INTEGRATION STATUS                             │   │
│ │                                                        │   │
│ │  ● Tools are synced to OpenAI Realtime API            │   │
│ │  ● 25 tools available for function calling            │   │
│ │  ● Last sync: 2 minutes ago                           │   │
│ │                                          [Refresh Now]│   │
│ └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 Add Server Dialog

When clicking "[+ Add Server]", show a modal dialog:

```
┌─────────────────────────────────────────────────────┐
│ Add MCP Server                                  [×] │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Server Name:                                        │
│ ┌─────────────────────────────────────────────────┐│
│ │ My MCP Server                                   ││
│ └─────────────────────────────────────────────────┘│
│                                                     │
│ Transport Type:                                     │
│ ○ SSE (Server-Sent Events)                         │
│ ● stdio (Node.js command)                          │
│                                                     │
│ ┌─ SSE Configuration ─────────────────────────────┐│
│ │ URL:                                            ││
│ │ ┌─────────────────────────────────────────────┐││
│ │ │ http://localhost:8123/api/mcp              │││
│ │ └─────────────────────────────────────────────┘││
│ │                                                 ││
│ │ Authentication (optional):                      ││
│ │ Header Name:  [Authorization ▾]                ││
│ │ Token/Value:  [•••••••••••••••]                ││
│ └─────────────────────────────────────────────────┘│
│                                                     │
│ ┌─ stdio Configuration ──────────────────────────┐│
│ │ Command:                                        ││
│ │ ┌─────────────────────────────────────────────┐││
│ │ │ npx                                         │││
│ │ └─────────────────────────────────────────────┘││
│ │                                                 ││
│ │ Arguments (one per line):                       ││
│ │ ┌─────────────────────────────────────────────┐││
│ │ │ -y                                          │││
│ │ │ @modelcontextprotocol/server-github        │││
│ │ └─────────────────────────────────────────────┘││
│ │                                                 ││
│ │ Environment Variables (JSON):                   ││
│ │ ┌─────────────────────────────────────────────┐││
│ │ │ {                                           │││
│ │ │   "GITHUB_TOKEN": "ghp_..."                │││
│ │ │ }                                           │││
│ │ └─────────────────────────────────────────────┘││
│ └─────────────────────────────────────────────────┘│
│                                                     │
│ ☐ Auto-start on application launch                 │
│                                                     │
│             [Cancel]  [Test Connection]  [Add]     │
└─────────────────────────────────────────────────────┘
```

**Paste Configuration Support**: Users can also paste JSON configuration (Claude Desktop format or custom):

```
┌─────────────────────────────────────────────────────┐
│ Or paste MCP server configuration:                  │
│ ┌─────────────────────────────────────────────────┐│
│ │ {                                               ││
│ │   "mcpServers": {                               ││
│ │     "github": {                                 ││
│ │       "command": "npx",                         ││
│ │       "args": ["-y", "@modelcontextprotocol/... ││
│ │       "env": { "GITHUB_TOKEN": "..." }          ││
│ │     }                                            ││
│ │   }                                              ││
│ │ }                                                ││
│ └─────────────────────────────────────────────────┘│
│                            [Parse & Import]         │
└─────────────────────────────────────────────────────┘
```

## 2. Data Architecture

### 2.1 Database Schema

**File**: `app/main/src/db/migrations/004-mcp-tables.sql` (new migration)

```sql
-- MCP server configurations
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,                    -- UUID
  name TEXT NOT NULL,                     -- User-friendly name
  transport_type TEXT NOT NULL,           -- 'sse' | 'stdio'

  -- SSE-specific fields
  sse_url TEXT,                           -- e.g., "http://localhost:8123/api/mcp"
  sse_auth_header TEXT,                   -- e.g., "Authorization"
  sse_auth_token_encrypted TEXT,          -- Encrypted token

  -- stdio-specific fields
  stdio_command TEXT,                     -- e.g., "npx"
  stdio_args_json TEXT,                   -- JSON array of args
  stdio_env_json_encrypted TEXT,          -- Encrypted JSON of env vars

  -- Common fields
  enabled INTEGER DEFAULT 1,              -- 0 or 1
  auto_start INTEGER DEFAULT 0,           -- 0 or 1
  connection_status TEXT DEFAULT 'disconnected',  -- 'connected' | 'disconnected' | 'error'
  last_error TEXT,                        -- Last error message if any
  tools_discovered INTEGER DEFAULT 0,     -- Count of tools
  last_connected_at INTEGER,              -- Unix timestamp
  created_at INTEGER NOT NULL,            -- Unix timestamp
  updated_at INTEGER NOT NULL             -- Unix timestamp
);

-- MCP tools discovered from servers
CREATE TABLE IF NOT EXISTS mcp_tools (
  id TEXT PRIMARY KEY,                    -- server_id:tool_name
  server_id TEXT NOT NULL,                -- Foreign key to mcp_servers
  tool_name TEXT NOT NULL,                -- Tool identifier
  display_name TEXT,                      -- User-friendly name
  description TEXT,                       -- Tool description for LLM
  input_schema_json TEXT NOT NULL,        -- JSON schema for parameters

  -- User preferences
  enabled INTEGER DEFAULT 1,              -- 0 or 1
  confirmation_level TEXT DEFAULT 'none', -- 'none' | 'notify' | 'confirm' | 'block'
  custom_description TEXT,                -- User override of description

  discovered_at INTEGER NOT NULL,         -- Unix timestamp
  updated_at INTEGER NOT NULL,            -- Unix timestamp

  FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools(server_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_enabled ON mcp_tools(enabled);

-- Tool execution audit log
CREATE TABLE IF NOT EXISTS mcp_tool_executions (
  id TEXT PRIMARY KEY,                    -- UUID
  tool_id TEXT NOT NULL,                  -- Foreign key to mcp_tools
  params_json TEXT,                       -- JSON of parameters passed
  result_json TEXT,                       -- JSON of result
  error_message TEXT,                     -- If failed
  status TEXT NOT NULL,                   -- 'success' | 'error' | 'cancelled'
  duration_ms INTEGER,                    -- Execution time
  triggered_by TEXT,                      -- 'voice' | 'manual' | 'automation'
  executed_at INTEGER NOT NULL,           -- Unix timestamp

  FOREIGN KEY (tool_id) REFERENCES mcp_tools(id)
);

CREATE INDEX IF NOT EXISTS idx_executions_executed_at ON mcp_tool_executions(executed_at);
```

### 2.2 TypeScript Interfaces

**File**: `app/main/src/mcp/types.ts` (new file)

```typescript
import type { JSONSchema } from '../types/json-schema.js';

// MCP Server Configuration
export interface MCPServerConfig {
  id: string;
  name: string;
  transportType: 'sse' | 'stdio';

  // SSE config
  sseUrl?: string;
  sseAuthHeader?: string;
  sseAuthToken?: string;  // Will be encrypted in DB

  // stdio config
  stdioCommand?: string;
  stdioArgs?: string[];
  stdioEnv?: Record<string, string>;  // Will be encrypted in DB

  // Common
  enabled: boolean;
  autoStart: boolean;
  connectionStatus: 'connected' | 'disconnected' | 'error';
  lastError?: string;
  toolsDiscovered: number;
  lastConnectedAt?: number;
  createdAt: number;
  updatedAt: number;
}

// Input type for creating/updating servers (omits computed fields)
export type MCPServerConfigInput = Omit<
  MCPServerConfig,
  'id' | 'connectionStatus' | 'lastError' | 'toolsDiscovered' | 'lastConnectedAt' | 'createdAt' | 'updatedAt'
>;

// MCP Tool Definition
export interface MCPTool {
  id: string;  // server_id:tool_name
  serverId: string;
  toolName: string;
  displayName?: string;
  description: string;
  inputSchema: JSONSchema;

  // User preferences
  enabled: boolean;
  confirmationLevel: 'none' | 'notify' | 'confirm' | 'block';
  customDescription?: string;

  discoveredAt: number;
  updatedAt: number;
}

// MCP Tool Summary (for renderer)
export interface MCPToolSummary {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  displayName: string;
  description: string;
  enabled: boolean;
  confirmationLevel: string;
}

// Tool execution result
export interface MCPToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
}

// Server connection result
export interface MCPConnectionResult {
  success: boolean;
  toolsDiscovered?: number;
  error?: string;
}

// MCP Protocol Types (from spec)
export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
}

export interface MCPListToolsResult {
  tools: MCPToolDefinition[];
}

export interface MCPCallToolRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MCPCallToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
```

## 3. Main Process Architecture

### 3.1 MCP Manager Service

**File**: `app/main/src/mcp/mcp-manager.ts` (new file)

Manages all MCP server connections and tool discovery.

```typescript
import type { Database } from 'better-sqlite3';
import type { MCPServerConfig, MCPServerConfigInput, MCPToolSummary, MCPConnectionResult, MCPToolResult } from './types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { EventEmitter } from 'node:events';
import { SSEMCPClient } from './clients/sse-client.js';
import { StdioMCPClient } from './clients/stdio-client.js';
import type { MCPClient } from './clients/base-client.js';
import { randomUUID } from 'node:crypto';
import { encryptToken, decryptToken } from './encryption.js';

export class MCPManager extends EventEmitter {
  private clients: Map<string, MCPClient> = new Map();
  private toolRegistry: ToolRegistry;
  private db: Database;

  constructor(db: Database, toolRegistry: ToolRegistry) {
    super();
    this.db = db;
    this.toolRegistry = toolRegistry;
  }

  async initialize(): Promise<void> {
    // Load all enabled servers from DB
    const servers = this.loadServersFromDB();

    // Auto-start servers where autoStart = true
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

  async addServer(config: MCPServerConfigInput): Promise<MCPServerConfig> {
    const id = randomUUID();
    const now = Date.now();

    // Encrypt sensitive fields
    const sseAuthTokenEncrypted = config.sseAuthToken
      ? encryptToken(config.sseAuthToken)
      : null;
    const stdioEnvEncrypted = config.stdioEnv
      ? encryptToken(JSON.stringify(config.stdioEnv))
      : null;

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
      id, config.name, config.transportType,
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
      now, now
    );

    return this.getServerById(id)!;
  }

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

  async deleteServer(serverId: string): Promise<void> {
    // Disconnect if connected
    await this.disconnectServer(serverId);

    // Delete from database (cascade will delete tools)
    const stmt = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?');
    stmt.run(serverId);
  }

  listServers(): MCPServerConfig[] {
    return this.loadServersFromDB();
  }

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

    const rows = stmt.all() as any[];
    return rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      toolName: row.tool_name,
      displayName: row.display_name || row.tool_name,
      description: row.custom_description || row.description,
      enabled: Boolean(row.enabled),
      confirmationLevel: row.confirmation_level
    }));
  }

  async updateToolPreferences(
    toolId: string,
    prefs: { enabled?: boolean; confirmationLevel?: string; customDescription?: string }
  ): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [];

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

  // Private helper methods

  private loadServersFromDB(): MCPServerConfig[] {
    const stmt = this.db.prepare('SELECT * FROM mcp_servers ORDER BY name');
    const rows = stmt.all() as any[];

    return rows.map(row => {
      const config: MCPServerConfig = {
        id: row.id,
        name: row.name,
        transportType: row.transport_type,
        enabled: Boolean(row.enabled),
        autoStart: Boolean(row.auto_start),
        connectionStatus: row.connection_status,
        lastError: row.last_error,
        toolsDiscovered: row.tools_discovered,
        lastConnectedAt: row.last_connected_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };

      // Decrypt and add SSE fields
      if (config.transportType === 'sse') {
        config.sseUrl = row.sse_url;
        config.sseAuthHeader = row.sse_auth_header;
        if (row.sse_auth_token_encrypted) {
          config.sseAuthToken = decryptToken(row.sse_auth_token_encrypted);
        }
      }

      // Decrypt and add stdio fields
      if (config.transportType === 'stdio') {
        config.stdioCommand = row.stdio_command;
        if (row.stdio_args_json) {
          config.stdioArgs = JSON.parse(row.stdio_args_json);
        }
        if (row.stdio_env_json_encrypted) {
          config.stdioEnv = JSON.parse(decryptToken(row.stdio_env_json_encrypted));
        }
      }

      return config;
    });
  }

  private getServerById(id: string): MCPServerConfig | undefined {
    return this.loadServersFromDB().find(s => s.id === id);
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

    const rows = stmt.all(serverId) as any[];
    return rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      toolName: row.tool_name,
      displayName: row.display_name || row.tool_name,
      description: row.custom_description || row.description,
      enabled: Boolean(row.enabled),
      confirmationLevel: row.confirmation_level
    }));
  }

  private getToolById(id: string): any {
    const stmt = this.db.prepare('SELECT * FROM mcp_tools WHERE id = ?');
    return stmt.get(id);
  }

  private createClient(config: MCPServerConfig): MCPClient {
    if (config.transportType === 'sse') {
      return new SSEMCPClient(
        config.sseUrl!,
        config.sseAuthHeader,
        config.sseAuthToken
      );
    } else {
      return new StdioMCPClient(
        config.stdioCommand!,
        config.stdioArgs || [],
        config.stdioEnv || {}
      );
    }
  }

  private async registerTool(serverId: string, toolDef: any): Promise<void> {
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
      now
    );

    // Register with ToolRegistry
    const tool = this.getToolById(toolId);
    if (tool) {
      await this.registerToolFromDB(tool);
    }
  }

  private async registerToolFromDB(dbTool: any): Promise<void> {
    const client = this.clients.get(dbTool.server_id);
    if (!client) return;

    this.toolRegistry.register({
      id: dbTool.id,
      serverId: dbTool.server_id,
      toolName: dbTool.tool_name,
      description: dbTool.custom_description || dbTool.description,
      inputSchema: JSON.parse(dbTool.input_schema_json),
      enabled: Boolean(dbTool.enabled),
      confirmationLevel: dbTool.confirmation_level,
      execute: async (params: unknown) => {
        return await client.callTool(dbTool.tool_name, params);
      }
    });
  }
}
```

### 3.2 Tool Registry

**File**: `app/main/src/tools/tool-registry.ts` (new file)

```typescript
import { EventEmitter } from 'node:events';
import type { JSONSchema } from '../types/json-schema.js';

export interface RegisteredTool {
  id: string;
  serverId: string;
  toolName: string;
  description: string;
  inputSchema: JSONSchema;
  enabled: boolean;
  confirmationLevel: 'none' | 'notify' | 'confirm' | 'block';
  execute: (params: unknown) => Promise<unknown>;
}

export interface OpenAIFunction {
  type: 'function';
  name: string;
  description: string;
  parameters: JSONSchema;
}

export class ToolRegistry extends EventEmitter {
  private tools: Map<string, RegisteredTool> = new Map();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.id, tool);
    this.emit('tools-changed');
  }

  unregister(toolId: string): void {
    this.tools.delete(toolId);
    this.emit('tools-changed');
  }

  list(): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(t => t.enabled);
  }

  get(toolId: string): RegisteredTool | undefined {
    return this.tools.get(toolId);
  }

  async execute(toolId: string, params: unknown): Promise<{ success: boolean; data?: unknown; error?: string; durationMs: number }> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }
    if (!tool.enabled) {
      throw new Error(`Tool disabled: ${toolId}`);
    }

    const startTime = Date.now();
    try {
      const result = await tool.execute(params);
      return { success: true, data: result, durationMs: Date.now() - startTime };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMsg,
        durationMs: Date.now() - startTime
      };
    }
  }

  getOpenAIFunctionDefinitions(): OpenAIFunction[] {
    return this.list().map(tool => ({
      type: 'function',
      name: tool.toolName,
      description: tool.description,
      parameters: tool.inputSchema
    }));
  }
}
```

### 3.3 Token Encryption

**File**: `app/main/src/mcp/encryption.ts` (new file)

```typescript
import { safeStorage } from 'electron';

export function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available on this platform');
  }
  const buffer = safeStorage.encryptString(token);
  return buffer.toString('base64');
}

export function decryptToken(encrypted: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available on this platform');
  }
  const buffer = Buffer.from(encrypted, 'base64');
  return safeStorage.decryptString(buffer);
}
```

## 4. MCP Client Implementations

### 4.1 Base Client Interface

**File**: `app/main/src/mcp/clients/base-client.ts` (new file)

```typescript
import type { MCPToolDefinition } from '../types.js';

export interface MCPClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  onToolsChanged?(callback: () => void): void;
}
```

### 4.2 stdio Client (Phase 2 Implementation)

**File**: `app/main/src/mcp/clients/stdio-client.ts` (new file, stub for now)

```typescript
import type { MCPClient } from './base-client.js';
import type { MCPToolDefinition } from '../types.js';

export class StdioMCPClient implements MCPClient {
  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>
  ) {}

  async connect(): Promise<void> {
    // TODO: Phase 2 - Spawn child process and initialize MCP protocol
    throw new Error('stdio client not yet implemented');
  }

  async disconnect(): Promise<void> {
    // TODO: Phase 2 - Kill process gracefully
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    // TODO: Phase 2 - Send tools/list JSON-RPC request
    return [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    // TODO: Phase 2 - Send tools/call JSON-RPC request
    throw new Error('stdio client not yet implemented');
  }
}
```

### 4.3 SSE Client (Phase 3 Implementation)

**File**: `app/main/src/mcp/clients/sse-client.ts` (new file, stub for now)

```typescript
import type { MCPClient } from './base-client.js';
import type { MCPToolDefinition } from '../types.js';

export class SSEMCPClient implements MCPClient {
  constructor(
    private url: string,
    private authHeader?: string,
    private authToken?: string
  ) {}

  async connect(): Promise<void> {
    // TODO: Phase 3 - Establish SSE connection
    throw new Error('SSE client not yet implemented');
  }

  async disconnect(): Promise<void> {
    // TODO: Phase 3 - Close SSE connection
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    // TODO: Phase 3 - Call tools/list endpoint
    return [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    // TODO: Phase 3 - POST to tools/call endpoint
    throw new Error('SSE client not yet implemented');
  }
}
```

## 5. IPC Bridge

### 5.1 Preload API Extension

**File**: `app/main/src/preload.ts` (additions)

```typescript
// Add to PreloadApi interface (around line 50)
export interface PreloadApi {
  config: ConfigBridge;
  realtime: RealtimeBridge;
  wakeWord: WakeWordBridge;
  conversation?: ConversationBridge;
  metrics?: MetricsBridge;
  avatar?: AvatarBridge;
  camera?: CameraBridge;
  mcp: MCPBridge;  // NEW
  ping(): string;
  __bridgeReady?: boolean;
  __bridgeVersion?: string;
}

// New MCP Bridge interface
export interface MCPBridge {
  // Server management
  listServers(): Promise<MCPServerConfig[]>;
  addServer(config: MCPServerConfigInput): Promise<MCPServerConfig>;
  updateServer(id: string, updates: Partial<MCPServerConfigInput>): Promise<MCPServerConfig>;
  deleteServer(id: string): Promise<void>;
  connectServer(id: string): Promise<MCPConnectionResult>;
  disconnectServer(id: string): Promise<void>;
  testConnection(id: string): Promise<MCPConnectionResult>;

  // Tool management
  listTools(serverId?: string): Promise<MCPToolSummary[]>;
  updateToolPreferences(toolId: string, prefs: {
    enabled?: boolean;
    confirmationLevel?: string;
    customDescription?: string;
  }): Promise<void>;

  // Tool execution (for manual testing)
  executeTool(toolId: string, params: unknown): Promise<MCPToolResult>;

  // Events
  onServerStatusChanged(callback: (event: ServerStatusEvent) => void): () => void;
  onToolsDiscovered(callback: (serverId: string, count: number) => void): () => void;

  // LLM integration
  getToolDefinitionsForLLM(): Promise<OpenAIFunction[]>;
}

export interface ServerStatusEvent {
  serverId: string;
  status: 'connected' | 'disconnected' | 'error';
}

// Import types from mcp/types.ts
import type {
  MCPServerConfig,
  MCPServerConfigInput,
  MCPConnectionResult,
  MCPToolSummary,
  MCPToolResult
} from './mcp/types.js';
import type { OpenAIFunction } from './tools/tool-registry.js';

// Implementation (around line 330, after other bridges)
const mcpBridge: MCPBridge = {
  listServers: () => ipcRenderer.invoke('mcp:list-servers'),
  addServer: (config) => ipcRenderer.invoke('mcp:add-server', config),
  updateServer: (id, updates) => ipcRenderer.invoke('mcp:update-server', id, updates),
  deleteServer: (id) => ipcRenderer.invoke('mcp:delete-server', id),
  connectServer: (id) => ipcRenderer.invoke('mcp:connect-server', id),
  disconnectServer: (id) => ipcRenderer.invoke('mcp:disconnect-server', id),
  testConnection: (id) => ipcRenderer.invoke('mcp:test-connection', id),

  listTools: (serverId?) => ipcRenderer.invoke('mcp:list-tools', serverId),
  updateToolPreferences: (toolId, prefs) =>
    ipcRenderer.invoke('mcp:update-tool-preferences', toolId, prefs),
  executeTool: (toolId, params) =>
    ipcRenderer.invoke('mcp:execute-tool', toolId, params),

  onServerStatusChanged: (callback) => {
    const listener = (_: unknown, event: ServerStatusEvent) => callback(event);
    ipcRenderer.on('mcp:server-status-changed', listener);
    return () => ipcRenderer.removeListener('mcp:server-status-changed', listener);
  },

  onToolsDiscovered: (callback) => {
    const listener = (_: unknown, serverId: string, count: number) =>
      callback(serverId, count);
    ipcRenderer.on('mcp:tools-discovered', listener);
    return () => ipcRenderer.removeListener('mcp:tools-discovered', listener);
  },

  getToolDefinitionsForLLM: () => ipcRenderer.invoke('mcp:get-tool-definitions')
};

// Add to api object (around line 350)
const api: PreloadApi = {
  config: configBridge,
  realtime: realtimeBridge,
  wakeWord: wakeWordBridge,
  conversation: conversationBridge,
  metrics: metricsBridge,
  avatar: avatarBridge,
  camera: cameraBridge,
  mcp: mcpBridge,  // NEW
  ping: () => 'pong',
  __bridgeReady: true,
  __bridgeVersion: '1.0.0'
};
```

## 6. Implementation Phases

### Phase 1: Foundation ✓
- [x] Design document completed
- [ ] Create database schema and migrations
- [ ] Implement `MCPManager` service
- [ ] Create `ToolRegistry` class
- [ ] Set up IPC bridge (`MCPBridge` interface)
- [ ] Register IPC handlers in main process
- [ ] Add basic UI tab structure (empty MCP tab)

### Phase 2: stdio MCP Client
- [ ] Implement `StdioMCPClient` class
- [ ] Add JSON-RPC over stdio protocol
- [ ] Tool discovery from stdio servers
- [ ] Test with `@modelcontextprotocol/server-filesystem`
- [ ] Build "Add Server" dialog UI (stdio only)
- [ ] Implement server connection/disconnection

### Phase 3: SSE MCP Client
- [ ] Implement `SSEMCPClient` class
- [ ] Handle SSE events and tool discovery
- [ ] Test with Home Assistant MCP endpoint
- [ ] Extend "Add Server" dialog for SSE config
- [ ] Add comprehensive error handling

### Phase 4: UI Components
- [ ] Build server list/cards component
- [ ] Build discovered tools list component
- [ ] Add tool enable/disable toggles
- [ ] Add confirmation level dropdowns
- [ ] Implement LLM integration status section
- [ ] Add JSON paste import feature

### Phase 5: LLM Integration
- [ ] Inject tools into Realtime API session config
- [ ] Handle function call responses from LLM
- [ ] Implement tool execution flow
- [ ] Add confirmation dialogs for sensitive tools
- [ ] Send function results back to LLM
- [ ] Test end-to-end voice → tool call → response

### Phase 6: Security & Polish
- [ ] Implement audit logging (executions table)
- [ ] Add execution history view in UI
- [ ] Security review of token storage
- [ ] Error recovery and retry logic
- [ ] Performance optimization

### Phase 7: Documentation & Testing
- [ ] Unit tests for MCP clients
- [ ] Integration tests for tool registry
- [ ] E2E tests for UI workflows
- [ ] User documentation
- [ ] Example configurations

## Security Considerations

### Token Storage
- All tokens and sensitive environment variables encrypted using Electron's `safeStorage`
- Database stores only encrypted values
- Decryption happens in memory only when needed

### Confirmation Levels

| Level | When | UX |
|-------|------|----|
| **none** | Read-only queries | Silent execution |
| **notify** | Safe mutations (lights) | TTS confirmation after |
| **confirm** | Sensitive actions (locks) | Require user approval |
| **block** | Dangerous operations | Disabled by policy |

### Audit Logging
- All tool executions logged to `mcp_tool_executions` table
- Includes parameters, results, duration, timestamp
- Queryable for debugging and security review

## Success Criteria

### MVP Requirements
- ✅ User can add MCP servers via UI
- ✅ Tools are discovered and displayed
- ✅ Tools are injected into Realtime API
- ✅ Voice commands trigger tool execution
- ✅ Results are vocalized back
- ✅ Sensitive tools require confirmation

### Quality Metrics
- Database queries < 50ms
- Tool discovery < 2 seconds
- Tool execution latency < 500ms (excluding external API)
- UI remains responsive during operations
- No plain-text secrets in logs or database

## References

- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Home Assistant MCP Server](https://www.home-assistant.io/integrations/mcp_server)
- [Existing Plugin/Tool System Design](01-plugin-tool-system.md)
