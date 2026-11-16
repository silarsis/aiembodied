import type { MCPServerConfigInput } from './types.js';

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

/** The preset list in the shape the renderer needs (no config internals beyond the address). */
export interface MCPPresetSummary {
  id: string;
  name: string;
  description: string;
  url: string;
}

export function listPresetSummaries(): MCPPresetSummary[] {
  return MCP_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    url: preset.config.httpUrl ?? preset.config.sseUrl ?? '',
  }));
}
