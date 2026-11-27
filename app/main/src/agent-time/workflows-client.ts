/**
 * A small client for the workflows service (services/workflows, API.md; default http://127.0.0.1:8198).
 * Every call has a 10 s timeout. A failed call throws a WorkflowsError whose message is the service's own detail text
 * (for a flow that fails validation, the list of messages), so a tool can hand it to the model to fix its flow.
 */

export const WORKFLOWS_TIMEOUT_MS = 10_000;

export class WorkflowsError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly errors: string[] = [],
  ) {
    super(message);
    this.name = 'WorkflowsError';
  }
}

export interface WorkflowsHealth {
  ok: boolean;
  version?: string;
  temporal: boolean;
  namespace?: string;
  agentLife: boolean;
  agents: string[];
}

export type WatchCondition = Record<string, unknown>;
export type WatchThen =
  { say: string } | { think: string } | { flow: string; inputs?: Record<string, unknown> };

export interface WorkflowsClientOptions {
  baseUrl: string;
  token?: string | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** The text of a FastAPI `detail`: a string, `{errors: [...]}`, or a list of validation items. */
export function describeDetail(detail: unknown): { message: string; errors: string[] } {
  if (typeof detail === 'string') return { message: detail, errors: [] };
  if (
    detail &&
    typeof detail === 'object' &&
    Array.isArray((detail as { errors?: unknown }).errors)
  ) {
    const errors = (detail as { errors: unknown[] }).errors.map((item) => String(item));
    return { message: errors.join('; '), errors };
  }
  if (Array.isArray(detail)) {
    const errors = detail.map((item) => {
      if (item && typeof item === 'object' && typeof (item as { msg?: unknown }).msg === 'string') {
        const loc = Array.isArray((item as { loc?: unknown }).loc)
          ? (item as { loc: unknown[] }).loc.slice(1).join('.')
          : '';
        return `${loc ? `${loc}: ` : ''}${(item as { msg: string }).msg}`;
      }
      return JSON.stringify(item);
    });
    return { message: errors.join('; '), errors };
  }
  return { message: detail === undefined ? '' : JSON.stringify(detail).slice(0, 300), errors: [] };
}

export class WorkflowsClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: WorkflowsClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? WORKFLOWS_TIMEOUT_MS;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  health(): Promise<WorkflowsHealth> {
    return this.request('GET', '/health');
  }

  putAgents(
    agents: Array<{ id: string; name: string }>,
  ): Promise<{ agents: string[]; started: string[]; stopped: string[] }> {
    return this.request('PUT', '/v1/agents', { agents });
  }

  life(avatarId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/agents/${encodeURIComponent(avatarId)}/life`);
  }

  sleep(avatarId: string, reason: string): Promise<unknown> {
    return this.request('POST', `/v1/agents/${encodeURIComponent(avatarId)}/sleep`, { reason });
  }

  wake(avatarId: string): Promise<unknown> {
    return this.request('POST', `/v1/agents/${encodeURIComponent(avatarId)}/wake`, {});
  }

  createReminder(body: {
    avatarId: string;
    at?: string;
    inSeconds?: number;
    text: string;
    alarm?: boolean;
  }): Promise<{ workflowId: string; intentionId: string; dueAt: string }> {
    return this.request('POST', '/v1/reminders', body);
  }

  createWakeup(body: {
    avatarId: string;
    at?: string;
    inSeconds?: number;
    note: string;
  }): Promise<{ workflowId: string; intentionId: string; dueAt: string }> {
    return this.request('POST', '/v1/wakeups', body);
  }

  createWatch(body: {
    avatarId: string;
    condition: WatchCondition;
    then: WatchThen;
    untilHours?: number;
  }): Promise<{ workflowId: string; intentionId: string }> {
    return this.request('POST', '/v1/watches', body);
  }

  listFlows(avatarId: string): Promise<{ flows: Array<Record<string, unknown>> }> {
    return this.request('GET', `/v1/flows?avatarId=${encodeURIComponent(avatarId)}`);
  }

  getFlow(avatarId: string, name: string): Promise<Record<string, unknown>> {
    return this.request(
      'GET',
      `/v1/flows/${encodeURIComponent(avatarId)}/${encodeURIComponent(name)}`,
    );
  }

  putFlow(
    avatarId: string,
    name: string,
    body: {
      description: string;
      definition: Record<string, unknown>;
      trigger: Record<string, unknown>;
      enabled?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    return this.request(
      'PUT',
      `/v1/flows/${encodeURIComponent(avatarId)}/${encodeURIComponent(name)}`,
      body,
    );
  }

  runFlow(
    avatarId: string,
    name: string,
    inputs?: Record<string, unknown>,
  ): Promise<{ workflowId: string }> {
    return this.request(
      'POST',
      `/v1/flows/${encodeURIComponent(avatarId)}/${encodeURIComponent(name)}/run`,
      inputs ? { inputs } : {},
    );
  }

  createIntention(body: {
    avatarId: string;
    kind: 'goal' | 'intention' | 'promise';
    text: string;
    why?: string;
    dueAt?: string;
    parentId?: string;
  }): Promise<Record<string, unknown>> {
    return this.request('POST', '/v1/intentions', body);
  }

  plans(avatarId: string): Promise<{
    workflows: Array<Record<string, unknown>>;
    intentions: Array<Record<string, unknown>>;
    flows: Array<Record<string, unknown>>;
  }> {
    return this.request('GET', `/v1/plans?avatarId=${encodeURIComponent(avatarId)}`);
  }

  signalPlan(workflowId: string, signal: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/v1/plans/${encodeURIComponent(workflowId)}/signal`, {
      signal,
      ...(args ? { args } : {}),
    });
  }

  dropPlan(workflowId: string, why?: string): Promise<unknown> {
    return this.request(
      'DELETE',
      `/v1/plans/${encodeURIComponent(workflowId)}${why ? `?why=${encodeURIComponent(why)}` : ''}`,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new WorkflowsError(
        `the workflows service is not reachable at ${this.options.baseUrl}: ${reason}`,
        null,
      );
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const detail =
        parsed && typeof parsed === 'object' && 'detail' in parsed
          ? (parsed as { detail: unknown }).detail
          : text.slice(0, 300);
      const { message, errors } = describeDetail(detail);
      throw new WorkflowsError(
        message || `the workflows service answered ${response.status}`,
        response.status,
        errors,
      );
    }
    return parsed as T;
  }
}
