// Types only: shared/ holds what the main process and the renderer both need.

/** Which list of models a use reads from a server. */
export type ModelRole =
  'chat' | 'transcribe' | 'voices' | 'realtime' | 'motion' | 'image' | 'mesh' | 'decide';

export type ProbeStatus = 'up' | 'down' | 'needs-key' | 'error';

export interface ServerProbe {
  status: ProbeStatus;
  /** Why it is not up, in words for the user. */
  message?: string;
  models: Partial<Record<ModelRole, string[]>>;
  /** ComfyUI: jobs running or waiting. */
  queue?: number;
  checkedAt: number;
}
