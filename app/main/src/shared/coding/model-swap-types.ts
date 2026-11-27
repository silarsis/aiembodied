// Types only: shared/ holds what the main process and the renderer both need.

export type SwapPhase =
  'idle' | 'waiting-for-quiet' | 'swapping-in' | 'coder-loaded' | 'swapping-back';

export interface SwapState {
  phase: SwapPhase;
  /** For the status panel, in words. */
  message: string;
}
