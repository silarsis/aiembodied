/** What the renderer sees of agent time. Types only; shared by preload and renderer. */

/** Which avatars are asleep, for the idle director. */
export interface AgentsBridge {
  asleep(): Promise<string[]>;
  /** Called when the set of sleeping avatars changes. Returns the unsubscribe function. */
  onChanged(listener: (asleep: string[]) => void): () => void;
}

export interface WorkflowsStatus {
  /** False when WORKFLOWS_ENABLED=0. */
  enabled: boolean;
  /** AGENT_LIFE: the life workflows run the idle life. */
  agentLife: boolean;
  url: string | null;
  /** The service answered. */
  reachable: boolean;
  /** The service can reach the Temporal server (null when the service is down). */
  temporal: boolean | null;
  /** Avatars with a life workflow, as the service reports them. */
  agents: string[];
  asleep: string[];
  temporalUiUrl: string | null;
}

export interface WorkflowsBridge {
  status(): Promise<WorkflowsStatus>;
}
