import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import type { RegisteredTool } from '../src/tools/tool-registry.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register', () => {
    it('registers a tool successfully', () => {
      const tool: RegisteredTool = {
        id: 'test-server:test-tool',
        serverId: 'test-server',
        toolName: 'test-tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      registry.register(tool);

      const registered = registry.get('test-server:test-tool');
      expect(registered).toBeDefined();
      expect(registered?.toolName).toBe('test-tool');
      expect(registered?.description).toBe('A test tool');
    });

    it('replaces existing tool with same id', () => {
      const tool1: RegisteredTool = {
        id: 'test-server:tool',
        serverId: 'test-server',
        toolName: 'tool',
        description: 'First version',
        inputSchema: { type: 'object', properties: {} },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => 'v1',
      };

      const tool2: RegisteredTool = {
        ...tool1,
        description: 'Second version',
        execute: async () => 'v2',
      };

      registry.register(tool1);
      registry.register(tool2);

      const registered = registry.get('test-server:tool');
      expect(registered?.description).toBe('Second version');
    });

    it('emits tools-changed event when tool is registered', (context) => {
      const tool: RegisteredTool = {
        id: 'test-server:tool',
        serverId: 'test-server',
        toolName: 'tool',
        description: 'Test',
        inputSchema: { type: 'object', properties: {} },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      return new Promise<void>((resolve) => {
        registry.on('tools-changed', () => {
          resolve();
        });
        registry.register(tool);
      });
    });
  });

  describe('unregister', () => {
    it('removes a registered tool', () => {
      const tool: RegisteredTool = {
        id: 'test-server:tool',
        serverId: 'test-server',
        toolName: 'tool',
        description: 'Test',
        inputSchema: { type: 'object', properties: {} },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      registry.register(tool);
      expect(registry.get('test-server:tool')).toBeDefined();

      registry.unregister('test-server:tool');
      expect(registry.get('test-server:tool')).toBeUndefined();
    });

    it('emits tools-changed event when tool is unregistered', () => {
      const tool: RegisteredTool = {
        id: 'test-server:tool',
        serverId: 'test-server',
        toolName: 'tool',
        description: 'Test',
        inputSchema: { type: 'object', properties: {} },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      registry.register(tool);

      return new Promise<void>((resolve) => {
        registry.on('tools-changed', () => {
          resolve();
        });
        registry.unregister('test-server:tool');
      });
    });

    it('does nothing when unregistering non-existent tool', () => {
      expect(() => registry.unregister('non-existent')).not.toThrow();
    });
  });

  describe('execute', () => {
    it('executes a registered tool', async () => {
      const tool: RegisteredTool = {
        id: 'test-server:echo',
        serverId: 'test-server',
        toolName: 'echo',
        description: 'Echoes input',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
        enabled: true,
        confirmationLevel: 'none',
        execute: async (params: unknown) => {
          const typed = params as { message: string };
          return `Echo: ${typed.message}`;
        },
      };

      registry.register(tool);

      const result = await registry.execute('test-server:echo', { message: 'Hello' });
      expect(result.success).toBe(true);
      expect(result.data).toBe('Echo: Hello');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws error when executing disabled tool', async () => {
      const tool: RegisteredTool = {
        id: 'test-server:disabled',
        serverId: 'test-server',
        toolName: 'disabled',
        description: 'Disabled tool',
        inputSchema: { type: 'object', properties: {} },
        enabled: false,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      registry.register(tool);

      await expect(registry.execute('test-server:disabled', {})).rejects.toThrow(
        'Tool disabled: test-server:disabled',
      );
    });

    it('throws error when executing non-existent tool', async () => {
      await expect(registry.execute('non-existent', {})).rejects.toThrow(
        'Tool not found: non-existent',
      );
    });

    it('returns error result when tool execution fails', async () => {
      const tool: RegisteredTool = {
        id: 'test-server:error',
        serverId: 'test-server',
        toolName: 'error',
        description: 'Error tool',
        inputSchema: { type: 'object', properties: {} },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => {
          throw new Error('Tool execution failed');
        },
      };

      registry.register(tool);

      const result = await registry.execute('test-server:error', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Tool execution failed');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getOpenAIFunctionDefinitions', () => {
    it('converts tools to OpenAI function format', () => {
      const tool1: RegisteredTool = {
        id: 'server1:tool1',
        serverId: 'server1',
        toolName: 'tool1',
        description: 'First tool',
        inputSchema: {
          type: 'object',
          properties: {
            param1: { type: 'string', description: 'First parameter' },
          },
          required: ['param1'],
        },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      const tool2: RegisteredTool = {
        id: 'server2:tool2',
        serverId: 'server2',
        toolName: 'tool2',
        description: 'Second tool',
        inputSchema: {
          type: 'object',
          properties: {
            param2: { type: 'number' },
          },
        },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      registry.register(tool1);
      registry.register(tool2);

      const definitions = registry.getOpenAIFunctionDefinitions();

      expect(definitions).toHaveLength(2);
      expect(definitions[0]).toEqual({
        type: 'function',
        name: 'tool1',
        description: 'First tool',
        parameters: {
          type: 'object',
          properties: {
            param1: { type: 'string', description: 'First parameter' },
          },
          required: ['param1'],
        },
      });
      expect(definitions[1]).toEqual({
        type: 'function',
        name: 'tool2',
        description: 'Second tool',
        parameters: {
          type: 'object',
          properties: {
            param2: { type: 'number' },
          },
        },
      });
    });

    it('excludes disabled tools from OpenAI definitions', () => {
      const enabledTool: RegisteredTool = {
        id: 'server:enabled',
        serverId: 'server',
        toolName: 'enabled',
        description: 'Enabled tool',
        inputSchema: { type: 'object', properties: {} },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      const disabledTool: RegisteredTool = {
        id: 'server:disabled',
        serverId: 'server',
        toolName: 'disabled',
        description: 'Disabled tool',
        inputSchema: { type: 'object', properties: {} },
        enabled: false,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      registry.register(enabledTool);
      registry.register(disabledTool);

      const definitions = registry.getOpenAIFunctionDefinitions();

      expect(definitions).toHaveLength(1);
      expect(definitions[0].name).toBe('enabled');
    });

    it('returns empty array when no tools registered', () => {
      const definitions = registry.getOpenAIFunctionDefinitions();
      expect(definitions).toEqual([]);
    });
  });

  describe('list', () => {
    it('returns only enabled tools', () => {
      const tool1: RegisteredTool = {
        id: 'server1:tool1',
        serverId: 'server1',
        toolName: 'tool1',
        description: 'First tool',
        inputSchema: { type: 'object', properties: {} },
        enabled: true,
        confirmationLevel: 'none',
        execute: async () => 'result',
      };

      const tool2: RegisteredTool = {
        id: 'server2:tool2',
        serverId: 'server2',
        toolName: 'tool2',
        description: 'Second tool',
        inputSchema: { type: 'object', properties: {} },
        enabled: false,
        confirmationLevel: 'notify',
        execute: async () => 'result',
      };

      registry.register(tool1);
      registry.register(tool2);

      const enabled = registry.list();

      expect(enabled).toHaveLength(1);
      expect(enabled.find((t) => t.id === 'server1:tool1')).toBeDefined();
      expect(enabled.find((t) => t.id === 'server2:tool2')).toBeUndefined();
    });

    it('returns empty array when no tools registered', () => {
      const enabled = registry.list();
      expect(enabled).toEqual([]);
    });
  });
});
