import type { MCPServerConfigInput } from '../shared/mcp/types.js';
import type { MCPPresetSummary } from '../shared/mcp/presets-types.js';

/**
 * Ready-made MCP servers the person can add with one button.
 * Other code (for example a bookshelf in the 3D room) refers to a preset by its id.
 */
export interface MCPPreset {
  id: string;
  name: string;
  description: string;
  /** What to store when the preset is added. */
  config: MCPServerConfigInput;
}

/** Id of the DAIR Academy papers preset (the AI research reading library). */
export const DAIR_ACADEMY_PAPERS_PRESET_ID = 'dair-academy-papers';

export const MCP_PRESETS: MCPPreset[] = [
  {
    id: DAIR_ACADEMY_PAPERS_PRESET_ID,
    name: 'DAIR Academy papers',
    description:
      'A reading library of AI research papers (AI Papers of the Week, Harness Engineering) from DAIR Academy. Needs a free DAIR Academy account.',
    config: {
      name: 'DAIR Academy papers',
      transportType: 'http',
      httpUrl: 'https://academy.dair.ai/api/mcp',
      oauth: true,
      oauthScope: 'papers:read',
      enabled: true,
      autoStart: true,
    },
  },
];

export function findPreset(id: string): MCPPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}

export function listPresetSummaries(): MCPPresetSummary[] {
  return MCP_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    url: preset.config.httpUrl ?? preset.config.sseUrl ?? '',
  }));
}

// -- Home Assistant -----------------------------------------------------------------------------

/**
 * Home Assistant's own "MCP Server" integration lives at `<home address>/api/mcp` (Streamable HTTP, a long-lived
 * access token as a Bearer header). One ready-made server per home in "Models and servers"; its id is
 * `home-assistant:<model server id>`. The token is never copied: the MCP server keeps only the model server's id
 * (`tokenFromModelServer`) and main reads the token at connect time.
 */
export const HOME_ASSISTANT_PRESET_PREFIX = 'home-assistant:';

/** A home from "Models and servers" (no token: the renderer never gets one). */
export interface HomeAssistantHome {
  /** The model server id. */
  id: string;
  name: string;
  /** The home's base address, e.g. http://homeassistant-1:8123. */
  url: string;
}

export function homeAssistantMcpUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/api/mcp`;
}

/** The ready-made server for one home. */
export function homeAssistantPreset(home: HomeAssistantHome): MCPPreset {
  return {
    id: `${HOME_ASSISTANT_PRESET_PREFIX}${home.id}`,
    name: `Home Assistant: ${home.name}`,
    description: `Control and ask about ${home.name} through its Home Assistant MCP Server integration. Uses the token saved for it in Models and servers.`,
    config: {
      name: `Home Assistant (${home.name})`,
      transportType: 'http',
      httpUrl: homeAssistantMcpUrl(home.url),
      httpAuthHeader: 'Authorization',
      tokenFromModelServer: home.id,
      enabled: true,
      autoStart: true,
    },
  };
}

/**
 * Home Assistant tools that only read, besides every name starting with `Get` (GetLiveContext, GetDateTime).
 * HA does not always send readOnlyHint, and a wrong "changes things" only costs a walk to the panel, while a wrong
 * "reads" would let a change happen from anywhere, so this list stays short and explicit.
 */
export const HOME_ASSISTANT_READ_TOOLS: readonly string[] = [
  'GetLiveContext',
  'GetDateTime',
  'HassGetState',
  'HassGetWeather',
  'todo_get_items',
];

/** The preset-level default for a Home Assistant tool: true for reads, false for everything else (HassTurnOn, ...). */
export function homeAssistantReadOnlyDefault(toolName: string): boolean {
  return toolName.startsWith('Get') || HOME_ASSISTANT_READ_TOOLS.includes(toolName);
}

/** Words that make a Home Assistant tool risky: it should ask first (confirmation level 'confirm') when first found. */
const RISKY_WORDS = /\b(un)?lock(s|ed|ing)?\b|\balarm\b|\b(dis)?arm(s|ed|ing)?\b|\bgarage\b/i;

export function isRiskyHomeAssistantTool(name: string, description: string | undefined): boolean {
  // Split HassLockUnlock / lock_door into words before looking for the risky ones.
  const words = `${name} ${description ?? ''}`
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ');
  return RISKY_WORDS.test(words);
}
