import type { MCPClient } from './base-client.js';
import type { MCPToolDefinition } from '../types.js';

/**
 * MCP client that communicates via stdio (stdin/stdout) transport.
 * Spawns a child process and uses JSON-RPC over stdio to communicate.
 *
 * @see https://spec.modelcontextprotocol.io/specification/basic/transports/#stdio
 */
export class StdioMCPClient implements MCPClient {
  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    // TODO: Phase 2 Implementation
    // - Spawn child process with command, args, and env
    // - Set up stdin/stdout pipes
    // - Initialize MCP protocol handshake (JSON-RPC initialize request)
    // - Wait for initialized notification
    throw new Error('stdio MCP client not yet implemented (Phase 2)');
  }

  async disconnect(): Promise<void> {
    // TODO: Phase 2 Implementation
    // - Send shutdown request
    // - Wait for process to exit gracefully
    // - Kill process if timeout exceeded
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    // TODO: Phase 2 Implementation
    // - Send tools/list JSON-RPC request via stdin
    // - Parse response from stdout
    // - Return array of tool definitions
    return [];
  }

  async callTool(): Promise<unknown> {
    // TODO: Phase 2 Implementation
    // - Send tools/call JSON-RPC request with tool name and arguments
    // - Parse response from stdout
    // - Handle isError flag in response
    // - Extract and return result content
    throw new Error('stdio MCP client not yet implemented (Phase 2)');
  }

  onToolsChanged(): void {
    // TODO: Phase 2 Implementation
    // - Set up handler for tools/list_changed notifications
  }
}
