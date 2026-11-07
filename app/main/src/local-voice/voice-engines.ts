/**
 * Build the conversation pipeline's engines from the model routing: each part (thinking, hearing,
 * speaking) uses the server picked for it, then its backups in order when that one fails.
 */
import { BUILT_IN_SERVER_IDS, routeTargets, type ModelRouting, type ModelServer } from '../config/model-routing.js';
import { LocalLlmClient, type ChatMessage, type LlmStreamPart, type LlmToolDefinition } from './local-llm-client.js';
import { OpenAiAudioClient } from './openai-audio-client.js';
import { OpenAiRealtimeTts, type RealtimeSocketFactory } from './openai-realtime-tts.js';
import { KokoroTts, OpenAiStt, SpeechServiceStt } from './speech-engines.js';
import type { SpeechToTextEngine, TextToSpeechEngine } from './speech-engines.js';
import { SpeechServiceClient, type SpeechServiceHealth } from './speech-service-client.js';
import type { LocalVoiceTranscribeResult } from './types.js';

/** What the pipeline needs from a chat server. */
export interface ChatClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly flavor: 'llama-server' | 'openai';
  isAvailable(): Promise<boolean>;
  streamChat(messages: ChatMessage[], options?: { signal?: AbortSignal; tools?: LlmToolDefinition[] }): AsyncGenerator<LlmStreamPart>;
}

export interface VoiceEngines {
  llm: ChatClient;
  speech: SpeechServiceClient;
  stt: SpeechToTextEngine;
  tts: TextToSpeechEngine;
}

export type ServerKeyLookup = (serverId: string) => string | undefined;

type Logger = Pick<Console, 'warn'>;

export const DEFAULT_OPENAI_MODELS = { llm: 'gpt-4.1-mini', stt: 'gpt-4o-mini-transcribe', tts: 'gpt-realtime-2.1-mini' };

export function buildVoiceEngines(
  routing: ModelRouting,
  keyFor: ServerKeyLookup,
  options: { fetchFn?: typeof fetch; createSocket?: RealtimeSocketFactory; logger?: Logger } = {},
): VoiceEngines {
  const { fetchFn, logger } = options;
  const speechClients = new Map<string, SpeechServiceClient>();
  const speechFor = (server: ModelServer) => {
    let client = speechClients.get(server.id);
    if (!client) {
      client = new SpeechServiceClient({ baseUrl: server.url, fetchFn });
      speechClients.set(server.id, client);
    }
    return client;
  };

  const chats = routeTargets(routing, 'llm').map(({ server, model }) =>
    new LocalLlmClient({
      baseUrl: server.url,
      model: model || (server.type === 'openai' ? DEFAULT_OPENAI_MODELS.llm : 'default'),
      apiKey: keyFor(server.id),
      flavor: server.type === 'openai' ? 'openai' : 'llama-server',
      fetchFn,
    }),
  );

  const stts = routeTargets(routing, 'stt').map(({ server, model }): SpeechToTextEngine =>
    server.type === 'speech'
      ? new SpeechServiceStt(speechFor(server))
      : new OpenAiStt(
          new OpenAiAudioClient({ apiKey: keyFor(server.id) ?? '', baseUrl: server.url, fetchFn }),
          model || DEFAULT_OPENAI_MODELS.stt,
        ),
  );

  const ttsRoute = routing.routes.tts;
  const ttses = routeTargets(routing, 'tts').map(({ server, model }): TextToSpeechEngine =>
    server.type === 'speech'
      ? new KokoroTts(speechFor(server), model)
      : new OpenAiRealtimeTts({
          apiKey: keyFor(server.id) ?? '',
          model: model || DEFAULT_OPENAI_MODELS.tts,
          voice: ttsRoute.voice || 'alloy',
          style: ttsRoute.style ?? '',
          createSocket: options.createSocket,
          logger,
        }),
  );

  // The status panel reports one speech service: the first one hearing or speaking uses.
  const speechServer =
    [...routeTargets(routing, 'stt'), ...routeTargets(routing, 'tts')].find(({ server }) => server.type === 'speech')?.server ??
    routing.servers.find((server) => server.id === BUILT_IN_SERVER_IDS.speech);
  const speech = speechServer ? speechFor(speechServer) : new SpeechServiceClient({ baseUrl: 'http://127.0.0.1:8192', fetchFn });

  return {
    llm: chats.length > 1 ? new FailoverChatClient(chats, logger) : chats[0] ?? missingChat(),
    speech,
    stt: stts.length > 1 ? new FailoverStt(stts, logger) : stts[0] ?? missingStt(),
    tts: ttses.length > 1 ? new FailoverTts(ttses, logger) : ttses[0] ?? missingTts(),
  };
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError');
}

/** Tries each chat server in turn. Once a reply has started streaming it is not retried elsewhere. */
export class FailoverChatClient implements ChatClient {
  private current: ChatClient;

  constructor(
    private readonly clients: ChatClient[],
    private readonly logger?: Logger,
  ) {
    this.current = clients[0];
  }

  get baseUrl(): string {
    return this.current.baseUrl;
  }

  get model(): string {
    return this.current.model;
  }

  get flavor(): 'llama-server' | 'openai' {
    return this.current.flavor;
  }

  async isAvailable(): Promise<boolean> {
    for (const client of this.clients) {
      if (await client.isAvailable()) {
        this.current = client;
        return true;
      }
    }
    return false;
  }

  async *streamChat(
    messages: ChatMessage[],
    options: { signal?: AbortSignal; tools?: LlmToolDefinition[] } = {},
  ): AsyncGenerator<LlmStreamPart> {
    let lastError: unknown;
    for (const client of this.clients) {
      let started = false;
      try {
        for await (const part of client.streamChat(messages, options)) {
          started = true;
          this.current = client;
          yield part;
        }
        return;
      } catch (error) {
        if (started || isAbort(error, options.signal)) throw error;
        lastError = error;
        this.logger?.warn('Chat server failed; trying the next one.', {
          server: client.baseUrl,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw lastError ?? new Error('No chat server is set up.');
  }
}

export class FailoverStt implements SpeechToTextEngine {
  constructor(
    private readonly engines: SpeechToTextEngine[],
    private readonly logger?: Logger,
  ) {}

  async transcribe(wav: Uint8Array, options?: { signal?: AbortSignal }): Promise<LocalVoiceTranscribeResult> {
    let lastError: unknown;
    for (const engine of this.engines) {
      try {
        return await engine.transcribe(wav, options);
      } catch (error) {
        if (isAbort(error, options?.signal)) throw error;
        lastError = error;
        this.logger?.warn('Speech-to-text failed; trying the next server.', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw lastError;
  }

  async status(speech: SpeechServiceHealth | null) {
    const first = await this.engines[0].status(speech);
    if (first.available) return first;
    for (const engine of this.engines.slice(1)) {
      const status = await engine.status(speech);
      if (status.available) return status;
    }
    return first;
  }
}

export class FailoverTts implements TextToSpeechEngine {
  constructor(
    private readonly engines: TextToSpeechEngine[],
    private readonly logger?: Logger,
  ) {}

  async synthesize(text: string, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
    let lastError: unknown;
    for (const engine of this.engines) {
      try {
        return await engine.synthesize(text, options);
      } catch (error) {
        if (isAbort(error, options?.signal)) throw error;
        lastError = error;
        this.logger?.warn('Text-to-speech failed; trying the next server.', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw lastError;
  }

  status(speech: SpeechServiceHealth | null) {
    return this.engines[0].status(speech);
  }

  close(): void {
    for (const engine of this.engines) engine.close?.();
  }
}

function missingChat(): ChatClient {
  return {
    baseUrl: '',
    model: '',
    flavor: 'llama-server',
    isAvailable: async () => false,
    // eslint-disable-next-line require-yield
    async *streamChat() {
      throw new Error('No server is set for Thinking. Choose one in Models and servers.');
    },
  };
}

function missingStt(): SpeechToTextEngine {
  return {
    transcribe: async () => {
      throw new Error('No server is set for Hearing. Choose one in Models and servers.');
    },
    status: async () => ({ provider: 'local', available: false, model: null, url: null }),
  };
}

function missingTts(): TextToSpeechEngine {
  return {
    synthesize: async () => {
      throw new Error('No server is set for Speaking. Choose one in Models and servers.');
    },
    status: () => ({ provider: 'kokoro', available: false, ready: false, model: null, voice: null, error: 'No server is set for Speaking.' }),
  };
}
