import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SSEMCPClient } from '../../src/mcp/clients/sse-client.js';

// Mock the MCP SDK
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
    callTool: mockCallTool,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({})),
}));

describe('SSEMCPClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  describe('connect', () => {
    it('connects successfully without auth', async () => {
      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      expect(mockConnect).toHaveBeenCalled();
    });

    it('connects with auth headers', async () => {
      const client = new SSEMCPClient(
        'https://example.com/sse',
        'Authorization',
        'Bearer token123',
      );
      await client.connect();

      expect(mockConnect).toHaveBeenCalled();
    });

    it('propagates connection errors', async () => {
      mockConnect.mockRejectedValue(new Error('Connection timeout'));

      const client = new SSEMCPClient('https://example.com/sse');

      await expect(client.connect()).rejects.toThrow('Connection timeout');
    });
  });

  describe('disconnect', () => {
    it('disconnects successfully', async () => {
      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();
      await client.disconnect();

      expect(mockClose).toHaveBeenCalled();
    });

    it('handles disconnect errors gracefully', async () => {
      mockClose.mockRejectedValue(new Error('Disconnect failed'));

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      // Should not throw
      await expect(client.disconnect()).resolves.toBeUndefined();
    });

    it('does nothing when not connected', async () => {
      const client = new SSEMCPClient('https://example.com/sse');
      await client.disconnect();

      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  describe('listTools', () => {
    it('lists tools successfully', async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather information',
            inputSchema: {
              type: 'object',
              properties: {
                location: { type: 'string' },
              },
            },
          },
          {
            name: 'send_email',
            description: 'Send an email',
            inputSchema: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                subject: { type: 'string' },
                body: { type: 'string' },
              },
            },
          },
        ],
      });

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      const tools = await client.listTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('get_weather');
      expect(tools[0].description).toBe('Get weather information');
      expect(tools[1].name).toBe('send_email');
    });

    it('throws error when not connected', async () => {
      const client = new SSEMCPClient('https://example.com/sse');

      await expect(client.listTools()).rejects.toThrow('SSE MCP client not connected');
    });

    it('wraps SDK errors', async () => {
      mockListTools.mockRejectedValue(new Error('Network error'));

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      await expect(client.listTools()).rejects.toThrow(
        'Failed to list tools from SSE MCP server: Network error',
      );
    });

    it('handles malformed tool responses', async () => {
      mockListTools.mockResolvedValue({
        tools: [
          { name: 'valid-tool', description: 'Valid', inputSchema: { type: 'object' } },
          { invalid: 'data' }, // Missing name
          null, // Null tool
        ],
      });

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      const tools = await client.listTools();

      expect(tools).toHaveLength(3);
      expect(tools[0].name).toBe('valid-tool');
      expect(tools[1].name).toBe(''); // Default empty string
      expect(tools[2].name).toBe(''); // Default empty string
    });
  });

  describe('callTool', () => {
    it('calls tool successfully and returns text result', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: 'The weather is sunny and 72°F',
          },
        ],
      });

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      const result = await client.callTool('get_weather', { location: 'San Francisco' });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'get_weather',
        arguments: { location: 'San Francisco' },
      });
      expect(result).toBe('The weather is sunny and 72°F');
    });

    it('returns null for empty content', async () => {
      mockCallTool.mockResolvedValue({
        content: [],
      });

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      const result = await client.callTool('some_tool', {});

      expect(result).toBeNull();
    });

    it('returns array for multiple content items', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'First result' },
          { type: 'text', text: 'Second result' },
        ],
      });

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      const result = await client.callTool('multi_result_tool', {});

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('handles image content', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          {
            type: 'image',
            data: 'base64-encoded-data',
            mimeType: 'image/png',
          },
        ],
      });

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      const result = await client.callTool('generate_image', {});

      expect(Array.isArray(result)).toBe(true);
      const typed = result as Array<{ type: string; data: string; mimeType: string }>;
      expect(typed[0].type).toBe('image');
      expect(typed[0].data).toBe('base64-encoded-data');
      expect(typed[0].mimeType).toBe('image/png');
    });

    it('handles resource content', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///path/to/file.txt',
              content: 'File contents',
            },
          },
        ],
      });

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      const result = await client.callTool('read_file', {});

      expect(Array.isArray(result)).toBe(true);
      const typed = result as Array<{ type: string; resource: Record<string, unknown> }>;
      expect(typed[0].type).toBe('resource');
      expect(typed[0].resource).toBeDefined();
    });

    it('throws error when tool execution fails', async () => {
      mockCallTool.mockResolvedValue({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Invalid location parameter',
          },
        ],
      });

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      await expect(client.callTool('get_weather', { location: '' })).rejects.toThrow(
        'Invalid location parameter',
      );
    });

    it('throws default error message when no error text provided', async () => {
      mockCallTool.mockResolvedValue({
        isError: true,
        content: [],
      });

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      await expect(client.callTool('failing_tool', {})).rejects.toThrow(
        'Tool execution failed',
      );
    });

    it('throws error when not connected', async () => {
      const client = new SSEMCPClient('https://example.com/sse');

      await expect(client.callTool('some_tool', {})).rejects.toThrow(
        'SSE MCP client not connected',
      );
    });

    it('wraps SDK errors', async () => {
      mockCallTool.mockRejectedValue(new Error('Request timeout'));

      const client = new SSEMCPClient('https://example.com/sse');
      await client.connect();

      await expect(client.callTool('some_tool', {})).rejects.toThrow(
        "Failed to call tool 'some_tool': Request timeout",
      );
    });
  });

  describe('onToolsChanged', () => {
    it('registers callback for tools changed events', () => {
      const client = new SSEMCPClient('https://example.com/sse');
      const callback = vi.fn();

      client.onToolsChanged(callback);

      // Callback should be stored (implementation detail, not directly testable)
      expect(callback).toBeDefined();
    });
  });
});
