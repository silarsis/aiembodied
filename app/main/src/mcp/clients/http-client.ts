import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { MCPClient } from './base-client.js';
import type { MCPToolDefinition } from '../types.js';
import { normalizeCallToolResult, normalizeToolList, toolsChangedOptions } from './mcp-response.js';

/** Optional ways to prove who we are to the server. Use at most one of the two. */
export interface HttpClientAuth {
  /** A fixed header, e.g. `Authorization: Bearer abc`. Used when both name and token are set. */
  headerName?: string;
  headerToken?: string;
  /** OAuth sign-in (the SDK adds tokens, refreshes them and reports UnauthorizedError). */
  authProvider?: OAuthClientProvider;
}

/**
 * MCP client for remote servers that use the Streamable HTTP transport (the current MCP standard
 * for web servers; SSE is the older one).
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http
 */
export class HTTPMCPClient implements MCPClient {
  private client: Client | null = null;
  // Kept after a failed connect on purpose: sign-in needs it for finishAuth().
  private transport: StreamableHTTPClientTransport | null = null;
  private toolsChangedCallback: (() => void) | null = null;
  private closedCallback: ((detail?: string) => void) | null = null;

  constructor(
    private url: string,
    private auth: HttpClientAuth = {},
  ) {}

  async connect(): Promise<void> {
    const client = new Client(
      { name: 'aiembodied-client', version: '1.0.0' },
      toolsChangedOptions(() => this.toolsChangedCallback?.()),
    );
    // The session ended (not our own disconnect(), which clears this first).
    client.onclose = () => this.closedCallback?.();

    const headers: Record<string, string> = {};
    if (this.auth.headerName && this.auth.headerToken) {
      headers[this.auth.headerName] = this.auth.headerToken;
    }

    // A fresh transport each time: the SDK cannot restart one that has failed.
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      authProvider: this.auth.authProvider,
    });
    this.transport = transport;
    this.client = client;

    try {
      await client.connect(transport);
    } catch (error) {
      this.closedCallback = null;
      this.client = null;
      throw error;
    }
  }

  /**
   * Finish an OAuth sign-in: trade the code from the browser for tokens.
   * Call after connect() failed with UnauthorizedError, then connect with a new client.
   */
  async finishAuth(authorizationCode: string): Promise<void> {
    if (!this.transport) {
      throw new Error('HTTP MCP client has no connection attempt to finish');
    }
    await this.transport.finishAuth(authorizationCode);
  }

  async disconnect(): Promise<void> {
    // Our own close must not look like a dropped session.
    this.closedCallback = null;
    this.toolsChangedCallback = null;
    const client = this.client;
    this.client = null;
    const transport = this.transport;
    this.transport = null;
    try {
      if (client) {
        await client.close();
      } else if (transport) {
        await transport.close();
      }
    } catch (error) {
      console.error('Error disconnecting HTTP MCP client:', error);
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.client) {
      throw new Error('HTTP MCP client not connected');
    }
    try {
      const response = await this.client.listTools();
      return normalizeToolList(response.tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list tools from HTTP MCP server: ${message}`);
    }
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.client) {
      throw new Error('HTTP MCP client not connected');
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
