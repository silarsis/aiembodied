import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPClient } from './base-client.js';
import type { MCPToolDefinition } from '../types.js';
import { normalizeCallToolResult, normalizeToolList, toolsChangedOptions } from './mcp-response.js';

/** How many lines of the program's error output we keep for messages. */
const STDERR_LINES_KEPT = 20;

/**
 * MCP client that talks to a local program over stdin/stdout.
 * The SDK transport starts the program (it uses cross-spawn, so `npx` also works on Windows)
 * and speaks JSON-RPC over its pipes.
 *
 * @see https://spec.modelcontextprotocol.io/specification/basic/transports/#stdio
 */
export class StdioMCPClient implements MCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private toolsChangedCallback: (() => void) | null = null;
  private closedCallback: ((detail?: string) => void) | null = null;
  private stderrLines: string[] = [];
  private stderrPartial = '';

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>,
  ) {}

  /** The last few lines the program wrote to stderr, joined (empty if none). */
  get lastStderr(): string {
    const lines = this.stderrPartial ? [...this.stderrLines, this.stderrPartial] : this.stderrLines;
    return lines.join('\n');
  }

  async connect(): Promise<void> {
    this.stderrLines = [];
    this.stderrPartial = '';

    // The SDK only passes a small safe set of variables (HOME, PATH, ...) by default.
    // We add the app's PATH and then whatever the user configured, which wins.
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    if (process.env.PATH) env.PATH = process.env.PATH;
    Object.assign(env, this.env);

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env,
      stderr: 'pipe',
    });
    this.transport = transport;

    // The SDK hands back its stderr stream right away so early output is not lost.
    transport.stderr?.on('data', (chunk: Buffer | string) => this.collectStderr(chunk.toString()));

    const client = new Client(
      { name: 'aiembodied-client', version: '1.0.0' },
      toolsChangedOptions(() => this.toolsChangedCallback?.()),
    );
    // The program exited (not our own disconnect(), which clears this first).
    client.onclose = () => this.closedCallback?.(this.lastStderr || undefined);
    this.client = client;

    try {
      await client.connect(transport);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.closedCallback = null;
      await this.disconnect();
      const detail = this.lastStderr;
      throw new Error(detail ? `${message}\nProgram output:\n${detail}` : message);
    }
  }

  async disconnect(): Promise<void> {
    // Our own close must not look like a crash.
    this.closedCallback = null;
    const client = this.client;
    this.client = null;
    const transport = this.transport;
    this.transport = null;
    this.toolsChangedCallback = null;
    try {
      if (client) {
        await client.close();
      } else if (transport) {
        await transport.close();
      }
    } catch (error) {
      console.error('Error disconnecting stdio MCP client:', error);
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.client) {
      throw new Error('stdio MCP client not connected');
    }
    try {
      const response = await this.client.listTools();
      return normalizeToolList(response.tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list tools from stdio MCP server: ${message}`);
    }
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.client) {
      throw new Error('stdio MCP client not connected');
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

  /** Split incoming text into lines and keep only the newest few. */
  private collectStderr(text: string): void {
    const parts = (this.stderrPartial + text).split(/\r?\n/);
    this.stderrPartial = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim()) this.stderrLines.push(line);
    }
    if (this.stderrLines.length > STDERR_LINES_KEPT) {
      this.stderrLines = this.stderrLines.slice(-STDERR_LINES_KEPT);
    }
  }
}
