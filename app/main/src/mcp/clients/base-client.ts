import type { MCPToolDefinition } from '../types.js';

/**
 * Base interface for MCP clients.
 * Implementations handle stdio, SSE or Streamable HTTP transports.
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

  /**
   * Optional: Called when the connection ends without disconnect() having been called
   * (the stdio process died, the stream dropped, the HTTP session went away).
   * @param callback - Receives a short detail string when there is one (e.g. the last stderr lines)
   */
  onClosed?(callback: (detail?: string) => void): void;
}
