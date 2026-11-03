import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { MCPServerConfig, MCPToolSummary } from '../../../main/src/mcp/types.js';
import type { McpBridge, ModelsBridge } from '../preload-api.js';

const CONFIRMATION_LEVELS = [
  { value: 'none', label: 'Run straight away' },
  { value: 'notify', label: 'Run and say so' },
  { value: 'confirm', label: 'Ask first' },
  { value: 'block', label: 'Never run' },
] as const;

interface ServerDraft {
  name: string;
  url: string;
  header: string;
  token: string;
}

const EMPTY_DRAFT: ServerDraft = { name: '', url: '', header: 'Authorization', token: '' };

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The Tools / MCP pop-up: the tools the assistant can call, web search, and MCP servers.
 * `active` is true while the pop-up is open, so lists reload each time it opens.
 */
export function ToolsSettings({
  mcp,
  models,
  active,
  onOpenWebSearch,
}: {
  mcp?: McpBridge;
  models?: ModelsBridge;
  active: boolean;
  onOpenWebSearch?(): void;
}) {
  const [definitions, setDefinitions] = useState<{ name: string; description: string }[] | null>(null);
  const [searchServers, setSearchServers] = useState<string | null>(null);
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [tools, setTools] = useState<MCPToolSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<ServerDraft | null>(null);

  const reload = useCallback(async () => {
    const [nextDefinitions, nextServers, nextTools, routing] = await Promise.all([
      mcp?.getToolDefinitionsForLLM?.().catch(() => null) ?? null,
      mcp?.listServers().catch(() => []) ?? [],
      mcp?.listTools().catch(() => []) ?? [],
      models?.get().catch(() => null) ?? null,
    ]);
    setDefinitions(nextDefinitions);
    setServers(nextServers);
    setTools(nextTools);
    if (routing) {
      const route = routing.routes.search;
      const ids = route?.server ? [route.server, ...(route.backups ?? []).map((backup) => backup.server)] : [];
      const names = ids
        .map((id) => routing.servers.find((server) => server.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      setSearchServers(names.length > 0 ? names.join(', then ') : '');
    }
  }, [mcp, models]);

  useEffect(() => {
    if (active) void Promise.resolve().then(reload);
  }, [active, reload]);

  useEffect(() => {
    if (!mcp) return;
    const offStatus = mcp.onServerStatusChanged?.(() => void reload());
    const offTools = mcp.onToolsDiscovered?.(() => void reload());
    return () => {
      offStatus?.();
      offTools?.();
    };
  }, [mcp, reload]);

  const run = async (key: string, action: () => Promise<unknown>, fallback: string) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(null);
      await reload();
    }
  };

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (!mcp || !adding) return;
    const draft = adding;
    await run(
      'add',
      async () => {
        const server = await mcp.addServer({
          name: draft.name.trim() || draft.url.trim(),
          transportType: 'sse',
          sseUrl: draft.url.trim(),
          sseAuthHeader: draft.token ? draft.header.trim() || 'Authorization' : undefined,
          sseAuthToken: draft.token || undefined,
          enabled: true,
          autoStart: true,
        });
        setAdding(null);
        const result = await mcp.connectServer(server.id);
        if (!result.success) throw new Error(result.error ?? `Couldn’t connect to ${server.name}.`);
      },
      'Couldn’t add that server.',
    );
  };

  const builtIn = (definitions ?? []).filter(
    (definition) => !tools.some((tool) => tool.toolName === definition.name),
  );

  return (
    <div className="toolsSettings">
      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}

      <section aria-labelledby="tools-web-search-title" className="toolsSettings__section">
        <h3 id="tools-web-search-title">Web search</h3>
        <p className="kiosk__helper">
          {searchServers === null
            ? 'The assistant can look things up with the web_search tool.'
            : searchServers
              ? `The assistant looks things up with ${searchServers}.`
              : 'Web search is off: the assistant can’t look things up.'}
        </p>
        {onOpenWebSearch ? (
          <button type="button" onClick={onOpenWebSearch}>
            Choose web search servers
          </button>
        ) : null}
      </section>

      <section aria-labelledby="tools-builtin-title" className="toolsSettings__section">
        <h3 id="tools-builtin-title">Tools the assistant can call</h3>
        {definitions === null ? (
          <p className="kiosk__helper">The tool list needs a newer app build.</p>
        ) : definitions.length === 0 ? (
          <p className="kiosk__helper">No tools are on right now.</p>
        ) : (
          <ul className="toolsSettings__list">
            {builtIn.map((definition) => (
              <li key={definition.name}>
                <code>{definition.name}</code>
                <span className="kiosk__helper">{definition.description}</span>
              </li>
            ))}
            {tools
              .filter((tool) => tool.enabled && definitions.some((d) => d.name === tool.toolName))
              .map((tool) => (
                <li key={tool.id}>
                  <code>{tool.toolName}</code>
                  <span className="kiosk__helper">From {tool.serverName}</span>
                </li>
              ))}
          </ul>
        )}
        <p className="kiosk__helper">
          Moving, poses and animations are always available to the assistant and aren’t listed here.
          The voice only offers tools that run without asking.
        </p>
      </section>

      <section aria-labelledby="tools-mcp-title" className="toolsSettings__section">
        <h3 id="tools-mcp-title">MCP servers</h3>
        {!mcp ? (
          <p className="kiosk__helper">MCP settings need a newer app build.</p>
        ) : (
          <>
            {servers.length === 0 ? <p className="kiosk__helper">No MCP servers yet.</p> : null}
            {servers.map((server) => {
              const serverTools = tools.filter((tool) => tool.serverId === server.id);
              const connected = server.connectionStatus === 'connected';
              return (
                <article key={server.id} className="toolsSettings__server" aria-label={server.name}>
                  <div className="toolsSettings__serverHeader">
                    <strong>{server.name}</strong>
                    <code>{server.transportType === 'sse' ? server.sseUrl : server.stdioCommand}</code>
                    <span className="toolsSettings__status" data-status={server.connectionStatus}>
                      {connected
                        ? `Connected · ${server.toolsDiscovered} tools`
                        : server.connectionStatus === 'error'
                          ? 'Error'
                          : 'Not connected'}
                    </span>
                  </div>
                  {server.lastError ? <p className="kiosk__helper">{server.lastError}</p> : null}
                  <div className="toolsSettings__actions">
                    {connected ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void run(server.id, () => mcp.disconnectServer(server.id), 'Couldn’t disconnect.')}
                      >
                        Disconnect
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy !== null || server.transportType === 'stdio'}
                        onClick={() =>
                          void run(
                            server.id,
                            async () => {
                              const result = await mcp.connectServer(server.id);
                              if (!result.success) throw new Error(result.error ?? `Couldn’t connect to ${server.name}.`);
                            },
                            'Couldn’t connect.',
                          )
                        }
                      >
                        {busy === server.id ? 'Connecting…' : 'Connect'}
                      </button>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={server.autoStart}
                        disabled={busy !== null}
                        onChange={(event) =>
                          void run(
                            server.id,
                            () => mcp.updateServer(server.id, { autoStart: event.target.checked }),
                            'Couldn’t save that.',
                          )
                        }
                      />
                      Connect at startup
                    </label>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void run(server.id, () => mcp.deleteServer(server.id), 'Couldn’t remove that server.')}
                    >
                      Remove
                    </button>
                  </div>
                  {server.transportType === 'stdio' ? (
                    <p className="kiosk__helper">Command-line (stdio) MCP servers aren’t supported yet.</p>
                  ) : null}
                  {serverTools.length > 0 ? (
                    <ul className="toolsSettings__list">
                      {serverTools.map((tool) => (
                        <li key={tool.id} className="toolsSettings__tool">
                          <label>
                            <input
                              type="checkbox"
                              checked={tool.enabled}
                              disabled={busy !== null}
                              onChange={(event) =>
                                void run(
                                  tool.id,
                                  () => mcp.updateToolPreferences(tool.id, { enabled: event.target.checked }),
                                  'Couldn’t save that.',
                                )
                              }
                            />
                            <code>{tool.displayName || tool.toolName}</code>
                          </label>
                          <select
                            aria-label={`When ${tool.displayName || tool.toolName} runs`}
                            value={tool.confirmationLevel}
                            disabled={busy !== null || !tool.enabled}
                            onChange={(event) =>
                              void run(
                                tool.id,
                                () => mcp.updateToolPreferences(tool.id, { confirmationLevel: event.target.value }),
                                'Couldn’t save that.',
                              )
                            }
                          >
                            {CONFIRMATION_LEVELS.map((level) => (
                              <option key={level.value} value={level.value}>
                                {level.label}
                              </option>
                            ))}
                          </select>
                          {tool.description ? <span className="kiosk__helper">{tool.description}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              );
            })}

            {adding ? (
              <form className="toolsSettings__add" onSubmit={(event) => void handleAdd(event)} aria-label="Add MCP server">
                <label>
                  Name
                  <input
                    value={adding.name}
                    onChange={(event) => setAdding({ ...adding, name: event.target.value })}
                    placeholder="Home Assistant"
                  />
                </label>
                <label>
                  SSE URL
                  <input
                    type="url"
                    required
                    value={adding.url}
                    onChange={(event) => setAdding({ ...adding, url: event.target.value })}
                    placeholder="http://192.168.1.20:8123/mcp_server/sse"
                  />
                </label>
                <label>
                  Auth header
                  <input value={adding.header} onChange={(event) => setAdding({ ...adding, header: event.target.value })} />
                </label>
                <label>
                  Auth value (optional)
                  <input
                    type="password"
                    value={adding.token}
                    onChange={(event) => setAdding({ ...adding, token: event.target.value })}
                    placeholder="Bearer …"
                  />
                </label>
                <div className="toolsSettings__actions">
                  <button type="submit" className="faces__submit" disabled={busy !== null || !adding.url.trim()}>
                    {busy === 'add' ? 'Adding…' : 'Add and connect'}
                  </button>
                  <button type="button" onClick={() => setAdding(null)}>
                    Cancel
                  </button>
                </div>
                <p className="kiosk__helper">Only SSE servers work for now; command-line (stdio) servers are still to come.</p>
              </form>
            ) : (
              <button type="button" className="faces__submit" onClick={() => setAdding({ ...EMPTY_DRAFT })}>
                Add an MCP server
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
