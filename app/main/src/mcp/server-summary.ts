import type { MCPServerConfig, MCPServerSummary } from '../shared/mcp/types.js';

/**
 * Strip every secret from a server config before it goes to the renderer:
 * header tokens become `hasAuthToken`, program environment values are dropped (names stay).
 * OAuth tokens are never part of the config at all (they live in the mcp_oauth table).
 */
export function toServerSummary(config: MCPServerConfig): MCPServerSummary {
  const { sseAuthToken, httpAuthToken, stdioEnv, ...rest } = config;
  return {
    ...rest,
    hasAuthToken: Boolean(sseAuthToken || httpAuthToken || rest.tokenFromModelServer),
    stdioEnvKeys: stdioEnv ? Object.keys(stdioEnv) : undefined,
  };
}
