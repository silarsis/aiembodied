import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { MCPServerConfigInput, MCPServerSummary, MCPToolSummary } from '../../../main/src/shared/mcp/types.js';
import type { MCPPresetSummary } from '../../../main/src/shared/mcp/presets-types.js';
import type { StationView } from '../../../main/src/shared/stations/types.js';
import type { McpBridge, ModelsBridge, StationsBridge } from '../preload-api.js';

const CONFIRMATION_LEVELS = [
  { value: 'none', label: 'Run straight away' },
  { value: 'notify', label: 'Run and say so' },
  { value: 'confirm', label: 'Ask first' },
  { value: 'block', label: 'Never run' },
] as const;

/** How the new server is reached: a web address (Streamable HTTP), a program on this PC (stdio), or the older SSE address. */
type ConnectsBy = 'http' | 'stdio' | 'sse';
/** How we prove who we are to a web address. */
type SignInKind = 'none' | 'header' | 'oauth';

interface ServerDraft {
  name: string;
  connectsBy: ConnectsBy;
  url: string;
  signIn: SignInKind;
  header: string;
  token: string;
  scope: string;
  command: string;
  argsText: string; // one argument per line
  envText: string; // KEY=value per line
}

const EMPTY_DRAFT: ServerDraft = {
  name: '',
  connectsBy: 'http',
  url: '',
  signIn: 'none',
  header: 'Authorization',
  token: '',
  scope: '',
  command: '',
  argsText: '',
  envText: '',
};

/** One argument per non-empty line. */
function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** KEY=value per line; blank lines are skipped, anything else without an `=` is an error. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf('=');
    if (at < 1) throw new Error(`Environment line “${line}” should look like KEY=value.`);
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return env;
}

/** Turn the form into what the main process stores. */
function draftToConfig(draft: ServerDraft): MCPServerConfigInput {
  const base = { enabled: true, autoStart: true };
  if (draft.connectsBy === 'stdio') {
    const env = parseEnv(draft.envText);
    return {
      ...base,
      name: draft.name.trim() || draft.command.trim(),
      transportType: 'stdio',
      stdioCommand: draft.command.trim(),
      stdioArgs: parseArgs(draft.argsText),
      stdioEnv: Object.keys(env).length > 0 ? env : undefined,
    };
  }
  const url = draft.url.trim();
  const header = draft.signIn === 'header' && draft.token ? draft.header.trim() || 'Authorization' : undefined;
  const token = draft.signIn === 'header' && draft.token ? draft.token : undefined;
  if (draft.connectsBy === 'sse') {
    return { ...base, name: draft.name.trim() || url, transportType: 'sse', sseUrl: url, sseAuthHeader: header, sseAuthToken: token };
  }
  return {
    ...base,
    name: draft.name.trim() || url,
    transportType: 'http',
    httpUrl: url,
    httpAuthHeader: header,
    httpAuthToken: token,
    oauth: draft.signIn === 'oauth',
    oauthScope: draft.signIn === 'oauth' && draft.scope.trim() ? draft.scope.trim() : undefined,
  };
}

function statusText(server: MCPServerSummary): string {
  switch (server.connectionStatus) {
    case 'connected':
      return `Connected · ${server.toolsDiscovered} tools`;
    case 'needs-sign-in':
      return 'Sign-in needed';
    case 'error':
      return 'Error';
    default:
      return 'Not connected';
  }
}

function serverAddress(server: MCPServerSummary): string | undefined {
  if (server.transportType === 'http') return server.httpUrl;
  if (server.transportType === 'sse') return server.sseUrl;
  return [server.stdioCommand, ...(server.stdioArgs ?? [])].filter(Boolean).join(' ');
}

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
  stations,
  active,
  onOpenWebSearch,
}: {
  mcp?: McpBridge;
  models?: ModelsBridge;
  /** Where tools are kept in rooms; used to say "Kept on the bookshelf in the Reading room". */
  stations?: StationsBridge;
  active: boolean;
  onOpenWebSearch?(): void;
}) {
  const [definitions, setDefinitions] = useState<{ name: string; description: string }[] | null>(null);
  const [searchServers, setSearchServers] = useState<string | null>(null);
  const [servers, setServers] = useState<MCPServerSummary[]>([]);
  const [tools, setTools] = useState<MCPToolSummary[]>([]);
  const [presets, setPresets] = useState<MCPPresetSummary[]>([]);
  const [stationList, setStationList] = useState<StationView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<ServerDraft | null>(null);

  const reload = useCallback(async () => {
    const [nextDefinitions, nextServers, nextTools, nextPresets, routing, nextStations] = await Promise.all([
      mcp?.getToolDefinitionsForLLM?.().catch(() => null) ?? null,
      mcp?.listServers().catch(() => []) ?? [],
      mcp?.listTools().catch(() => []) ?? [],
      mcp?.listPresets?.().catch(() => []) ?? [],
      models?.get().catch(() => null) ?? null,
      stations?.list().catch(() => [] as StationView[]) ?? [],
    ]);
    setStationList(nextStations);
    setDefinitions(nextDefinitions);
    setServers(nextServers);
    setTools(nextTools);
    setPresets(nextPresets);
    if (routing) {
      const route = routing.routes.search;
      const ids = route?.server ? [route.server, ...(route.backups ?? []).map((backup) => backup.server)] : [];
      const names = ids
        .map((id) => routing.servers.find((server) => server.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      setSearchServers(names.length > 0 ? names.join(', then ') : '');
    }
  }, [mcp, models, stations]);

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

  /** Connect a server, or for an OAuth server open the browser sign-in. Throws a readable error on failure. */
  const startServer = async (server: MCPServerSummary) => {
    if (!mcp) return;
    const result = server.oauth && mcp.signIn ? await mcp.signIn(server.id) : await mcp.connectServer(server.id);
    if (!result.success) throw new Error(result.error ?? `Couldn’t connect to ${server.name}.`);
  };

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (!mcp || !adding) return;
    const draft = adding;
    await run(
      'add',
      async () => {
        const server = await mcp.addServer(draftToConfig(draft));
        setAdding(null);
        await startServer(server);
      },
      'Couldn’t add that server.',
    );
  };

  const handleAddPreset = async (preset: MCPPresetSummary) => {
    const addPreset = mcp?.addPreset?.bind(mcp);
    if (!addPreset) return;
    await run(
      `preset:${preset.id}`,
      async () => {
        const server = await addPreset(preset.id);
        await startServer(server);
      },
      `Couldn’t add ${preset.name}.`,
    );
  };

  const stationFor = (serverId: string): StationView | undefined => stationList.find((station) => station.serverId === serverId);
  const signOut = mcp?.signOut?.bind(mcp);
  const builtIn = (definitions ?? []).filter(
    (definition) => !tools.some((tool) => tool.llmName === definition.name),
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
              .filter((tool) => tool.enabled && definitions.some((d) => d.name === tool.llmName))
              .map((tool) => (
                <li key={tool.id}>
                  <code>{tool.llmName}</code>
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
              const needsSignIn = server.connectionStatus === 'needs-sign-in' && Boolean(server.oauth);
              return (
                <article key={server.id} className="toolsSettings__server" aria-label={server.name}>
                  <div className="toolsSettings__serverHeader">
                    <strong>{server.name}</strong>
                    <code>{serverAddress(server)}</code>
                    <span className="toolsSettings__status" data-status={server.connectionStatus}>
                      {statusText(server)}
                    </span>
                  </div>
                  {stationFor(server.id) ? (
                    <p className="kiosk__helper">
                      Kept on the {stationFor(server.id)?.objectName} in the {stationFor(server.id)?.roomName}
                    </p>
                  ) : null}
                  {server.lastError ? (
                    <p className="kiosk__helper" style={{ whiteSpace: 'pre-wrap' }}>
                      {server.lastError}
                    </p>
                  ) : null}
                  <div className="toolsSettings__actions">
                    {connected ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void run(server.id, () => mcp.disconnectServer(server.id), 'Couldn’t disconnect.')}
                      >
                        Disconnect
                      </button>
                    ) : needsSignIn ? (
                      <button
                        type="button"
                        className="faces__submit"
                        disabled={busy !== null}
                        onClick={() => void run(server.id, () => startServer(server), 'Couldn’t sign in.')}
                      >
                        {busy === server.id ? 'Waiting for the browser…' : 'Sign in'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy !== null}
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
                    {server.oauth && signOut ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void run(server.id, () => signOut(server.id), 'Couldn’t sign out.')}
                      >
                        Sign out
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void run(server.id, () => mcp.deleteServer(server.id), 'Couldn’t remove that server.')}
                    >
                      Remove
                    </button>
                  </div>
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
                            <code>{tool.llmName || tool.toolName}</code>
                          </label>
                          <select
                            aria-label={`When ${tool.llmName || tool.toolName} runs`}
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
                          <select
                            aria-label={`Does ${tool.llmName || tool.toolName} change things`}
                            value={tool.readOnly ? 'reads' : 'changes'}
                            disabled={busy !== null || !tool.enabled}
                            onChange={(event) =>
                              void run(
                                tool.id,
                                () => mcp.updateToolPreferences(tool.id, { readOnly: event.target.value === 'reads' }),
                                'Couldn’t save that.',
                              )
                            }
                          >
                            <option value="changes">Changes things</option>
                            <option value="reads">Only reads</option>
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
                  Connects by
                  <select
                    value={adding.connectsBy}
                    onChange={(event) => setAdding({ ...adding, connectsBy: event.target.value as ConnectsBy })}
                  >
                    <option value="http">Web address</option>
                    <option value="stdio">Program on this PC</option>
                    <option value="sse">Older web address (SSE)</option>
                  </select>
                </label>

                {adding.connectsBy === 'stdio' ? (
                  <>
                    <label>
                      Command
                      <input
                        required
                        value={adding.command}
                        onChange={(event) => setAdding({ ...adding, command: event.target.value })}
                        placeholder="npx"
                      />
                    </label>
                    <label>
                      Arguments (one per line)
                      <textarea
                        rows={3}
                        value={adding.argsText}
                        onChange={(event) => setAdding({ ...adding, argsText: event.target.value })}
                        placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\Documents'}
                      />
                    </label>
                    <label>
                      Environment (KEY=value, one per line)
                      <textarea
                        rows={2}
                        value={adding.envText}
                        onChange={(event) => setAdding({ ...adding, envText: event.target.value })}
                        placeholder="API_KEY=…"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      {adding.connectsBy === 'sse' ? 'SSE URL' : 'Web address'}
                      <input
                        type="url"
                        required
                        value={adding.url}
                        onChange={(event) => setAdding({ ...adding, url: event.target.value })}
                        placeholder={
                          adding.connectsBy === 'sse' ? 'http://192.168.1.20:8123/mcp_server/sse' : 'https://example.com/mcp'
                        }
                      />
                    </label>
                    <label>
                      Sign-in
                      <select
                        value={adding.signIn}
                        onChange={(event) => setAdding({ ...adding, signIn: event.target.value as SignInKind })}
                      >
                        <option value="none">None</option>
                        <option value="header">Token in a header</option>
                        {adding.connectsBy === 'http' ? <option value="oauth">Sign in with the browser (OAuth)</option> : null}
                      </select>
                    </label>
                    {adding.signIn === 'header' ? (
                      <>
                        <label>
                          Auth header
                          <input value={adding.header} onChange={(event) => setAdding({ ...adding, header: event.target.value })} />
                        </label>
                        <label>
                          Auth value
                          <input
                            type="password"
                            value={adding.token}
                            onChange={(event) => setAdding({ ...adding, token: event.target.value })}
                            placeholder="Bearer …"
                          />
                        </label>
                      </>
                    ) : null}
                    {adding.signIn === 'oauth' ? (
                      <label>
                        Permission to ask for (optional)
                        <input
                          value={adding.scope}
                          onChange={(event) => setAdding({ ...adding, scope: event.target.value })}
                          placeholder="papers:read"
                        />
                      </label>
                    ) : null}
                  </>
                )}

                <div className="toolsSettings__actions">
                  <button
                    type="submit"
                    className="faces__submit"
                    disabled={busy !== null || (adding.connectsBy === 'stdio' ? !adding.command.trim() : !adding.url.trim())}
                  >
                    {busy === 'add' ? 'Adding…' : adding.signIn === 'oauth' && adding.connectsBy === 'http' ? 'Add and sign in' : 'Add and connect'}
                  </button>
                  <button type="button" onClick={() => setAdding(null)}>
                    Cancel
                  </button>
                </div>
                {adding.connectsBy === 'stdio' ? (
                  <p className="kiosk__helper">
                    The program starts with this app and stops when it closes. Only add programs you trust.
                  </p>
                ) : null}
              </form>
            ) : (
              <button type="button" className="faces__submit" onClick={() => setAdding({ ...EMPTY_DRAFT })}>
                Add an MCP server
              </button>
            )}

            {mcp.listPresets && presets.length > 0 ? (
              <div aria-label="Ready-made servers" role="group" className="toolsSettings__presets">
                <h4>Ready-made servers</h4>
                {presets.map((preset) => {
                  const added = servers.some((server) => (server.httpUrl ?? server.sseUrl) === preset.url);
                  return (
                    <article key={preset.id} className="toolsSettings__server" aria-label={`Ready-made ${preset.name}`}>
                      <div className="toolsSettings__serverHeader">
                        <strong>{preset.name}</strong>
                      </div>
                      <p className="kiosk__helper">{preset.description}</p>
                      <div className="toolsSettings__actions">
                        <button
                          type="button"
                          disabled={busy !== null || added}
                          onClick={() => void handleAddPreset(preset)}
                        >
                          {busy === `preset:${preset.id}` ? 'Adding…' : added ? 'Added' : 'Add'}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
