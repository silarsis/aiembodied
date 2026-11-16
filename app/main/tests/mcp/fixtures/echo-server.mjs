// A tiny MCP server over stdio for the stdio client tests. One tool: echo.
// Modes (first argument): "exit-early" prints to stderr and exits; "crash-after-list" exits when 'die' is called.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const mode = process.argv[2];

if (mode === 'exit-early') {
  console.error('line one of trouble');
  console.error('line two of trouble');
  process.exit(3);
}

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  { description: 'Echo the message back', inputSchema: { message: z.string() } },
  async ({ message }) => ({ content: [{ type: 'text', text: `echo: ${message}` }] }),
);

server.registerTool('fail', { description: 'Always fails', inputSchema: {} }, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'it broke' }],
}));

server.registerTool('env', { description: 'Read an environment variable', inputSchema: { name: z.string() } }, async ({ name }) => ({
  content: [{ type: 'text', text: process.env[name] ?? '(unset)' }],
}));

server.registerTool('die', { description: 'Exit the process', inputSchema: {} }, async () => {
  setTimeout(() => process.exit(1), 10);
  return { content: [{ type: 'text', text: 'bye' }] };
});

await server.connect(new StdioServerTransport());
