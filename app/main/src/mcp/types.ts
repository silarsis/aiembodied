import type { JSONSchema } from '../shared/mcp/types.js';


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
  readOnlyHint?: boolean; // What the server said (annotations.readOnlyHint)
  readOnly?: boolean; // The person's own choice; wins over the hint

  discoveredAt: number;
  updatedAt: number;
}

// MCP Protocol Types (from spec)
export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
  /** annotations.readOnlyHint from the server, when it said. */
  readOnlyHint?: boolean;
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
