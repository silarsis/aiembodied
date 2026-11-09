/**
 * Talks to the coding runner (services/coder, see its API.md): setup calls, status, tasks and
 * the server-sent event stream. Fetch only, no extra dependency. Keys travel in request bodies
 * and are never logged.
 */

export interface RunnerHealth {
  ok: boolean;
  version?: string;
  pi?: { found: boolean; version?: string | null };
}

export interface RunnerModelRef {
  provider: 'local' | 'openai' | 'anthropic';
  id: string;
}

export interface RunnerSettings {
  local_llm_url: string;
  local_model: string;
  default_model: RunnerModelRef;
}

export interface RunnerStatus {
  local_model_needed: boolean;
  active: string[];
  /** True while the tasks on the local model are held (paused) for Echo. */
  hold?: boolean;
}

export interface RunnerWorkspace {
  id: string;
  [key: string]: unknown;
}

export interface RunnerKeys {
  openai?: string | null;
  anthropic?: string | null;
  github?: string | null;
}

export interface RunnerCapabilities {
  backend?: { name?: string; version?: string | null; models?: unknown[]; error?: string | null };
  workspaces?: Array<{ id: string; kind?: string; detected?: { checks_suggestion?: string | null; package_manager?: string | null; [key: string]: unknown } }>;
  [key: string]: unknown;
}

/** One pending question of a task (the runner's `questions` list, oldest first). */
export interface RunnerQuestion {
  id: string;
  /** confirm: a guard confirmation; ask_echo: pi called its ask_echo tool; text: pi ended its turn with a question. */
  kind: 'confirm' | 'ask_echo' | 'text';
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
  task_id: string | null;
  status?: string | null;
  current_tool?: string | null;
  question?: unknown;
  questions?: RunnerQuestion[];
  local_model_needed?: boolean;
  hold?: boolean;
}

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface CodingRunnerClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  /** Timeout of one request. Default 10 s. */
  timeoutMs?: number;
}

export class CodingRunnerClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CodingRunnerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  health(): Promise<RunnerHealth> {
    return this.request('GET', '/v1/health');
  }

  getSettings(): Promise<RunnerSettings> {
    return this.request('GET', '/v1/settings');
  }

  putSettings(settings: Partial<RunnerSettings>): Promise<RunnerSettings> {
    return this.request('PUT', '/v1/settings', settings);
  }

  getWorkspaces(): Promise<RunnerWorkspace[]> {
    return this.request('GET', '/v1/workspaces');
  }

  putWorkspaces(workspaces: Array<Record<string, unknown>>): Promise<RunnerWorkspace[]> {
    return this.request('PUT', '/v1/workspaces', workspaces);
  }

  /** Which keys the runner holds (never the keys). */
  getKeys(): Promise<Record<string, boolean>> {
    return this.request('GET', '/v1/keys');
  }

  async putKeys(keys: RunnerKeys): Promise<void> {
    await this.request('PUT', '/v1/keys', keys);
  }

  status(): Promise<RunnerStatus> {
    return this.request('GET', '/v1/status');
  }

  /** Pause (true) or resume (false) the tasks on the local model, so Echo can use the model server. */
  async setLocalHold(hold: boolean, reason?: string): Promise<void> {
    await this.request('PUT', '/v1/local/hold', { hold, ...(reason ? { reason } : {}) });
  }

  capabilities(refresh = false): Promise<RunnerCapabilities> {
    return this.request('GET', `/v1/capabilities${refresh ? '?refresh=1' : ''}`);
  }

  listTasks(status?: string): Promise<RunnerTask[]> {
    return this.request('GET', `/v1/tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  }

  getTask(id: string): Promise<RunnerTask> {
    return this.request('GET', `/v1/tasks/${encodeURIComponent(id)}`);
  }

  createTask(task: RunnerTaskRequest): Promise<RunnerTask> {
    return this.request('POST', '/v1/tasks', task);
  }

  /** The diff of a task against its base commit (plain text, at most 500 KB). */
  async taskDiff(id: string): Promise<string> {
    return this.request<string>('GET', `/v1/tasks/${encodeURIComponent(id)}/diff`, undefined, 'text');
  }

  steer(id: string, message: string): Promise<RunnerTask> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(id)}/steer`, { message });
  }

  followUp(id: string, message: string): Promise<RunnerTask> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(id)}/follow_up`, { message });
  }

  answer(id: string, answer: RunnerAnswer): Promise<RunnerTask> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(id)}/answer`, answer);
  }

  cancel(id: string): Promise<RunnerTask> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(id)}/cancel`);
  }

  /** Push the branch and open the pull request. */
  apply(id: string, draft = false): Promise<RunnerTask> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(id)}/apply`, { draft });
  }

  discard(id: string): Promise<RunnerTask> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(id)}/discard`);
  }

  /**
   * Follow GET /v1/events. Reconnects with a growing wait (1 s up to 30 s) when the stream ends or
   * fails; the wait starts over after a connection that worked. Returns a function that stops it.
   */
  subscribe(handlers: RunnerStreamHandlers, options: { sleep?: (ms: number) => Promise<void>; idleMs?: number } = {}): () => void {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // The runner sends a comment every 15 s; silence for longer means the connection is dead.
    const idleMs = options.idleMs ?? 45_000;
    let stopped = false;
    let controller: AbortController | null = null;
    void (async () => {
      let wait = 1000;
      while (!stopped) {
        controller = new AbortController();
        const current = controller;
        let connected = false;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => current.abort(), idleMs);
        };
        try {
          arm();
          const response = await this.fetchFn(`${this.baseUrl}/v1/events`, { headers: { Accept: 'text/event-stream' }, signal: current.signal });
          if (!response.ok || !response.body) throw new RunnerError(`The runner answered ${response.status}.`, response.status);
          connected = true;
          wait = 1000;
          handlers.onOpen?.();
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
              const event = parseEventBlock(block);
              if (event) handlers.onEvent(event);
            }
          }
        } catch (error) {
          if (!stopped) handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
        if (stopped) break;
        if (connected) handlers.onClose?.();
        await sleep(wait);
        wait = Math.min(wait * 2, 30_000);
      }
    })();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, as: 'json' | 'text' = 'json'): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { Accept: as === 'text' ? 'text/plain' : 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      void error;
      throw new RunnerError(`The coding runner is not answering at ${this.baseUrl}.`);
    }
    if (!response.ok) {
      let detail = '';
      try {
        const parsed = (await response.json()) as { detail?: unknown };
        detail = typeof parsed.detail === 'string' ? parsed.detail : '';
      } catch {
        // No JSON body.
      }
      throw new RunnerError(detail || `The coding runner answered ${response.status}.`, response.status);
    }
    if (response.status === 204) return undefined as T;
    if (as === 'text') return (await response.text()) as T;
    return (await response.json()) as T;
  }
}

export interface RunnerStreamHandlers {
  onEvent(event: RunnerEvent): void;
  /** The stream is connected. */
  onOpen?(): void;
  /** A connected stream ended or broke. */
  onClose?(): void;
  onError?(error: Error): void;
}

/** One SSE block: its data lines joined and parsed. Comments and bad JSON give null. */
export function parseEventBlock(block: string): RunnerEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null ? (parsed as RunnerEvent) : null;
  } catch {
    return null;
  }
}
