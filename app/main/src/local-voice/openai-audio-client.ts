/**
 * OpenAI speech-to-text (/v1/audio/transcriptions) and text-to-speech (/v1/audio/speech), the
 * optional cloud stand-ins for services/speech. Both need the OpenAI API key.
 */
import { OPENAI_API_BASE_URL } from './local-llm-client.js';

/** OpenAI's raw `pcm` output: 24 kHz, 16-bit signed little-endian, mono. */
const OPENAI_PCM_SAMPLE_RATE = 24_000;

export interface OpenAiAudioClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class OpenAiAudioClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAiAudioClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? OPENAI_API_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
  }

  get hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  async transcribe(
    wav: Uint8Array,
    request: { model: string; language?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ text: string; timings: Record<string, number> }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', request.model);
    form.append('response_format', 'json');
    if (request.language) {
      form.append('language', request.language);
    }

    const startedAt = performance.now();
    const response = await this.fetchFn(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenAI speech-to-text failed: HTTP ${response.status} ${await errorText(response)}`);
    }
    const body = (await response.json()) as { text?: unknown };
    return {
      text: typeof body.text === 'string' ? body.text : '',
      timings: { total: (performance.now() - startedAt) / 1000 },
    };
  }

  /** Speak `text`; returns a 16-bit PCM WAV, the same format services/speech returns. */
  async synthesize(
    request: { text: string; model: string; voice: string; instructions?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    // Only gpt-4o-mini-tts takes a style prompt; tts-1 and tts-1-hd reject it.
    const instructions = request.model.startsWith('tts-1') ? undefined : request.instructions?.trim() || undefined;
    const response = await this.fetchFn(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        model: request.model,
        voice: request.voice,
        input: request.text,
        // Raw PCM rather than wav: a streamed wav carries placeholder sizes in its header.
        response_format: 'pcm',
        ...(instructions ? { instructions } : {}),
      }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenAI text-to-speech failed: HTTP ${response.status} ${await errorText(response)}`);
    }
    return pcm16ToWav(new Uint8Array(await response.arrayBuffer()), OPENAI_PCM_SAMPLE_RATE);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}

/** Wrap mono 16-bit little-endian PCM in a WAV header. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  // An odd trailing byte is half a sample; drop it.
  const dataLength = pcm.byteLength - (pcm.byteLength % 2);
  const wav = new Uint8Array(44 + dataLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      wav[offset + i] = value.charCodeAt(i);
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataLength, true);
  wav.set(pcm.subarray(0, dataLength), 44);
  return wav;
}

async function errorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | unknown };
      const message = typeof parsed.error === 'object' && parsed.error ? (parsed.error as { message?: unknown }).message : parsed.error;
      if (typeof message === 'string') {
        return message;
      }
    } catch {
      // Not JSON; fall through to the raw text.
    }
    return text.slice(0, 200);
  } catch {
    return '';
  }
}
