import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
import { registerMCPHandlers } from '../../src/mcp/ipc-handlers.js';
import { EventEmitter } from 'node:events';

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

describe('MCP IPC Handlers', () => {
  let mockMCPManager: any;
  let mockToolRegistry: any;
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();

    // Capture registered handlers
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    // Create mock MCP manager with EventEmitter
    const emitter = new EventEmitter();
    mockMCPManager = {
      listServers: vi.fn().mockReturnValue([]),
      addServer: vi.fn().mockResolvedValue({ id: 'server-1', name: 'Test Server' }),
      updateServer: vi.fn().mockResolvedValue({ id: 'server-1', name: 'Updated Server' }),
      deleteServer: vi.fn().mockResolvedValue(undefined),
      connectServer: vi.fn().mockResolvedValue({ success: true }),
      disconnectServer: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn().mockResolvedValue({ success: true }),
      listTools: vi.fn().mockReturnValue([]),
      updateToolPreferences: vi.fn().mockResolvedValue(undefined),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
    };

    mockToolRegistry = {
      execute: vi.fn().mockResolvedValue('tool result'),
      getOpenAIFunctionDefinitions: vi.fn().mockReturnValue([]),
    };

    registerMCPHandlers(mockMCPManager, mockToolRegistry);
  });

  describe('server management handlers', () => {
    it('registers mcp:list-servers handler', async () => {
      const handler = handlers.get('mcp:list-servers');
      expect(handler).toBeDefined();

      const servers = await handler!({}, undefined);
      expect(mockMCPManager.listServers).toHaveBeenCalled();
      expect(servers).toEqual([]);
    });

    it('registers mcp:add-server handler', async () => {
      const handler = handlers.get('mcp:add-server');
      expect(handler).toBeDefined();

      const config = {
        name: 'Test Server',
        transportType: 'sse',
        sseUrl: 'https://example.com',
        enabled: true,
        autoStart: false,
      };

      const result = await handler!({}, config);
      expect(mockMCPManager.addServer).toHaveBeenCalledWith(config);
      expect(result).toEqual({ id: 'server-1', name: 'Test Server' });
    });

    it('registers mcp:update-server handler', async () => {
      const handler = handlers.get('mcp:update-server');
      expect(handler).toBeDefined();

      const updates = { name: 'Updated Name' };
      const result = await handler!({}, 'server-1', updates);

      expect(mockMCPManager.updateServer).toHaveBeenCalledWith('server-1', updates);
      expect(result).toEqual({ id: 'server-1', name: 'Updated Server' });
    });

    it('registers mcp:delete-server handler', async () => {
      const handler = handlers.get('mcp:delete-server');
      expect(handler).toBeDefined();

      await handler!({}, 'server-1');
      expect(mockMCPManager.deleteServer).toHaveBeenCalledWith('server-1');
    });

    it('registers mcp:connect-server handler', async () => {
      const handler = handlers.get('mcp:connect-server');
      expect(handler).toBeDefined();

      const result = await handler!({}, 'server-1');
      expect(mockMCPManager.connectServer).toHaveBeenCalledWith('server-1');
      expect(result).toEqual({ success: true });
    });

    it('registers mcp:disconnect-server handler', async () => {
      const handler = handlers.get('mcp:disconnect-server');
      expect(handler).toBeDefined();

      await handler!({}, 'server-1');
      expect(mockMCPManager.disconnectServer).toHaveBeenCalledWith('server-1');
    });

    it('registers mcp:test-connection handler', async () => {
      const handler = handlers.get('mcp:test-connection');
      expect(handler).toBeDefined();

      const result = await handler!({}, 'server-1');
      expect(mockMCPManager.testConnection).toHaveBeenCalledWith('server-1');
      expect(result).toEqual({ success: true });
    });
  });

  describe('tool management handlers', () => {
    it('registers mcp:list-tools handler', async () => {
      const handler = handlers.get('mcp:list-tools');
      expect(handler).toBeDefined();

      await handler!({}, undefined);
      expect(mockMCPManager.listTools).toHaveBeenCalledWith(undefined);

      await handler!({}, 'server-1');
      expect(mockMCPManager.listTools).toHaveBeenCalledWith('server-1');
    });

    it('registers mcp:update-tool-preferences handler', async () => {
      const handler = handlers.get('mcp:update-tool-preferences');
      expect(handler).toBeDefined();

      const prefs = {
        enabled: false,
        confirmationLevel: 'confirm',
        customDescription: 'Custom desc',
      };

      await handler!({}, 'tool-1', prefs);
      expect(mockMCPManager.updateToolPreferences).toHaveBeenCalledWith('tool-1', prefs);
    });

    it('registers mcp:execute-tool handler', async () => {
      const handler = handlers.get('mcp:execute-tool');
      expect(handler).toBeDefined();

      const params = { arg1: 'value1' };
      const result = await handler!({}, 'tool-1', params);

      expect(mockToolRegistry.execute).toHaveBeenCalledWith('tool-1', params);
      expect(result).toBe('tool result');
    });
  });

  describe('LLM integration handler', () => {
    it('registers mcp:get-tool-definitions handler', async () => {
      const handler = handlers.get('mcp:get-tool-definitions');
      expect(handler).toBeDefined();

      mockToolRegistry.getOpenAIFunctionDefinitions.mockReturnValue([
        {
          type: 'function',
          name: 'test-tool',
          description: 'Test tool',
          parameters: { type: 'object', properties: {} },
        },
      ]);

      const result = await handler!({}, undefined);
      expect(mockToolRegistry.getOpenAIFunctionDefinitions).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test-tool');
    });
  });

  describe('event forwarding', () => {
    it('forwards server-status-changed events to all windows', () => {
      const mockWindow1 = {
        webContents: {
          send: vi.fn(),
        },
      };

      const mockWindow2 = {
        webContents: {
          send: vi.fn(),
        },
      };

      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        mockWindow1 as any,
        mockWindow2 as any,
      ]);

      // Re-register handlers to capture event listeners
      const emitter = new EventEmitter();
      mockMCPManager.on = emitter.on.bind(emitter);
      mockMCPManager.emit = emitter.emit.bind(emitter);
      registerMCPHandlers(mockMCPManager, mockToolRegistry);

      // Emit event
      const event = { serverId: 'server-1', status: 'connected' as const };
      emitter.emit('server-status-changed', event);

      expect(mockWindow1.webContents.send).toHaveBeenCalledWith(
        'mcp:server-status-changed',
        event,
      );
      expect(mockWindow2.webContents.send).toHaveBeenCalledWith(
        'mcp:server-status-changed',
        event,
      );
    });

    it('forwards tools-discovered events to all windows', () => {
      const mockWindow = {
        webContents: {
          send: vi.fn(),
        },
      };

      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow as any]);

      // Re-register handlers to capture event listeners
      const emitter = new EventEmitter();
      mockMCPManager.on = emitter.on.bind(emitter);
      mockMCPManager.emit = emitter.emit.bind(emitter);
      registerMCPHandlers(mockMCPManager, mockToolRegistry);

      // Emit event
      emitter.emit('tools-discovered', 'server-1', 5);

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'mcp:tools-discovered',
        'server-1',
        5,
      );
    });

    it('handles case when no windows are open', () => {
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);

      const emitter = new EventEmitter();
      mockMCPManager.on = emitter.on.bind(emitter);
      mockMCPManager.emit = emitter.emit.bind(emitter);
      registerMCPHandlers(mockMCPManager, mockToolRegistry);

      // Should not throw when emitting with no windows
      expect(() => {
        emitter.emit('server-status-changed', { serverId: 'server-1', status: 'connected' });
      }).not.toThrow();
    });
  });
});
