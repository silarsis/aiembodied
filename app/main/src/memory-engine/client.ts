/**
 * HTTP client for the memory engine (services/memory, API.md there). Every call has a time
 * limit: memory must never hold up a conversation.
 */

export interface MemoryEngineSession {
  started_at: string;
  agent?: string | null;
  channel?: string | null;
  title?: string | null;
  location?: string | null;
  ended_at?: string | null;
  meta?: Record<string, unknown>;
}

export interface MemoryEngineMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  created_at: string;
  speaker?: string | null;
  location?: string | null;
  tool?: { name: string; arguments?: unknown; ok?: boolean } | null;
  private?: boolean;
  meta?: Record<string, unknown>;
  session?: MemoryEngineSession;
}

export interface MemoryEngineHealth {
  status: 'ok' | 'starting';
  version: string;
  database: 'ready' | 'unavailable';
  schema_version: number;
  error?: string;
  counts?: { sessions: number; messages: number; indexed: number };
}

export interface MemoryEngineSearchResult {
  id: string;
  kind: string;
  source_id: string;
  session_id: string | null;
  agent: string | null;
  period_start: string;
  period_end: string;
  text: string;
  score: number;
  private: boolean;
}

/** A failed call. `retryable` is false when the engine rejected the request itself. */
export class MemoryEngineError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MemoryEngineError';
  }
}

export interface MemoryEngineClientOptions {
  baseUrl: string;
  apiToken?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class MemoryEngineClient {
  readonly baseUrl: string;

  private readonly apiToken?: string;

  private readonly timeoutMs: number;

  private readonly fetchFn: typeof fetch;

  constructor(options: MemoryEngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  health(): Promise<MemoryEngineHealth> {
    return this.request<MemoryEngineHealth>('GET', '/health', undefined, 2000);
  }

  putSession(id: string, session: MemoryEngineSession): Promise<{ id: string }> {
    return this.request('PUT', `/v1/sessions/${encodeURIComponent(id)}`, session);
  }

  postMessages(messages: MemoryEngineMessage[]): Promise<{ inserted: number; duplicates: number }> {
    return this.request('POST', '/v1/messages', { messages });
  }

  async search(
    query: string,
    options: { from?: string; to?: string; agent?: string; limit?: number; includePrivate?: boolean } = {},
  ): Promise<MemoryEngineSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    if (options.agent) params.set('agent', options.agent);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.includePrivate === false) params.set('include_private', 'false');
    const body = await this.request<{ results: MemoryEngineSearchResult[] }>('GET', `/v1/search?${params.toString()}`);
    return body.results;
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MemoryEngineError(`memory engine unreachable at ${this.baseUrl}: ${reason}`, null, true);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown };
        message = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.detail ?? parsed).slice(0, 300);
      } catch {
        // Not JSON; keep the raw text.
      }
      // 4xx means the request itself was refused, except auth (fixable by settings), timeouts and
      // rate limits; those, and 5xx (the database is down), are worth retrying.
      const retryable = response.status >= 500 || [401, 403, 408, 429].includes(response.status);
      throw new MemoryEngineError(`memory engine ${method} ${path.split('?')[0]} failed (${response.status}): ${message}`, response.status, retryable);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
