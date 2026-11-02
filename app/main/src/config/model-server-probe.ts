/**
 * Ask a model server whether it is up and which models it offers, for the Models and servers
 * pop-up. Every check is a cheap read: model lists, health endpoints, ComfyUI's queue. Brave is
 * never called (each search costs quota), so it only reports whether a key is set.
 */
import { SpeechServiceClient } from '../local-voice/speech-service-client.js';
import type { ModelServer } from './model-routing.js';

/** Which list of models a use reads from a server. */
export type ModelRole = 'chat' | 'transcribe' | 'voices' | 'realtime' | 'motion' | 'image' | 'mesh';

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

async function getJson(url: string, key: string | undefined, fetchFn: typeof fetch): Promise<unknown> {
  const response = await fetchFn(url, { headers: { Accept: 'application/json', ...auth(key) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
