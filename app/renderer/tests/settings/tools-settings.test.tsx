import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MCPServerSummary } from '../../../main/src/mcp/types.js';
import type { McpBridge, ModelsBridge } from '../../src/preload-api.js';
import { ToolsSettings } from '../../src/settings/tools-settings.js';

const server: MCPServerSummary = {
  id: 'ha',
  name: 'Home Assistant',
  transportType: 'sse',
  sseUrl: 'http://ha.local/mcp/sse',
  enabled: true,
  autoStart: true,
  connectionStatus: 'connected',
  toolsDiscovered: 1,
  hasAuthToken: false,
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
        llmName: 'turn_on',
        displayName: 'turn_on',
        description: 'Turn a light on',
        enabled: true,
        confirmationLevel: 'confirm',
      },
    ]),
    updateToolPreferences: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue({ success: true, toolsDiscovered: 3 }),
    signOut: vi.fn().mockResolvedValue(undefined),
    listPresets: vi.fn().mockResolvedValue([
      { id: 'dair-academy-papers', name: 'DAIR Academy papers', description: 'A reading library.', url: 'https://academy.dair.ai/api/mcp' },
    ]),
    addPreset: vi.fn().mockResolvedValue({ ...server, id: 'dair', name: 'DAIR Academy papers', transportType: 'http', httpUrl: 'https://academy.dair.ai/api/mcp', oauth: true }),
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
    fireEvent.change(screen.getByLabelText('Connects by'), { target: { value: 'sse' } });
    fireEvent.change(screen.getByLabelText('SSE URL'), { target: { value: 'http://new.local/sse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and connect' }));
    await waitFor(() => expect(mcp.connectServer).toHaveBeenCalledWith('new'));
    expect(mcp.addServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New', transportType: 'sse', sseUrl: 'http://new.local/sse', sseAuthToken: undefined }),
    );
  });

  it('adds a web address with browser sign-in and signs in', async () => {
    const { mcp, models } = bridges();
    mcp.addServer.mockResolvedValue({ ...server, id: 'web', transportType: 'http', oauth: true });
    render(<ToolsSettings mcp={mcp} models={models} active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an MCP server' }));
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'https://example.com/mcp' } });
    fireEvent.change(screen.getByLabelText('Sign-in'), { target: { value: 'oauth' } });
    fireEvent.change(screen.getByLabelText('Permission to ask for (optional)'), { target: { value: 'papers:read' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and sign in' }));
    await waitFor(() => expect(mcp.signIn).toHaveBeenCalledWith('web'));
    expect(mcp.addServer).toHaveBeenCalledWith(
      expect.objectContaining({ transportType: 'http', httpUrl: 'https://example.com/mcp', oauth: true, oauthScope: 'papers:read' }),
    );
    expect(mcp.connectServer).not.toHaveBeenCalled();
  });

  it('adds a header-token web address without OAuth', async () => {
    const { mcp, models } = bridges();
    render(<ToolsSettings mcp={mcp} models={models} active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an MCP server' }));
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'https://example.com/mcp' } });
    fireEvent.change(screen.getByLabelText('Sign-in'), { target: { value: 'header' } });
    fireEvent.change(screen.getByLabelText('Auth value'), { target: { value: 'Bearer abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and connect' }));
    await waitFor(() => expect(mcp.connectServer).toHaveBeenCalled());
    expect(mcp.addServer).toHaveBeenCalledWith(
      expect.objectContaining({ transportType: 'http', httpAuthHeader: 'Authorization', httpAuthToken: 'Bearer abc', oauth: false }),
    );
  });

  it('adds a program on this PC with arguments and environment lines', async () => {
    const { mcp, models } = bridges();
    render(<ToolsSettings mcp={mcp} models={models} active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an MCP server' }));
    fireEvent.change(screen.getByLabelText('Connects by'), { target: { value: 'stdio' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByLabelText('Arguments (one per line)'), { target: { value: '-y\n  some-server \n\n' } });
    fireEvent.change(screen.getByLabelText('Environment (KEY=value, one per line)'), { target: { value: 'TOKEN=a=b\nOTHER=1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and connect' }));
    await waitFor(() => expect(mcp.connectServer).toHaveBeenCalledWith('new'));
    expect(mcp.addServer).toHaveBeenCalledWith(
      expect.objectContaining({
        transportType: 'stdio',
        stdioCommand: 'npx',
        stdioArgs: ['-y', 'some-server'],
        stdioEnv: { TOKEN: 'a=b', OTHER: '1' },
      }),
    );
  });

  it('adds an older SSE address', async () => {
    const { mcp, models } = bridges();
    render(<ToolsSettings mcp={mcp} models={models} active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an MCP server' }));
    fireEvent.change(screen.getByLabelText('Connects by'), { target: { value: 'sse' } });
    fireEvent.change(screen.getByLabelText('SSE URL'), { target: { value: 'http://old.local/sse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and connect' }));
    await waitFor(() => expect(mcp.addServer).toHaveBeenCalledWith(expect.objectContaining({ transportType: 'sse', sseUrl: 'http://old.local/sse' })));
  });

  it('shows Sign-in needed with a Sign in button, and Sign out for OAuth servers', async () => {
    const { mcp, models } = bridges();
    const needy: MCPServerSummary = {
      ...server,
      id: 'dair',
      name: 'DAIR Academy papers',
      transportType: 'http',
      httpUrl: 'https://academy.dair.ai/api/mcp',
      oauth: true,
      connectionStatus: 'needs-sign-in',
      lastError: 'Sign-in needed.',
    };
    mcp.listServers.mockResolvedValue([needy]);
    render(<ToolsSettings mcp={mcp} models={models} active />);
    const card = await screen.findByRole('article', { name: 'DAIR Academy papers' });
    expect(card).toHaveTextContent('Sign-in needed');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mcp.signIn).toHaveBeenCalledWith('dair'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mcp.signOut).toHaveBeenCalledWith('dair'));
  });

  it('adds a ready-made server and signs in to it', async () => {
    const { mcp, models } = bridges();
    render(<ToolsSettings mcp={mcp} models={models} active />);
    expect(await screen.findByText('A reading library.')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Ready-made servers' });
    fireEvent.click(within(group).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mcp.addPreset).toHaveBeenCalledWith('dair-academy-papers'));
    await waitFor(() => expect(mcp.signIn).toHaveBeenCalledWith('dair'));
  });
});
