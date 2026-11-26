// Types only: shared/ holds what the main process and the renderer both need.
import type { SwapState } from './model-swap-types.js';
import type { CodingConfig } from './types.js';


export interface CodingStatus {
  runnerUp: boolean;
  runnerUrl: string | null;
  localModelNeeded: boolean;
  swap: SwapState;
  /** The GGUF found on this PC when none is picked. */
  detectedGguf: string | null;
  /** Why the runner refused the workspaces, if it did. */
  workspaceError: string | null;
  /** The model controller's state, in words (whether it is in use and the lease state); absent without one. */
  controller?: string | null;
}


/** What the Coding page shows. */
export interface CodingView {
  coding: CodingConfig;
  /** The runner server in use (the saved one, or the built-in one if that is gone). */
  runnerId: string | null;
  status: CodingStatus;
}
