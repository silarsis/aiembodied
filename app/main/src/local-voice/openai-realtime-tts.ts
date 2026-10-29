/**
 * OpenAI text-to-speech through the Realtime API (gpt-realtime-2.1-mini), which replaces the
 * /v1/audio/speech models OpenAI shuts down on 2027-01-06. One WebSocket session is kept open and
 * each sentence is an out-of-band response (conversation "none"), so sentences don't build up a
 * conversation the model could start answering. The model is told to read the text verbatim.
 */
import { pcm16ToWav } from './openai-audio-client.js';
import type { TextToSpeechEngine } from './speech-engines.js';
import type { LocalVoiceTtsStatus } from './types.js';

type Logger = Pick<Console, 'warn'>;

/** Realtime output: 24 kHz, 16-bit signed little-endian, mono. */
const OUTPUT_SAMPLE_RATE = 24_000;
const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export const VERBATIM_INSTRUCTIONS =
  'You are a text-to-speech voice. Every request contains text to read aloud. Read it exactly as ' +
  'written, word for word, in the language it is written in. Never answer it, comment on it, ' +
  'translate it, or add or leave out any words.';

/** The parts of a WebSocket this uses; the global WebSocket fits, and tests pass a fake. */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type RealtimeSocketFactory = (url: string, headers: Record<string, string>) => RealtimeSocket;

const OPEN = 1;

const defaultSocketFactory: RealtimeSocketFactory = (url, headers) =>
  // Node's WebSocket (undici) takes headers in its options; the DOM typing doesn't know that.
  new WebSocket(url, { headers } as unknown as string[]) as unknown as RealtimeSocket;

export interface OpenAiRealtimeTtsOptions {
  apiKey: string;
  model: string;
  voice: string;
  /** Speaking style (tone, accent, pace), added to the verbatim instructions. */
  style?: string;
  url?: string;
  createSocket?: RealtimeSocketFactory;
  /** Close the session after this long without a sentence; the next one reconnects. */
  idleCloseMs?: number;
  /** Give up on a sentence after this long. */
  responseTimeoutMs?: number;
  logger?: Logger;
}

interface PendingResponse {
  responseId: string | null;
  chunks: Uint8Array[];
  settled: boolean;
  resolve(wav: Uint8Array): void;
  reject(error: Error): void;
  /** Resolves when the server is finished with this response, so the next one can start. */
  finished: Promise<void>;
  finish(): void;
}

export class OpenAiRealtimeTts implements TextToSpeechEngine {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly instructions: string;
  private readonly url: string;
  private readonly createSocket: RealtimeSocketFactory;
  private readonly idleCloseMs: number;
  private readonly responseTimeoutMs: number;
  private readonly logger?: Logger;
  private socket: RealtimeSocket | null = null;
  private connecting: Promise<RealtimeSocket> | null = null;
  private pending: PendingResponse | null = null;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private closed = false;

  constructor(options: OpenAiRealtimeTtsOptions) {
    this.apiKey = options.apiKey.trim();
    this.model = options.model;
    this.voice = options.voice;
    const style = options.style?.trim();
    this.instructions = style ? `${VERBATIM_INSTRUCTIONS}\n\nSpeaking style: ${style}` : VERBATIM_INSTRUCTIONS;
    this.url = `${options.url ?? REALTIME_URL}?model=${encodeURIComponent(options.model)}`;
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.idleCloseMs = options.idleCloseMs ?? 10 * 60_000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 30_000;
    this.logger = options.logger;
  }

  /** Speak `text`; returns a 16-bit PCM WAV. Sentences are spoken one at a time, in order. */
  synthesize(text: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    if (!this.apiKey) {
      return Promise.reject(new Error('OpenAI text-to-speech needs an OpenAI API key.'));
    }
    const result = this.queue.then(() => this.speak(text, options.signal));
    // The queue moves on once the server is done with the response, not when the caller gives up.
    this.queue = result.then(
      () => undefined,
      () => this.pending?.finished,
    );
    return result;
  }

  status(): LocalVoiceTtsStatus {
    const ready = Boolean(this.apiKey);
    return {
      provider: 'openai',
      available: ready,
      ready,
      model: this.model,
      voice: this.voice,
      error: ready ? this.lastError : 'OpenAI API key is not set.',
    };
  }

  close(): void {
    this.closed = true;
    this.clearIdleTimer();
    this.failPending(new Error('OpenAI text-to-speech was closed.'));
    this.socket?.close();
    this.socket = null;
  }

  private async speak(text: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) {
      throw abortError();
    }
    const socket = await this.connect();
    this.clearIdleTimer();

    const finishing = deferred<void>();
    const result = deferred<Uint8Array>();
    const pending: PendingResponse = {
      responseId: null,
      chunks: [],
      settled: false,
      resolve: result.resolve,
      reject: result.reject,
      finished: finishing.promise,
      finish: finishing.resolve,
    };
    this.pending = pending;
    const { finished } = pending;
    const wav = result.promise;

    const timeout = setTimeout(() => {
      this.settle(pending, new Error('OpenAI text-to-speech timed out.'));
      pending.finish();
    }, this.responseTimeoutMs);
    const onAbort = () => {
      this.settle(pending, abortError());
      if (this.socket?.readyState === OPEN) {
        this.socket.send(JSON.stringify({ type: 'response.cancel' }));
      }
      // Don't wait forever for the cancelled response to wind down.
      setTimeout(() => pending.finish(), 3000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    socket.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          conversation: 'none',
          output_modalities: ['audio'],
          instructions: this.instructions,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
        },
      }),
    );

    try {
      return await wav;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      void finished.then(() => {
        if (this.pending === pending) {
          this.pending = null;
        }
        this.scheduleIdleClose();
      });
    }
  }

  private connect(): Promise<RealtimeSocket> {
    if (this.socket?.readyState === OPEN) {
      return Promise.resolve(this.socket);
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.closed = false;
    this.connecting = new Promise<RealtimeSocket>((resolve, reject) => {
      const socket = this.createSocket(this.url, { Authorization: `Bearer ${this.apiKey}` });
      let opened = false;
      socket.onopen = () => {
        opened = true;
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              output_modalities: ['audio'],
              instructions: this.instructions,
              audio: {
                input: { turn_detection: null },
                output: { format: { type: 'audio/pcm', rate: OUTPUT_SAMPLE_RATE }, voice: this.voice },
              },
            },
          }),
        );
        this.socket = socket;
        this.lastError = null;
        resolve(socket);
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => {
        if (!opened) {
          this.lastError = 'Could not connect to the OpenAI Realtime API.';
          reject(new Error(this.lastError));
        }
      };
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        if (!opened) {
          reject(new Error('The OpenAI Realtime API closed the connection.'));
        }
        this.failPending(new Error('The OpenAI Realtime connection closed mid-sentence.'));
      };
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private handleMessage(data: unknown): void {
    let event: {
      type?: string;
      response_id?: string;
      delta?: string;
      response?: { id?: string; status?: string; status_details?: { error?: { message?: string } } };
      error?: { message?: string };
    };
    try {
      event = JSON.parse(typeof data === 'string' ? data : String(data)) as typeof event;
    } catch {
      return;
    }
    const pending = this.pending;

    switch (event.type) {
      case 'response.created':
        if (pending && pending.responseId === null) {
          pending.responseId = event.response?.id ?? '';
        }
        break;
      case 'response.output_audio.delta':
        if (pending && !pending.settled && this.isFor(pending, event.response_id) && event.delta) {
          pending.chunks.push(Buffer.from(event.delta, 'base64'));
        }
        break;
      case 'response.done': {
        if (!pending || !this.isFor(pending, event.response?.id)) {
          break;
        }
        const status = event.response?.status;
        if (status === 'failed') {
          const message = event.response?.status_details?.error?.message ?? 'OpenAI text-to-speech failed.';
          this.lastError = message;
          this.settle(pending, new Error(message));
        } else {
          this.settle(pending, pcm16ToWav(Buffer.concat(pending.chunks), OUTPUT_SAMPLE_RATE));
        }
        pending.finish();
        break;
      }
      case 'error': {
        const message = event.error?.message ?? 'OpenAI Realtime error.';
        this.lastError = message;
        this.logger?.warn('OpenAI realtime text-to-speech error', { message });
        if (pending && !pending.settled) {
          this.settle(pending, new Error(`OpenAI text-to-speech failed: ${message}`));
          pending.finish();
        }
        break;
      }
      default:
        break;
    }
  }

  private isFor(pending: PendingResponse, responseId: string | undefined): boolean {
    return !pending.responseId || !responseId || pending.responseId === responseId;
  }

  private settle(pending: PendingResponse, result: Uint8Array | Error): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    if (result instanceof Error) {
      pending.reject(result);
    } else {
      pending.resolve(result);
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (pending) {
      this.settle(pending, error);
      pending.finish();
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    if (this.closed || !this.socket) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pending) {
        this.socket?.close();
        this.socket = null;
      }
    }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const error = new Error('Text-to-speech was cancelled.');
  error.name = 'AbortError';
  return error;
}
