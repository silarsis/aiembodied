import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { HTTPMCPClient } from '../../src/mcp/clients/http-client.js';

/**
 * Talks to a real in-process Streamable HTTP MCP server on a random port.
 * `requiredHeader` makes the server answer 401 unless that header has the expected value.
 */
async function startServer(requiredHeader?: { name: string; value: string }) {
  const seenHeaders: Array<IncomingMessage['headers']> = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const makeMcp = () => {
    const mcp = new McpServer({ name: 'http-fixture', version: '1.0.0' });
    mcp.registerTool(
      'echo',
      { description: 'Echo', inputSchema: { message: z.string() } },
      async ({ message }) => ({
        content: [{ type: 'text', text: `echo: ${message}` }],
      }),
    );
    return mcp;
  };

  const http: Server = createServer(async (req, res) => {
    seenHeaders.push(req.headers);
    if (requiredHeader && req.headers[requiredHeader.name.toLowerCase()] !== requiredHeader.value) {
      res
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport!),
      });
      await makeMcp().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenHeaders,
    close: async () => {
      for (const t of transports.values()) await t.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

describe('HTTPMCPClient (Streamable HTTP)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let client: HTTPMCPClient | null = null;

  beforeEach(() => {
    client = null;
  });

  afterEach(async () => {
    await client?.disconnect();
    await server?.close();
  });

  it('connects without auth, lists tools and calls one', async () => {
    server = await startServer();
    client = new HTTPMCPClient(server.url);
    await client.connect();

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(await client.callTool('echo', { message: 'hello' })).toBe('echo: hello');
  });

  it('sends a static header token', async () => {
    server = await startServer({ name: 'Authorization', value: 'Bearer secret' });
    client = new HTTPMCPClient(server.url, {
      headerName: 'Authorization',
      headerToken: 'Bearer secret',
    });
    await client.connect();
    expect(await client.callTool('echo', { message: 'x' })).toBe('echo: x');
    expect(server.seenHeaders.every((h) => h.authorization === 'Bearer secret')).toBe(true);
  });

  it('fails to connect when the header token is wrong', async () => {
    server = await startServer({ name: 'Authorization', value: 'Bearer secret' });
    client = new HTTPMCPClient(server.url, {
      headerName: 'Authorization',
      headerToken: 'Bearer wrong',
    });
    await expect(client.connect()).rejects.toThrow();
  });

  it('refuses calls before connecting', async () => {
    server = await startServer();
    client = new HTTPMCPClient(server.url);
    await expect(client.callTool('echo', {})).rejects.toThrow(/not connected/);
  });
});
