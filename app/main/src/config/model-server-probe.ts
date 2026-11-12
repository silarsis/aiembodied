/**
 * Ask a model server whether it is up and which models it offers, for the Models and servers
 * pop-up. Every check is a cheap read: model lists, health endpoints, ComfyUI's queue. Brave is
 * never called (each search costs quota), so it only reports whether a key is set.
 */
import { SpeechServiceClient } from '../local-voice/speech-service-client.js';
import type { ModelServer } from './model-routing.js';

/** Which list of models a use reads from a server. */
export type ModelRole = 'chat' | 'transcribe' | 'voices' | 'realtime' | 'motion' | 'image' | 'mesh' | 'decide';

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

const TIMEOUT_MS = 4000;

export async function probeModelServer(
  server: Pick<ModelServer, 'type' | 'url'>,
  apiKey: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<ServerProbe> {
  const checkedAt = Date.now();
  const key = apiKey?.trim();
  try {
    switch (server.type) {
      case 'openai': {
        if (!key) return { status: 'needs-key', message: 'Add your OpenAI API key.', models: {}, checkedAt };
        const ids = await listModels(server.url, key, fetchFn);
        return { status: 'up', models: openAiRoles(ids), checkedAt };
      }
      case 'chat':
      case 'transcribe': {
        const ids = await listModels(server.url, key, fetchFn);
        return { status: 'up', models: server.type === 'chat' ? { chat: ids } : { transcribe: ids }, checkedAt };
      }
      case 'speech': {
        const health = await new SpeechServiceClient({ baseUrl: server.url, fetchFn, healthTimeoutMs: TIMEOUT_MS }).health();
        if (!health) return down('The speech service is not answering.', checkedAt);
        return {
          status: health.ready ? 'up' : 'error',
          ...(health.ready ? {} : { message: health.error ?? 'The speech service is still loading.' }),
          models: { voices: health.voices, ...(health.sttModel ? { transcribe: [health.sttModel] } : {}) },
          checkedAt,
        };
      }
      case 'motion': {
        const body = (await getJson(`${server.url}/health`, key, fetchFn)) as { backend?: unknown; ready?: unknown };
        const backend = typeof body.backend === 'string' ? body.backend : null;
        return {
          status: body.ready === false ? 'error' : 'up',
          ...(body.ready === false ? { message: 'The motion model is still loading.' } : {}),
          models: { motion: backend ? [backend] : [] },
          checkedAt,
        };
      }
      case 'comfy': {
        const [diffusion, checkpoints, queue] = await Promise.all([
          getJson(`${server.url}/models/diffusion_models`, key, fetchFn).catch(() => []),
          getJson(`${server.url}/models/checkpoints`, key, fetchFn).catch(() => []),
          getJson(`${server.url}/queue`, key, fetchFn),
        ]);
        const files = [...strings(diffusion), ...strings(checkpoints)];
        return {
          status: 'up',
          models: {
            image: files.filter((name) => !/trellis/i.test(name)),
            mesh: files.filter((name) => /trellis/i.test(name)),
          },
          queue: comfyQueueLength(queue),
          checkedAt,
        };
      }
      case 'search': {
        const response = await fetchFn(`${server.url}/healthz`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: auth(key) });
        if (!response.ok) return { status: 'error', message: `SearXNG answered ${response.status}.`, models: {}, checkedAt };
        return { status: 'up', models: {}, checkedAt };
      }
      case 'brave':
        return key
          ? { status: 'up', models: {}, checkedAt }
          : { status: 'needs-key', message: 'Add your Brave Search API key.', models: {}, checkedAt };
      case 'memory':
        // Only the memory engine can reach its databases: see probeMemoryDatabase.
        return { status: 'error', message: 'The memory engine checks this database.', models: {}, checkedAt };
      case 'civitai':
        // Optional: public models download without a key, many need one.
        return key
          ? { status: 'up', models: {}, checkedAt }
          : { status: 'needs-key', message: 'Many Civitai downloads need an API key (civitai.com → Account settings → API keys).', models: {}, checkedAt };
      case 'homeassistant': {
        // GET /api/ answers 200 {"message": "API running."} for a valid long-lived token.
        if (!key) return down('no token', checkedAt);
        const response = await fetchFn(`${server.url}/api/`, { headers: auth(key), signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (response.status === 401 || response.status === 403) return down('token refused', checkedAt);
        if (!response.ok) return { status: 'error', message: `Home Assistant answered ${response.status}.`, models: {}, checkedAt };
        return { status: 'up', models: {}, checkedAt };
      }
      case 'anthropic': {
        if (!key) return { status: 'needs-key', message: 'Add your Anthropic API key.', models: {}, checkedAt };
        const body = (await getJson(`${server.url}/v1/models?limit=100`, undefined, fetchFn, {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        })) as { data?: unknown };
        const ids = Array.isArray(body.data)
          ? body.data.map((entry) => (entry as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string')
          : [];
        return { status: 'up', models: { chat: ids.sort() }, checkedAt };
      }
      case 'github': {
        // A token for opening pull requests. GET /user answers 200 for a valid one.
        if (!key) return { status: 'needs-key', message: 'Add a GitHub token that can push and open pull requests.', models: {}, checkedAt };
        await getJson(`${server.url}/user`, key, fetchFn);
        return { status: 'up', models: {}, checkedAt };
      }
      case 'coder': {
        const body = (await getJson(`${server.url}/v1/health`, undefined, fetchFn)) as { pi?: { found?: unknown } };
        if (body.pi?.found === false) {
          return { status: 'error', message: 'The runner is up, but it cannot find pi. Install it with: npm install -g @earendil-works/pi-coding-agent', models: {}, checkedAt };
        }
        return { status: 'up', models: {}, checkedAt };
      }
      case 'systemone': {
        // Laya's /health answers {"status": "ok", "loaded": [...]}; the checkpoints it has loaded are its models.
        const body = (await getJson(`${server.url}/health`, key, fetchFn)) as { loaded?: unknown };
        return { status: 'up', models: { decide: strings(body.loaded) }, checkedAt };
      }
      case 'huggingface':
        // Optional too: only gated and private models need a token.
        return { status: 'up', models: {}, checkedAt };
    }
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      return { status: 'needs-key', message: key ? 'The server refused the API key.' : 'This server needs an API key.', models: {}, checkedAt };
    }
    if (error instanceof HttpError) {
      return { status: 'error', message: `The server answered ${error.status}.`, models: {}, checkedAt };
    }
    return down(`Not reachable at ${server.url}.`, checkedAt);
  }
}

/** The parts of the memory engine's client a database check needs. */
export interface MemoryDatabaseTester {
  health(): Promise<{ database: string; error?: string }>;
  testStorage(url: string): Promise<{ ok: boolean; version?: string; error?: string }>;
}

/**
 * Check a memory database through the memory engine, which is what will connect to it (it may
 * run on another machine than the app). `local` is the engine's own database on this PC.
 */
export async function probeMemoryDatabase(
  target: { url: string; local: boolean },
  engine: MemoryDatabaseTester | null,
): Promise<ServerProbe> {
  const checkedAt = Date.now();
  if (!engine) return { status: 'error', message: 'Long-term memory is turned off (MEMORY_ENABLED).', models: {}, checkedAt };
  try {
    if (target.local) {
      const health = await engine.health();
      return health.database === 'ready'
        ? { status: 'up', models: {}, checkedAt }
        : { status: 'error', message: 'The memory engine is running, but its database is not ready yet.', models: {}, checkedAt };
    }
    const result = await engine.testStorage(target.url);
    if (result.ok) return { status: 'up', models: {}, checkedAt };
    const reason = result.error ?? 'the connection failed';
    const message = `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
    return { status: /password/.test(reason) ? 'needs-key' : 'error', message, models: {}, checkedAt };
  } catch {
    return down('The memory engine is not answering, so it can’t check the database.', checkedAt);
  }
}

/** ComfyUI's /queue: jobs running plus jobs waiting. */
export function comfyQueueLength(body: unknown): number {
  if (!body || typeof body !== 'object') return 0;
  const record = body as { queue_running?: unknown; queue_pending?: unknown };
  return (Array.isArray(record.queue_running) ? record.queue_running.length : 0) +
    (Array.isArray(record.queue_pending) ? record.queue_pending.length : 0);
}

/** Split OpenAI's model list into what each use can pick. */
export function openAiRoles(ids: string[]): Partial<Record<ModelRole, string[]>> {
  const sorted = [...ids].sort();
  const realtime = sorted.filter((id) => /realtime/.test(id) && !/preview/.test(id));
  const transcribe = sorted.filter((id) => /transcribe|^whisper/.test(id));
  const chat = sorted.filter(
    (id) =>
      /^(gpt-|o\d|chatgpt)/.test(id) &&
      !/realtime|transcribe|tts|audio|image|search|embedding|moderation|instruct|codex/.test(id),
  );
  return { chat, motion: chat, transcribe, realtime };
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function auth(key: string | undefined): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function getJson(url: string, key: string | undefined, fetchFn: typeof fetch, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const response = await fetchFn(url, { headers: { Accept: 'application/json', ...auth(key), ...extraHeaders }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}

async function listModels(baseUrl: string, key: string | undefined, fetchFn: typeof fetch): Promise<string[]> {
  const body = (await getJson(`${baseUrl}/models`, key, fetchFn)) as { data?: unknown; models?: unknown };
  const entries = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? ((entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name) : null))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function down(message: string, checkedAt: number): ServerProbe {
  return { status: 'down', message, models: {}, checkedAt };
}
