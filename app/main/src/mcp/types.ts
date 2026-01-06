// JSON Schema type for tool input parameters
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
}

// MCP Server Configuration
export interface MCPServerConfig {
  id: string;
  name: string;
  transportType: 'sse' | 'stdio';

  // SSE config
  sseUrl?: string;
  sseAuthHeader?: string;
  sseAuthToken?: string; // Will be encrypted in DB

  // stdio config
  stdioCommand?: string;
  stdioArgs?: string[];
  stdioEnv?: Record<string, string>; // Will be encrypted in DB

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
  | 'id'
  | 'connectionStatus'
  | 'lastError'
  | 'toolsDiscovered'
  | 'lastConnectedAt'
  | 'createdAt'
  | 'updatedAt'
>;

// MCP Tool Definition
export interface MCPTool {
  id: string; // server_id:tool_name
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
