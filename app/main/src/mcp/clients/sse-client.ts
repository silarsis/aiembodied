import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { MCPClient } from './base-client.js';
import type { MCPToolDefinition } from '../types.js';

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

  constructor(
    private url: string,
    private authHeader?: string,
    private authToken?: string,
  ) {}

  async connect(): Promise<void> {
    // Create the MCP client with tools listChanged handler
    this.client = new Client(
      {
        name: 'aiembodied-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: () => {
              if (this.toolsChangedCallback) {
                this.toolsChangedCallback();
              }
            },
          },
        },
      },
    );

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
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.client) {
      throw new Error('SSE MCP client not connected');
    }

    try {
      const response = await this.client.listTools();

      // Convert from MCP SDK format to our internal format
      return response.tools.map((tool) => {
        // Safely extract tool properties with type guards
        const name = typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string'
          ? tool.name
          : '';
        const description = typeof tool === 'object' && tool !== null && 'description' in tool && typeof tool.description === 'string'
          ? tool.description
          : undefined;
        const inputSchema = typeof tool === 'object' && tool !== null && 'inputSchema' in tool
          ? tool.inputSchema as MCPToolDefinition['inputSchema']
          : { type: 'object', properties: {} };

        return { name, description, inputSchema };
      });
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

      // Check if the response indicates an error
      const isError = typeof response === 'object' && response !== null && 'isError' in response
        ? Boolean(response.isError)
        : false;

      if (isError) {
        const content = typeof response === 'object' && response !== null && 'content' in response && Array.isArray(response.content)
          ? response.content as unknown[]
          : [];

        let errorMessage = 'Tool execution failed';
        for (const c of content) {
          if (typeof c === 'object' && c !== null && 'type' in c) {
            const cType: unknown = (c as Record<string, unknown>).type;
            if (typeof cType === 'string' && cType === 'text' && 'text' in c) {
              const cText: unknown = (c as Record<string, unknown>).text;
              if (typeof cText === 'string') {
                errorMessage = cText;
                break;
              }
            }
          }
        }
        throw new Error(errorMessage);
      }

      // Extract the result from content
      const content = typeof response === 'object' && response !== null && 'content' in response && Array.isArray(response.content)
        ? response.content as unknown[]
        : [];

      // MCP tools can return multiple content items, we'll combine them
      if (content.length === 0) {
        return null;
      }

      // If single text content, return just the text
      if (content.length === 1) {
        const firstItem: unknown = content[0];
        if (typeof firstItem === 'object' && firstItem !== null && 'type' in firstItem && typeof firstItem.type === 'string' && firstItem.type === 'text' && 'text' in firstItem && typeof firstItem.text === 'string') {
          return firstItem.text;
        }
      }

      // Otherwise return all content items
      return content.map((item: unknown) => {
        if (typeof item !== 'object' || item === null) {
          return { type: 'unknown', data: String(item) };
        }

        if ('type' in item && typeof item.type === 'string' && item.type === 'text' && 'text' in item) {
          return { type: 'text', text: String(item.text) };
        }
        if ('type' in item && typeof item.type === 'string' && item.type === 'image' && 'data' in item && 'mimeType' in item) {
          return { type: 'image', data: String(item.data), mimeType: String(item.mimeType) };
        }
        if ('type' in item && typeof item.type === 'string' && item.type === 'resource' && 'resource' in item) {
          return { type: 'resource', resource: item.resource as Record<string, unknown> };
        }
        return { type: 'unknown', data: item };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to call tool '${name}': ${message}`);
    }
  }

  onToolsChanged(callback: () => void): void {
    this.toolsChangedCallback = callback;
  }
}
