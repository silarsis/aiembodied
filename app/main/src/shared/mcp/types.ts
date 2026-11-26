// Types only: shared/ holds what the main process and the renderer both need.

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
  /**
   * Home Assistant: the id of the "Models and servers" home whose token this server uses. Main reads the token
   * at connect time (so changing it there flows through) and it is never stored here or sent to the renderer.
   */
  tokenFromModelServer?: string;

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
  /** True when the tool only reads: the person's choice, else the server's hint, else false. */
  readOnly: boolean;
  /** The person's own choice (null when none), so the UI can tell "chosen" from "guessed". */
  readOnlyOverride: boolean | null;
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
