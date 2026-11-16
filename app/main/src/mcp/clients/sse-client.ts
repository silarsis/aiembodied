import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { MCPClient } from './base-client.js';
import type { MCPToolDefinition } from '../types.js';
import { normalizeCallToolResult, normalizeToolList, toolsChangedOptions } from './mcp-response.js';

/**
 * MCP client that communicates via Server-Sent Events (SSE) transport.
 * Used for HTTP-based MCP servers like Home Assistant.
 *
 * @see https://spec.modelcontextprotocol.io/specification/basic/transports/#http-with-sse
 */
export class SSEMCPClient implements MCPClient {
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private toolsChangedCallback: (() => void) | null = null;
  private closedCallback: ((detail?: string) => void) | null = null;

  constructor(
    private url: string,
    private authHeader?: string,
    private authToken?: string,
  ) {}

  async connect(): Promise<void> {
    // Create the MCP client with tools listChanged handler
    this.client = new Client(
      { name: 'aiembodied-client', version: '1.0.0' },
      toolsChangedOptions(() => this.toolsChangedCallback?.()),
    );
    // The stream dropped (not our own disconnect(), which clears this first).
    this.client.onclose = () => this.closedCallback?.();

    // Parse URL and add auth headers if provided
    const urlObj = new URL(this.url);

    // Create SSE transport with auth headers
    const headers: Record<string, string> = {};
    if (this.authHeader && this.authToken) {
      headers[this.authHeader] = this.authToken;
    }

    this.transport = new SSEClientTransport(urlObj, {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });

    // Connect to the server
    await this.client.connect(this.transport);
  }

  async disconnect(): Promise<void> {
    // Our own close must not look like a dropped connection.
    this.closedCallback = null;
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        // Ignore errors on disconnect
        console.error('Error disconnecting SSE MCP client:', error);
      }
      this.client = null;
    }
    this.transport = null;
    this.toolsChangedCallback = null;
    this.closedCallback = null;
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.client) {
      throw new Error('SSE MCP client not connected');
    }

    try {
      const response = await this.client.listTools();
      return normalizeToolList(response.tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list tools from SSE MCP server: ${message}`);
    }
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.client) {
      throw new Error('SSE MCP client not connected');
    }

    try {
      const response = await this.client.callTool({
        name,
        arguments: args as Record<string, unknown>,
      });
      return normalizeCallToolResult(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to call tool '${name}': ${message}`);
    }
  }

  onToolsChanged(callback: () => void): void {
    this.toolsChangedCallback = callback;
  }

  onClosed(callback: (detail?: string) => void): void {
    this.closedCallback = callback;
  }
}
