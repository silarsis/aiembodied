/** The Coding page's bridge from the renderer, shared by preload and renderer. Types only. */
import type { CodingConfig } from './types.js';
import type { CodingStatus, CodingView } from './coding-service.js';
import type { RunnerAnswer, RunnerEvent, RunnerTask, RunnerTaskRequest } from './runner-client.js';

export type { CodingConfig, CodingStatus, CodingView, RunnerAnswer, RunnerEvent, RunnerTask };

export interface CodingBridge {
  get(): Promise<CodingView>;
  /** Save new coding settings (workspaces, runner, coder model file) and apply them. */
  set(coding: CodingConfig): Promise<CodingView>;
  status(): Promise<CodingStatus>;
  /** Opens a file dialog for a .gguf file; null if cancelled. */
  pickGguf(): Promise<string | null>;
  /** Opens a folder dialog; null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** The checks command the runner detected for a saved workspace. */
  suggestChecks(workspaceId: string): Promise<string | null>;
}

/** The task cards on the status panel: follow and control coding tasks. */
export interface CodingTasksBridge {
  list(): Promise<RunnerTask[]>;
  get(id: string): Promise<RunnerTask>;
  /** The diff against the base commit, as text. */
  diff(id: string): Promise<string>;
  start(request: Pick<RunnerTaskRequest, 'workspace_id' | 'goal' | 'acceptance'>): Promise<RunnerTask>;
  answer(id: string, answer: RunnerAnswer): Promise<RunnerTask>;
  followUp(id: string, message: string): Promise<RunnerTask>;
  cancel(id: string): Promise<RunnerTask>;
  discard(id: string): Promise<RunnerTask>;
  /** Push the branch and open the pull request. Kevin pressing the button is the approval. */
  apply(id: string): Promise<RunnerTask>;
  /** A task changed (status, tool, question). */
  onEvent(listener: (event: RunnerEvent) => void): () => void;
}

/** Echo is busy getting its own model back from the coder: shown as a card while Kevin waits. */
export interface CodingBusy {
  busy: boolean;
  message?: string;
}

export interface CodingBusyBridge {
  onChanged(listener: (busy: CodingBusy) => void): () => void;
}
