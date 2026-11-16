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

export type MCPConnectionStatus = 'connected' | 'disconnected' | 'error' | 'needs-sign-in';

// MCP Server Configuration (main process only: it holds decrypted secrets)
export interface MCPServerConfig {
  id: string;
  name: string;
  transportType: 'sse' | 'stdio' | 'http';

  // Streamable HTTP config (the current standard for remote servers)
  httpUrl?: string;
  httpAuthHeader?: string;
  httpAuthToken?: string; // Will be encrypted in DB
  oauth?: boolean; // Sign in with the browser (OAuth 2.1); tokens live in the mcp_oauth table
  oauthScope?: string; // Scope to ask for, e.g. 'papers:read'

  // SSE config (the older web transport)
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
  connectionStatus: MCPConnectionStatus;
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

/**
 * What the renderer is allowed to see of a server: the same as MCPServerConfig but with every secret
 * (header tokens, program environment values) replaced by a flag or the names only.
 */
export type MCPServerSummary = Omit<MCPServerConfig, 'sseAuthToken' | 'httpAuthToken' | 'stdioEnv'> & {
  hasAuthToken: boolean; // A header token is stored (SSE or HTTP)
  stdioEnvKeys?: string[]; // Names of the environment variables, never their values
};

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
  toolName: string; // Name on the server
  llmName: string; // Name the assistant sees (cleaned up, prefixed when it would clash)
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
