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

export interface MemoryEngineStorage {
  database: { local: boolean; where: string };
  mirror: { where: string; pushed_at: string | null; error: string | null } | null;
  moving: boolean;
  /** Why the last move didn't happen, if it didn't. */
  move_error?: string | null;
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
  /** Cosine similarity to the query, when the item and query were embedded. */
  similarity?: number | null;
  matched?: string[];
  /** Where it came from; absent or "conversation" for memory of conversations. */
  source?: string;
  /** Home Assistant events only: which home it happened in. */
  home_id?: string | null;
  home_name?: string | null;
}

export interface MemoryEngineSearchOptions {
  from?: string;
  to?: string;
  agent?: string;
  limit?: number;
  includePrivate?: boolean;
  kinds?: string[];
  exclude?: string[];
  mode?: 'hybrid' | 'text';
  /** Which memory to search (the engine's default is conversations only). */
  source?: 'conversation' | 'home_assistant' | 'coding' | 'all';
  timeoutMs?: number;
  /** The agent is using what it finds: facts among the results are refreshed (not for the panel). */
  touch?: boolean;
  sessionId?: string | null;
}

export interface MemoryEngineTimelineSession {
  session_id: string;
  agent: string | null;
  channel: string | null;
  title: string | null;
  started_at: string;
  last_at: string;
  message_count: number;
  /** The background summary of the conversation, once it has one. */
  summary?: { id: string; title: string | null; text: string; topics: string[] } | null;
  turns: Array<{ id: string; at: string; text: string }>;
}

/** A day, week or month summary. */
export interface MemoryEngineSummary {
  id: string;
  kind: string;
  period_start: string;
  period_end: string;
  title: string | null;
  text: string;
  topics: string[];
}

export interface MemoryEngineTimeline {
  summaries: MemoryEngineSummary[];
  sessions: MemoryEngineTimelineSession[];
}

export interface MemoryEngineMemoryDetail {
  id: string;
  kind: string;
  period_start: string;
  session_id?: string;
  agent?: string | null;
  text?: string;
  subject?: string | null;
  status?: string;
  messages?: Array<{ id: string; role: string; speaker: string | null; content: string; tool: { name?: string } | null; created_at: string }>;
}

/** A stored fact, as the engine lists it. */
export interface MemoryEngineStoredFact {
  id: string;
  text: string;
  subject: string | null;
  status: 'active' | 'superseded' | 'retracted';
  pinned: boolean;
  author: 'agent' | 'user' | 'extractor';
  agent: string | null;
  session_id: string | null;
  source_message_ids: string[];
  supersedes: string | null;
  private: boolean;
  reviewed_at: string | null;
  created_at: string;
  /** The model that wrote it (the conversation or summary model); null for the user's own. */
  model?: string | null;
  /** Conversations it was recalled in, and when last. */
  recall_count?: number;
  last_recalled_at?: string | null;
  /** 0-1: how easily it comes up; unused facts fade out of the brief (pinned stay at 1). */
  accessibility?: number;
}

export interface MemoryEngineFactPatch {
  text?: string;
  subject?: string | null;
  pinned?: boolean;
  status?: 'active' | 'superseded' | 'retracted';
  private?: boolean;
  reviewed?: boolean;
}

export interface MemoryEngineRecallLogEntry {
  id: number;
  at: string;
  session_id: string | null;
  query: string;
  items: Array<{ id: string; kind: string; score: number; similarity: number | null }>;
  reason: string | null;
}

export interface MemoryEngineBrief {
  agent: string | null;
  facts: Array<{ id: string; text: string; subject: string | null; pinned: boolean; created_at: string }>;
  last_session: {
    session_id: string;
    agent: string | null;
    channel: string | null;
    title: string | null;
    started_at: string;
    last_at: string;
    /** Its background summary, once made; otherwise use the turns. */
    summary?: string | null;
    turns: string[];
  } | null;
  recent_days?: Array<{ period_start: string; title: string | null; text: string }>;
  /** The newest note the agent left itself in another conversation, to show word for word. */
  handoff?: MemoryEngineHandoff | null;
  /** Up to three coding tasks finished in the last week, newest first. */
  recent_coding?: MemoryEngineCodingBrief[];
}

export interface MemoryEngineCodingBrief {
  task_id: string;
  workspace: string;
  title: string;
  outcome: 'done' | 'failed' | 'cancelled' | 'discarded';
  pr_url: string | null;
  pr_state?: string | null;
  finished_at: string;
}

/** A finished coding task, as POST /v1/coding/tasks takes it. */
export interface MemoryEngineCodingTask {
  task_id: string;
  workspace_id: string;
  workspace_name: string;
  title: string;
  outcome: 'done' | 'failed' | 'cancelled' | 'discarded';
  pr_url?: string | null;
  pr_state?: string | null;
  branch?: string | null;
  files_changed: string[];
  added: number;
  removed: number;
  review_flags: string[];
  summary: string;
  model?: string | null;
  provider?: string | null;
  agent?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface MemoryEngineHandoff {
  id: string;
  session_id: string;
  agent: string | null;
  model: string | null;
  text: string;
  written_at: string;
}

export interface MemoryEngineCorrection {
  /** A fact's id or its search result's id; or `about`, what the fact said. */
  id?: string;
  about?: string;
  action: 'replace' | 'retract';
  text?: string;
  new_id?: string;
  author?: 'agent' | 'user';
  agent?: string | null;
  model?: string | null;
  session_id?: string | null;
}

export interface MemoryEngineCorrectionResult {
  status: 'replaced' | 'retracted' | 'not_found' | 'ambiguous' | 'not_a_fact' | 'inactive' | 'pinned';
  fact?: { id: string; text: string };
  replacement?: { id: string; text: string };
  candidates?: Array<{ id: string; text: string }>;
}

export interface MemoryEngineRecallRequest {
  text: string;
  session_id?: string | null;
  exclude?: string[];
  limit?: number;
  max_chars?: number;
  min_similarity?: number;
}

export interface MemoryEngineRecall {
  items: MemoryEngineSearchResult[];
  /** Why nothing came back: "short", "no embedder" or "no strong match". */
  reason: string | null;
}

export interface MemoryEngineFact {
  text: string;
  subject?: string | null;
  author?: 'agent' | 'user' | 'extractor';
  agent?: string | null;
  session_id?: string | null;
  source_message_ids?: string[];
  supersedes?: string | null;
  pinned?: boolean;
  private?: boolean;
  model?: string | null;
}

/** A Home Assistant device or sensor the engine watches. */
export interface MemoryEngineHomeEntity {
  home_id: string;
  /** Which home it belongs to, when the engine says (it may watch several). */
  home_name?: string | null;
  entity_id: string;
  name: string | null;
  area: string | null;
  domain: string;
  class: string;
  unit: string | null;
  last_state: string | null;
  last_value: number | null;
}

export interface MemoryEngineHomeChange {
  at: string;
  kind: string;
  state: string | null;
  old_state: string | null;
  value: number | null;
  text: string | null;
}

export interface MemoryEngineHomeReading {
  hour: string;
  min: number | null;
  mean: number | null;
  max: number | null;
  last: number | null;
}

/** Several entities fit the question (`matches`), or one entity with what it did. */
export interface MemoryEngineHomeHistory {
  matches?: MemoryEngineHomeEntity[];
  entity?: MemoryEngineHomeEntity;
  from?: string;
  to?: string;
  changes?: MemoryEngineHomeChange[];
  /** Numeric entities only. */
  readings?: MemoryEngineHomeReading[];
  raw?: Array<{ at: string; value: number | null }>;
}

/** A Home Assistant server for the engine to watch. The token is held in the engine's memory only. */
export interface MemoryEngineHomeServer {
  id: string;
  name: string;
  url: string;
  token: string;
  label?: string | null;
  entities?: string[];
}

/** One home the engine watches; never carries a token. */
export interface MemoryEngineHomeStatus {
  id: string;
  name: string;
  source: 'env' | 'app';
  configured: boolean;
  connected: boolean;
  url: string | null;
  label: string | null;
  watched: number;
  events_today: number;
  last_event_at: string | null;
  error: string | null;
  note: string | null;
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

  async search(query: string, options: MemoryEngineSearchOptions = {}): Promise<MemoryEngineSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    if (options.agent) params.set('agent', options.agent);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.includePrivate === false) params.set('include_private', 'false');
    if (options.mode) params.set('mode', options.mode);
    if (options.source) params.set('source', options.source);
    for (const kind of options.kinds ?? []) params.append('kind', kind);
    for (const id of options.exclude ?? []) params.append('exclude', id);
    if (options.touch) {
      params.set('touch', 'true');
      if (options.sessionId) params.set('session_id', options.sessionId);
    }
    const body = await this.request<{ results: MemoryEngineSearchResult[] }>(
      'GET',
      `/v1/search?${params.toString()}`,
      undefined,
      options.timeoutMs,
    );
    return body.results;
  }

  homeHistory(
    options: { entity?: string; q?: string; from?: string; to?: string; limit?: number } = {},
  ): Promise<MemoryEngineHomeHistory> {
    const params = new URLSearchParams();
    if (options.entity) params.set('entity', options.entity);
    if (options.q) params.set('q', options.q);
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    if (options.limit) params.set('limit', String(options.limit));
    return this.request('GET', `/v1/home/history?${params.toString()}`);
  }

  /** Replace the app-managed homes the engine watches. Answers with the status of every home. */
  async setHomeServers(servers: MemoryEngineHomeServer[]): Promise<MemoryEngineHomeStatus[]> {
    const body = await this.request<{ homes: MemoryEngineHomeStatus[] }>('PUT', '/v1/home/servers', { servers });
    return body.homes;
  }

  async homeStatus(): Promise<MemoryEngineHomeStatus[]> {
    const body = await this.request<{ homes: MemoryEngineHomeStatus[] }>('GET', '/v1/home/status', undefined, 5000);
    return body.homes;
  }

  async homeEntities(q?: string): Promise<MemoryEngineHomeEntity[]> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    const query = params.toString();
    const body = await this.request<{ entities: MemoryEngineHomeEntity[] }>('GET', `/v1/home/entities${query ? `?${query}` : ''}`);
    return body.entities;
  }

  async timeline(
    from: string,
    to: string,
    options: { turns?: number; includePrivate?: boolean; limit?: number } = {},
  ): Promise<MemoryEngineTimeline> {
    const params = new URLSearchParams({ from, to });
    if (options.turns !== undefined) params.set('turns', String(options.turns));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.includePrivate === false) params.set('include_private', 'false');
    const body = await this.request<Partial<MemoryEngineTimeline>>('GET', `/v1/timeline?${params.toString()}`);
    return { summaries: body.summaries ?? [], sessions: body.sessions ?? [] };
  }

  async listFacts(
    options: { status?: 'active' | 'superseded' | 'retracted' | 'all'; unreviewed?: boolean; limit?: number } = {},
  ): Promise<MemoryEngineStoredFact[]> {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.unreviewed) params.set('unreviewed', 'true');
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    const body = await this.request<{ facts: MemoryEngineStoredFact[] }>('GET', `/v1/facts${query ? `?${query}` : ''}`);
    return body.facts;
  }

  patchFact(id: string, patch: MemoryEngineFactPatch): Promise<{ id: string }> {
    return this.request('PATCH', `/v1/facts/${encodeURIComponent(id)}`, patch);
  }

  deleteFact(id: string): Promise<unknown> {
    return this.request('DELETE', `/v1/facts/${encodeURIComponent(id)}`);
  }

  deleteSession(id: string): Promise<unknown> {
    return this.request('DELETE', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  async recallLog(options: { sessionId?: string; limit?: number } = {}): Promise<MemoryEngineRecallLogEntry[]> {
    const params = new URLSearchParams();
    if (options.sessionId) params.set('session_id', options.sessionId);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    const body = await this.request<{ entries: MemoryEngineRecallLogEntry[] }>('GET', `/v1/recall-log${query ? `?${query}` : ''}`);
    return body.entries;
  }

  /** Do due summaries now, rather than waiting for quiet. Can take minutes with a local model. */
  runSummaries(limit = 20): Promise<{ done: Array<Record<string, unknown>> }> {
    return this.request('POST', '/v1/summaries/run', { limit }, 30 * 60_000);
  }

  /** Where the engine keeps memory now, and the mirror (passwords never come back). */
  storage(): Promise<MemoryEngineStorage> {
    return this.request('GET', '/v1/storage');
  }

  /**
   * Use another database (null: the engine's own on this PC) and mirror (null: none). Moving to
   * an empty database copies everything there first; the engine answers 503 until it is done.
   */
  setStorage(settings: { database: string | null; mirror: string | null }): Promise<MemoryEngineStorage> {
    return this.request('PUT', '/v1/storage', settings);
  }

  /** Can the engine use this database? Reasons are general, never the database's own message. */
  testStorage(url: string): Promise<{ ok: boolean; version?: string; error?: string }> {
    return this.request('POST', '/v1/storage/test', { url }, 15_000);
  }

  /** Tell the engine a turn started or ended, so its background work waits for quiet. */
  activity(busy: boolean): Promise<{ idle: boolean | null }> {
    return this.request('POST', '/v1/activity', { busy }, 1000);
  }

  /** One memory in full. `touch`: the agent is using it, so a fact is refreshed (not the panel). */
  memory(id: string, around = 1, options: { touch?: boolean; sessionId?: string | null } = {}): Promise<MemoryEngineMemoryDetail> {
    const params = new URLSearchParams({ around: String(around) });
    if (options.touch) {
      params.set('touch', 'true');
      if (options.sessionId) params.set('session_id', options.sessionId);
    }
    return this.request('GET', `/v1/memories/${encodeURIComponent(id)}?${params.toString()}`);
  }

  /** Replace a fact with new words, or retract it; the old one is kept, marked. */
  correctFact(body: MemoryEngineCorrection): Promise<MemoryEngineCorrectionResult> {
    return this.request('POST', '/v1/facts/correct', body);
  }

  /** The agent's note for its next conversation; replaces this conversation's earlier note. */
  putHandoff(sessionId: string, handoff: { text: string; agent?: string | null; model?: string | null }): Promise<{ id: string }> {
    return this.request('PUT', `/v1/sessions/${encodeURIComponent(sessionId)}/handoff`, handoff);
  }

  /** Remember a finished coding task. The engine updates it if the same task_id comes again. */
  postCodingTask(task: MemoryEngineCodingTask): Promise<{ task_id: string; indexed: boolean }> {
    return this.request('POST', '/v1/coding/tasks', task);
  }

  putFact(id: string, fact: MemoryEngineFact): Promise<{ id: string; created: boolean }> {
    return this.request('PUT', `/v1/facts/${encodeURIComponent(id)}`, fact);
  }

  brief(options: { sessionId?: string | null; agent?: string; timeoutMs?: number } = {}): Promise<MemoryEngineBrief> {
    const params = new URLSearchParams();
    if (options.sessionId) params.set('session_id', options.sessionId);
    if (options.agent) params.set('agent', options.agent);
    const query = params.toString();
    return this.request('GET', `/v1/brief${query ? `?${query}` : ''}`, undefined, options.timeoutMs);
  }

  recall(body: MemoryEngineRecallRequest, timeoutMs?: number): Promise<MemoryEngineRecall> {
    return this.request('POST', '/v1/recall', body, timeoutMs);
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
