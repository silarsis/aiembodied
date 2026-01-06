import type { MCPToolDefinition } from '../types.js';

/**
 * Base interface for MCP clients.
 * Implementations handle either stdio or SSE transport protocols.
 */
export interface MCPClient {
  /**
   * Establish connection to the MCP server.
   * For stdio: spawns the process and initializes MCP protocol.
   * For SSE: establishes SSE connection and handshake.
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the MCP server.
   * For stdio: terminates the process gracefully.
   * For SSE: closes the SSE connection.
   */
  disconnect(): Promise<void>;

  /**
   * List all available tools from the MCP server.
   * @returns Array of tool definitions
   */
  listTools(): Promise<MCPToolDefinition[]>;

  /**
   * Execute a tool on the MCP server.
   * @param name - The tool name to execute
   * @param args - Arguments to pass to the tool
   * @returns The result from the tool execution
   */
  callTool(name: string, args: unknown): Promise<unknown>;

  /**
   * Optional: Subscribe to tool list changes.
   * @param callback - Called when the server's tool list changes
   */
  onToolsChanged?(callback: () => void): void;
}
