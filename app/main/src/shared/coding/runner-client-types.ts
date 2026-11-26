// Types only: shared/ holds what the main process and the renderer both need.

export interface RunnerModelRef {
  provider: 'local' | 'openai' | 'anthropic';
  id: string;
}

/** One pending question of a task (the runner's `questions` list, oldest first). */
export interface RunnerQuestion {
  id: string;
  /** confirm: a guard confirmation; select: pick one of options; input: free text for an input/editor dialog; ask_echo: pi called its ask_echo tool; text: pi ended its turn with a question. */
  kind: 'confirm' | 'select' | 'input' | 'ask_echo' | 'text';
  method: string;
  title?: string | null;
  message?: string | null;
  options?: unknown[] | null;
  asked_at?: string;
}

export interface RunnerReview {
  no_changes?: boolean;
  summary?: string;
  files?: Array<{ path: string; added: number; deleted: number; binary?: boolean }>;
  changed_files?: string[];
  added?: number;
  deleted?: number;
  changed_lines?: number;
  protected_violations?: string[];
  flags?: string[];
}

/** A task as the runner returns it (see services/coder/API.md). */
export interface RunnerTask {
  id: string;
  status: string;
  workspace_id?: string;
  goal?: string;
  acceptance?: string[];
  scope?: string[];
  branch?: string | null;
  phase_detail?: string | null;
  current_tool?: string | null;
  files_touched?: string[];
  question?: RunnerQuestion | null;
  questions?: RunnerQuestion[];
  last_text?: string | null;
  checks_ok?: boolean | null;
  checks_output?: string | null;
  review?: RunnerReview | null;
  pr_url?: string | null;
  pr_state?: string | null;
  error?: string | null;
  provider?: string | null;
  model?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface RunnerAnswer {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  dialog_id?: string;
}

export interface RunnerTaskRequest {
  workspace_id: string;
  goal: string;
  acceptance?: string[];
  scope?: string[];
  model?: RunnerModelRef;
}

/** One message of GET /v1/events. task_id is null for the message sent on connect. */
export interface RunnerEvent {
  /** "pr" when the task's pull request changed state; other messages carry no type. */
  type?: string;
  task_id: string | null;
  pr_state?: string | null;
  ci_state?: string | null;
  status?: string | null;
  current_tool?: string | null;
  question?: unknown;
  questions?: RunnerQuestion[];
  local_model_needed?: boolean;
  hold?: boolean;
}
