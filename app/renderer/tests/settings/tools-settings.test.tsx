import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '../../../main/src/mcp/types.js';
import type { McpBridge, ModelsBridge } from '../../src/preload-api.js';
import { ToolsSettings } from '../../src/settings/tools-settings.js';

const server: MCPServerConfig = {
  id: 'ha',
  name: 'Home Assistant',
  transportType: 'sse',
  sseUrl: 'http://ha.local/mcp/sse',
  enabled: true,
  autoStart: true,
  connectionStatus: 'connected',
  toolsDiscovered: 1,
  createdAt: 0,
  updatedAt: 0,
};

function bridges() {
  const mcp = {
    listServers: vi.fn().mockResolvedValue([server]),
    addServer: vi.fn().mockResolvedValue({ ...server, id: 'new', name: 'New' }),
    updateServer: vi.fn().mockResolvedValue(server),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    connectServer: vi.fn().mockResolvedValue({ success: true, toolsDiscovered: 2 }),
    disconnectServer: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      {
        id: 'ha:turn_on',
        serverId: 'ha',
        serverName: 'Home Assistant',
        toolName: 'turn_on',
        displayName: 'turn_on',
        description: 'Turn a light on',
        enabled: true,
        confirmationLevel: 'confirm',
      },
    ]),
    updateToolPreferences: vi.fn().mockResolvedValue(undefined),
    getToolDefinitionsForLLM: vi.fn().mockResolvedValue([
      { name: 'web_search', description: 'Search the web' },
      { name: 'turn_on', description: 'Turn a light on' },
    ]),
  } satisfies McpBridge;
  const models = {
    get: vi.fn().mockResolvedValue({
      servers: [{ id: 'searxng', name: 'SearXNG', type: 'search', url: '', builtIn: true, managed: true, hasKey: false }],
      routes: { search: { server: 'searxng' } },
    }),
  } as unknown as ModelsBridge;
  return { mcp, models };
}

describe('Tools / MCP settings', () => {
  it('lists built-in tools, web search and MCP servers', async () => {
    const { mcp, models } = bridges();
    const openWebSearch = vi.fn();
    render(<ToolsSettings mcp={mcp} models={models} active onOpenWebSearch={openWebSearch} />);
    expect(await screen.findByText('web_search')).toBeInTheDocument();
    expect(await screen.findByText('The assistant looks things up with SearXNG.')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Home Assistant' })).toHaveTextContent('Connected · 1 tools');
    fireEvent.change(screen.getByLabelText('When turn_on runs'), { target: { value: 'none' } });
    await waitFor(() => expect(mcp.updateToolPreferences).toHaveBeenCalledWith('ha:turn_on', { confirmationLevel: 'none' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose web search servers' }));
    expect(openWebSearch).toHaveBeenCalled();
  });

  it('adds an SSE server and connects to it', async () => {
    const { mcp, models } = bridges();
    render(<ToolsSettings mcp={mcp} models={models} active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an MCP server' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText('SSE URL'), { target: { value: 'http://new.local/sse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and connect' }));
    await waitFor(() => expect(mcp.connectServer).toHaveBeenCalledWith('new'));
    expect(mcp.addServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New', transportType: 'sse', sseUrl: 'http://new.local/sse', sseAuthToken: undefined }),
    );
  });
});
