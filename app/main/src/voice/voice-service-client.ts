/** Client for services/voice (faster-whisper speech-to-text, Kokoro text-to-speech); see its API.md. */

export interface VoiceServiceClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  healthTimeoutMs?: number;
}

export interface VoiceServiceHealth {
  status: string;
  ready: boolean;
  stt: string | null;
  tts: string | null;
}

export interface Transcription {
  text: string;
  sttMs?: number;
}

export interface SpeechAudio {
  /** 16-bit little-endian mono PCM. */
  pcm: Uint8Array;
  sampleRate: number;
}

export class VoiceServiceClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly healthTimeoutMs: number;

  constructor(options: VoiceServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  }

  /** The service's health, or null when it is not reachable. */
  async health(): Promise<VoiceServiceHealth | null> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        status?: unknown;
        ready?: unknown;
        stt?: { device?: unknown };
        tts?: { device?: unknown };
      };
      return {
        status: typeof body.status === 'string' ? body.status : 'unknown',
        ready: body.ready === true,
        stt: typeof body.stt?.device === 'string' ? body.stt.device : null,
        tts: typeof body.tts?.device === 'string' ? body.tts.device : null,
      };
    } catch {
      return null;
    }
  }

  async transcribe(pcm16k: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<Transcription> {
    const response = await this.fetchFn(`${this.baseUrl}/v1/stt?sample_rate=16000`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(pcm16k) as Uint8Array<ArrayBuffer>,
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Speech-to-text failed: ${await describeError(response)}`);
    }
    const body = (await response.json()) as { text?: unknown; timings?: { sttMs?: unknown } };
    return {
      text: typeof body.text === 'string' ? body.text.trim() : '',
      sttMs: typeof body.timings?.sttMs === 'number' ? body.timings.sttMs : undefined,
    };
  }

  async synthesize(text: string, options: { voice?: string; signal?: AbortSignal } = {}): Promise<SpeechAudio> {
    const response = await this.fetchFn(`${this.baseUrl}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(options.voice ? { voice: options.voice } : {}) }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Text-to-speech failed: ${await describeError(response)}`);
    }
    const sampleRate = Number(response.headers.get('x-sample-rate'));
    return {
      pcm: new Uint8Array(await response.arrayBuffer()),
      sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000,
    };
  }
}

async function describeError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') {
      return `HTTP ${response.status} ${body.error}`;
    }
  } catch {
    // fall through
  }
  return `HTTP ${response.status}`;
}
