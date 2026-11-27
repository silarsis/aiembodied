import { BrowserWindow } from 'electron';
import type { HandleIpc } from '../ipc/handle-ipc.js';
import type { MCPManager } from './mcp-manager.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { MCPServerConfigInput } from '../shared/mcp/types.js';
import { toServerSummary } from './server-summary.js';

/**
 * Register all MCP-related IPC handlers.
 * Handles server management, tool operations, and LLM integration.
 */
export function registerMCPHandlers(options: {
  handle: HandleIpc;
  mcpManager: MCPManager;
  toolRegistry: ToolRegistry;
}): void {
  const { handle, mcpManager, toolRegistry } = options;
  // Server management handlers
  // Everything that goes to the renderer passes through toServerSummary: no tokens or env values leave the main process.
  handle('mcp:list-servers', async () => {
    return (await mcpManager.listServers()).map(toServerSummary);
  });

  handle('mcp:add-server', async (_, config: MCPServerConfigInput) => {
    return toServerSummary(await mcpManager.addServer(config));
  });

  handle('mcp:update-server', async (_, id: string, updates: Partial<MCPServerConfigInput>) => {
    return toServerSummary(await mcpManager.updateServer(id, updates));
  });

  // Ready-made servers. The renderer calls sign-in itself after adding one that needs it.
  handle('mcp:list-presets', async () => {
    return mcpManager.listPresets();
  });

  handle('mcp:add-preset', async (_, presetId: string) => {
    return toServerSummary(await mcpManager.addPreset(presetId));
  });

  // Browser sign-in for OAuth servers (not available on satellites).
  handle('mcp:sign-in', async (_, id: string) => {
    return await mcpManager.signIn(id);
  });

  handle('mcp:sign-out', async (_, id: string) => {
    await mcpManager.signOut(id);
  });

  handle('mcp:delete-server', async (_, id: string) => {
    await mcpManager.deleteServer(id);
  });

  handle('mcp:connect-server', async (_, id: string) => {
    return await mcpManager.connectServer(id);
  });

  handle('mcp:disconnect-server', async (_, id: string) => {
    await mcpManager.disconnectServer(id);
  });

  handle('mcp:test-connection', async (_, id: string) => {
    return await mcpManager.testConnection(id);
  });

  // Tool management handlers
  handle('mcp:list-tools', async (_, serverId?: string) => {
    return mcpManager.listTools(serverId);
  });

  handle(
    'mcp:update-tool-preferences',
    async (
      _,
      toolId: string,
      prefs: {
        enabled?: boolean;
        confirmationLevel?: string;
        customDescription?: string;
        readOnly?: boolean | null;
      },
    ) => {
      await mcpManager.updateToolPreferences(toolId, prefs);
    },
  );

  handle('mcp:execute-tool', async (_, toolId: string, params: unknown) => {
    return await toolRegistry.execute(toolId, params);
  });

  // LLM integration handler
  handle('mcp:get-tool-definitions', async () => {
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
