// Types only: shared/ holds what the main process and the renderer both need.


export interface MemoryPanelStatus {
  enabled: boolean;
  url: string | null;
  reachable: boolean;
  health: Record<string, unknown> | null;
  pending: number;
  error: string | null;
}
