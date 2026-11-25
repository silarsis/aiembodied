/**
 * Agent time (docs/features/agent-time.md): the settings that switch it on and off. Temporal and the workflows service
 * run each avatar's life; this app does what they ask. WORKFLOWS_ENABLED=0 turns the whole thing off. AGENT_LIFE=0 keeps
 * the tools and the service but leaves the idle life to the older ProactiveTick and NextDoorReturn.
 */

export interface AgentTimeSettings {
  /** The workflows service is used at all: tools, acts, agent sync, prompt notes. */
  enabled: boolean;
  /** The life workflows replace the proactive tick and the next-door return. */
  agentLife: boolean;
  url: string;
  token: string | null;
  /** The built-in Temporal web UI, shown on the Status panel. */
  temporalUiUrl: string;
}

export const DEFAULT_WORKFLOWS_URL = 'http://127.0.0.1:8198';
export const DEFAULT_TEMPORAL_UI_URL = 'http://127.0.0.1:8233';

export function agentTimeSettingsFromEnv(env: NodeJS.ProcessEnv): AgentTimeSettings {
  const enabled = env.WORKFLOWS_ENABLED?.trim() !== '0';
  return {
    enabled,
    agentLife: enabled && env.AGENT_LIFE?.trim() !== '0',
    url: (env.WORKFLOWS_URL?.trim() || DEFAULT_WORKFLOWS_URL).replace(/\/+$/, ''),
    token: env.WORKFLOWS_API_TOKEN?.trim() || null,
    temporalUiUrl: (env.TEMPORAL_UI_URL?.trim() || DEFAULT_TEMPORAL_UI_URL).replace(/\/+$/, ''),
  };
}
