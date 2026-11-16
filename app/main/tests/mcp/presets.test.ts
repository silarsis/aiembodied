import { describe, it, expect } from 'vitest';
import { DAIR_ACADEMY_PAPERS_PRESET_ID, MCP_PRESETS, findPreset, listPresetSummaries } from '../../src/mcp/presets.js';
import { toServerSummary } from '../../src/mcp/server-summary.js';

describe('MCP presets', () => {
  it('has the DAIR Academy papers preset', () => {
    const preset = findPreset(DAIR_ACADEMY_PAPERS_PRESET_ID);
    expect(DAIR_ACADEMY_PAPERS_PRESET_ID).toBe('dair-academy-papers');
    expect(preset).toMatchObject({
      name: 'DAIR Academy papers',
      config: { transportType: 'http', httpUrl: 'https://academy.dair.ai/api/mcp', oauth: true, oauthScope: 'papers:read', enabled: true, autoStart: true },
    });
    expect(preset?.description).toContain('Needs a free DAIR Academy account.');
    expect(MCP_PRESETS).toHaveLength(1);
    expect(listPresetSummaries()[0]).toEqual({
      id: 'dair-academy-papers',
      name: 'DAIR Academy papers',
      description: preset?.description,
      url: 'https://academy.dair.ai/api/mcp',
    });
  });
});

describe('toServerSummary', () => {
  it('drops tokens and environment values', () => {
    const summary = toServerSummary({
      id: 'a', name: 'A', transportType: 'stdio', enabled: true, autoStart: false, connectionStatus: 'connected',
      toolsDiscovered: 0, createdAt: 0, updatedAt: 0,
      sseAuthToken: 'one', httpAuthToken: 'two', stdioEnv: { SECRET: 'three' },
    });
    expect(JSON.stringify(summary)).not.toMatch(/one|two|three/);
    expect(summary).toMatchObject({ hasAuthToken: true, stdioEnvKeys: ['SECRET'] });
  });
});
