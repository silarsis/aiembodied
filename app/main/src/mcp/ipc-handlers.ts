import { ipcMain, BrowserWindow } from 'electron';
import type { MCPManager } from './mcp-manager.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { MCPServerConfigInput } from './types.js';

/**
 * Register all MCP-related IPC handlers.
 * Handles server management, tool operations, and LLM integration.
 */
export function registerMCPHandlers(mcpManager: MCPManager, toolRegistry: ToolRegistry): void {
  // Server management handlers
  ipcMain.handle('mcp:list-servers', async () => {
    return mcpManager.listServers();
  });

  ipcMain.handle('mcp:add-server', async (_, config: MCPServerConfigInput) => {
    return await mcpManager.addServer(config);
  });

  ipcMain.handle('mcp:update-server', async (_, id: string, updates: Partial<MCPServerConfigInput>) => {
    return await mcpManager.updateServer(id, updates);
  });

  ipcMain.handle('mcp:delete-server', async (_, id: string) => {
    await mcpManager.deleteServer(id);
  });

  ipcMain.handle('mcp:connect-server', async (_, id: string) => {
    return await mcpManager.connectServer(id);
  });

  ipcMain.handle('mcp:disconnect-server', async (_, id: string) => {
    await mcpManager.disconnectServer(id);
  });

  ipcMain.handle('mcp:test-connection', async (_, id: string) => {
    return await mcpManager.testConnection(id);
  });

  // Tool management handlers
  ipcMain.handle('mcp:list-tools', async (_, serverId?: string) => {
    return mcpManager.listTools(serverId);
  });

  ipcMain.handle(
    'mcp:update-tool-preferences',
    async (
      _,
      toolId: string,
      prefs: { enabled?: boolean; confirmationLevel?: string; customDescription?: string },
    ) => {
      await mcpManager.updateToolPreferences(toolId, prefs);
    },
  );

  ipcMain.handle('mcp:execute-tool', async (_, toolId: string, params: unknown) => {
    return await toolRegistry.execute(toolId, params);
  });

  // LLM integration handler
  ipcMain.handle('mcp:get-tool-definitions', async () => {
    return toolRegistry.getOpenAIFunctionDefinitions();
  });

  // Forward MCP Manager events to all renderer windows
  mcpManager.on('server-status-changed', (event) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('mcp:server-status-changed', event);
    });
  });

  mcpManager.on('tools-discovered', (serverId: string, count: number) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('mcp:tools-discovered', serverId, count);
    });
  });
}
