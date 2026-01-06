import { EventEmitter } from 'node:events';
import type { JSONSchema } from '../mcp/types.js';

/**
 * A tool registered in the registry with execution capabilities.
 */
export interface RegisteredTool {
  id: string; // Unique identifier (e.g., "server_id:tool_name")
  serverId: string; // MCP server ID this tool belongs to
  toolName: string; // Tool name as defined by the MCP server
  description: string; // Description for the LLM
  inputSchema: JSONSchema; // JSON Schema for tool parameters
  enabled: boolean; // Whether the tool is enabled
  confirmationLevel: 'none' | 'notify' | 'confirm' | 'block'; // Security level
  execute: (params: unknown) => Promise<unknown>; // Execution function
}

/**
 * OpenAI function definition format for Realtime API.
 */
export interface OpenAIFunction {
  type: 'function';
  name: string;
  description: string;
  parameters: JSONSchema;
}

/**
 * Result of tool execution.
 */
export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Manages registered MCP tools and provides execution capabilities.
 * Emits 'tools-changed' event when tools are registered or unregistered.
 */
export class ToolRegistry extends EventEmitter {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * Register a tool in the registry.
   * Emits 'tools-changed' event.
   */
  register(tool: RegisteredTool): void {
    this.tools.set(tool.id, tool);
    this.emit('tools-changed');
  }

  /**
   * Unregister a tool from the registry.
   * Emits 'tools-changed' event.
   */
  unregister(toolId: string): void {
    this.tools.delete(toolId);
    this.emit('tools-changed');
  }

  /**
   * List all enabled tools.
   * @returns Array of enabled tools
   */
  list(): RegisteredTool[] {
    return Array.from(this.tools.values()).filter((t) => t.enabled);
  }

  /**
   * Get a specific tool by ID.
   * @param toolId - The tool ID to retrieve
   * @returns The tool if found, undefined otherwise
   */
  get(toolId: string): RegisteredTool | undefined {
    return this.tools.get(toolId);
  }

  /**
   * Execute a tool by ID.
   * @param toolId - The tool ID to execute
   * @param params - Parameters to pass to the tool
   * @returns Execution result with success status, data, and duration
   * @throws Error if tool not found or disabled
   */
  async execute(toolId: string, params: unknown): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }
    if (!tool.enabled) {
      throw new Error(`Tool disabled: ${toolId}`);
    }

    const startTime = Date.now();
    try {
      const result = await tool.execute(params);
      return { success: true, data: result, durationMs: Date.now() - startTime };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get tool definitions in OpenAI function calling format.
   * Only includes enabled tools.
   * @returns Array of OpenAI function definitions
   */
  getOpenAIFunctionDefinitions(): OpenAIFunction[] {
    return this.list().map((tool) => ({
      type: 'function',
      name: tool.toolName,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  /**
   * Clear all tools from the registry.
   * Emits 'tools-changed' event.
   */
  clear(): void {
    this.tools.clear();
    this.emit('tools-changed');
  }
}
