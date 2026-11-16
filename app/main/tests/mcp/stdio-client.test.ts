import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { StdioMCPClient } from '../../src/mcp/clients/stdio-client.js';

/**
 * Integration test: starts a real MCP server (fixtures/echo-server.mjs) as a child process.
 * These tests run inside Electron (see scripts/test-electron.mjs), where process.execPath is the
 * Electron binary, so ELECTRON_RUN_AS_NODE=1 makes that binary behave like plain Node for the child.
 */
const fixture = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));
const childEnv = { ELECTRON_RUN_AS_NODE: '1' };

describe('StdioMCPClient (real child process)', () => {
  let client: StdioMCPClient | null = null;

  afterEach(async () => {
    await client?.disconnect();
    client = null;
  });

  it('connects, lists tools and calls one', async () => {
    client = new StdioMCPClient(process.execPath, [fixture], childEnv);
    await client.connect();

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['echo', 'fail', 'env']));
    expect(tools.find((t) => t.name === 'echo')?.description).toBe('Echo the message back');

    expect(await client.callTool('echo', { message: 'hi' })).toBe('echo: hi');
  });

  it('turns isError results into thrown errors', async () => {
    client = new StdioMCPClient(process.execPath, [fixture], childEnv);
    await client.connect();
    await expect(client.callTool('fail', {})).rejects.toThrow(/it broke/);
  });

  it('passes the configured environment to the program', async () => {
    client = new StdioMCPClient(process.execPath, [fixture], { ...childEnv, MY_SECRET: 'abc123' });
    await client.connect();
    expect(await client.callTool('env', { name: 'MY_SECRET' })).toBe('abc123');
    // The app's PATH is passed on too.
    expect(await client.callTool('env', { name: 'PATH' })).toBe(process.env.PATH);
  });

  it('reports the program output when it fails to start', async () => {
    client = new StdioMCPClient(process.execPath, [fixture, 'exit-early'], childEnv);
    await expect(client.connect()).rejects.toThrow(/line two of trouble/);
  });

  it('reports a missing program', async () => {
    client = new StdioMCPClient('definitely-not-a-real-program-xyz', [], {});
    await expect(client.connect()).rejects.toThrow();
  });

  it('calls onClosed when the program dies, but not on our own disconnect', async () => {
    client = new StdioMCPClient(process.execPath, [fixture], childEnv);
    await client.connect();
    let closed = 0;
    client.onClosed(() => closed++);
    await client.callTool('die', {}).catch(() => undefined);
    await expect.poll(() => closed, { timeout: 5000 }).toBe(1);

    const second = new StdioMCPClient(process.execPath, [fixture], childEnv);
    await second.connect();
    let secondClosed = 0;
    second.onClosed(() => secondClosed++);
    await second.disconnect();
    expect(secondClosed).toBe(0);
  });
});
