/** Client for services/speech (contract in services/speech/API.md). */

export interface SpeechServiceHealth {
  ready: boolean;
  error: string | null;
  sttModel: string | null;
  voices: string[];
  defaultVoice: string | null;
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
        stt?: { model?: unknown };
        tts?: { voices?: unknown; default_voice?: unknown };
      };
      return {
        ready: body.ready === true,
        error: typeof body.error === 'string' ? body.error : null,
        sttModel: typeof body.stt?.model === 'string' ? body.stt.model : null,
        voices: Array.isArray(body.tts?.voices) ? body.tts.voices.filter((v): v is string => typeof v === 'string') : [],
        defaultVoice: typeof body.tts?.default_voice === 'string' ? body.tts.default_voice : null,
      };
    } catch {
      return null;
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

  /** Speak `text`; returns a 16-bit PCM WAV. */
  async synthesize(
    request: { text: string; voice?: string; speed?: number },
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
