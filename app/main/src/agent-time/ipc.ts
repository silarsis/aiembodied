import { AgentSleep } from './sleep.js';
import { agentTimeSettingsFromEnv } from './settings.js';
import { WorkflowsClient } from './workflows-client.js';
import type { WorkflowsStatus } from '../shared/agent-time/bridge-types.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface AgentTimeIpcOptions {
  handle: HandleIpc;
  agentSleep: AgentSleep;
  agentTime: ReturnType<typeof agentTimeSettingsFromEnv>;
  workflowsClient: () => WorkflowsClient | null;
}

export function registerAgentTimeIpc(options: AgentTimeIpcOptions): void {
  const { handle, agentSleep, agentTime, workflowsClient } = options;

  // Agent time: who is asleep (the idle director skips them), and the workflows service for the Status panel.
  handle('agents:asleep', () => agentSleep.list());
  handle('workflows:status', async (): Promise<WorkflowsStatus> => {
    const base = {
      enabled: agentTime.enabled,
      agentLife: agentTime.agentLife,
      url: agentTime.enabled ? agentTime.url : null,
      asleep: agentSleep.list(),
      temporalUiUrl: agentTime.enabled ? agentTime.temporalUiUrl : null,
    };
    const workflows = workflowsClient();
    if (!agentTime.enabled || !workflows)
      return { ...base, reachable: false, temporal: null, agents: [] };
    try {
      const health = await workflows.health();
      return {
        ...base,
        reachable: true,
        temporal: health.temporal === true,
        agents: health.agents ?? [],
      };
    } catch {
      return { ...base, reachable: false, temporal: null, agents: [] };
    }
  });
}
