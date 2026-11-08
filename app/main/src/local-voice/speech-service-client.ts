/** Client for services/speech (contract in services/speech/API.md). */

export interface SpeechServiceHealth {
  ready: boolean;
  error: string | null;
  sttModel: string | null;
  /** The separate STT server the service forwards to (engine "openai-compatible"), if any. */
  sttUrl: string | null;
  ttsModel: string | null;
  voices: string[];
  defaultVoice: string | null;
}

/** One model of a speech-service TTS engine (GET /v1/tts/engines). */
export interface SpeechTtsModel {
  id: string;
  label: string;
  installed: boolean;
  sizeMb?: number;
  voices: string[];
  defaultVoice: string | null;
  download: { status: 'downloading' | 'done' | 'error'; received: number; total: number; error: string | null } | null;
}

export interface SpeechTtsEngine {
  id: string;
  label: string;
  available: boolean;
  error: string | null;
  models: SpeechTtsModel[];
}

export interface SpeechServiceClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  healthTimeoutMs?: number;
}

export class SpeechServiceClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly healthTimeoutMs: number;

  constructor(options: SpeechServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  }

  /** The service's health, or null when it is not reachable. */
  async health(): Promise<SpeechServiceHealth | null> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        ready?: unknown;
        error?: unknown;
        stt?: { model?: unknown; url?: unknown };
        tts?: { engine?: unknown; voices?: unknown; default_voice?: unknown };
      };
      return {
        ready: body.ready === true,
        error: typeof body.error === 'string' ? body.error : null,
        sttModel: typeof body.stt?.model === 'string' ? body.stt.model : null,
        sttUrl: typeof body.stt?.url === 'string' ? body.stt.url.replace(/\/+$/, '') : null,
        ttsModel: typeof body.tts?.engine === 'string' ? body.tts.engine : null,
        voices: Array.isArray(body.tts?.voices) ? body.tts.voices.filter((v): v is string => typeof v === 'string') : [],
        defaultVoice: typeof body.tts?.default_voice === 'string' ? body.tts.default_voice : null,
      };
    } catch {
      return null;
    }
  }

  /** True when the STT server at `url` answers /models (llama-server returns 503 while loading). */
  async isSttServerUp(url: string): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${url}/models`, { signal: AbortSignal.timeout(this.healthTimeoutMs) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async transcribe(wav: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<{ text: string; timings: Record<string, number> }> {
    const response = await this.fetchFn(`${this.baseUrl}/v1/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Speech-to-text failed: HTTP ${response.status} ${await errorText(response)}`);
    }
    const body = (await response.json()) as { text?: unknown; timings?: unknown };
    const timings: Record<string, number> = {};
    if (body.timings && typeof body.timings === 'object') {
      for (const [key, value] of Object.entries(body.timings)) {
        if (typeof value === 'number') {
          timings[key] = value;
        }
      }
    }
    return { text: typeof body.text === 'string' ? body.text : '', timings };
  }

  /** The service's TTS engines and their models; null when it is down or too old to say. */
  async ttsEngines(): Promise<SpeechTtsEngine[] | null> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/v1/tts/engines`, { signal: AbortSignal.timeout(this.healthTimeoutMs) });
      if (!response.ok) return null;
      const body = (await response.json()) as { engines?: unknown };
      return Array.isArray(body.engines) ? body.engines.map(toEngine).filter((engine): engine is SpeechTtsEngine => engine !== null) : null;
    } catch {
      return null;
    }
  }

  /** Start downloading a Kitten model or Piper voice; progress shows in ttsEngines(). */
  async downloadTtsModel(engine: string, model: string): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/v1/tts/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine, model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? 'This speech service is too old to download models; restart it from an up-to-date checkout.'
          : `Download failed: ${await errorText(response)}`,
      );
    }
  }

  /** Speak `text`; returns a 16-bit PCM WAV. */
  async synthesize(
    request: { text: string; voice?: string; speed?: number; engine?: string; model?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    const response = await this.fetchFn(`${this.baseUrl}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Text-to-speech failed: HTTP ${response.status} ${await errorText(response)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') {
        return parsed.error;
      }
    } catch {
      // Not JSON; fall through to the raw text.
    }
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

function toEngine(value: unknown): SpeechTtsEngine | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string') return null;
  const models = Array.isArray(entry.models) ? entry.models : [];
  return {
    id: entry.id,
    label: typeof entry.label === 'string' ? entry.label : entry.id,
    available: entry.available === true,
    error: typeof entry.error === 'string' ? entry.error : null,
    models: models.flatMap((raw): SpeechTtsModel[] => {
      if (!raw || typeof raw !== 'object') return [];
      const model = raw as Record<string, unknown>;
      if (typeof model.id !== 'string') return [];
      const download = model.download && typeof model.download === 'object' ? (model.download as Record<string, unknown>) : null;
      return [
        {
          id: model.id,
          label: typeof model.label === 'string' ? model.label : model.id,
          installed: model.installed === true,
          ...(typeof model.size_mb === 'number' ? { sizeMb: model.size_mb } : {}),
          voices: Array.isArray(model.voices) ? model.voices.filter((voice): voice is string => typeof voice === 'string') : [],
          defaultVoice: typeof model.default_voice === 'string' ? model.default_voice : null,
          download:
            download && (download.status === 'downloading' || download.status === 'done' || download.status === 'error')
              ? {
                  status: download.status,
                  received: typeof download.received === 'number' ? download.received : 0,
                  total: typeof download.total === 'number' ? download.total : 0,
                  error: typeof download.error === 'string' ? download.error : null,
                }
              : null,
        },
      ];
    }),
  };
}
