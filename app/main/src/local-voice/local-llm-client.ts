/**
 * Streaming chat client for an OpenAI-compatible server: the local llama-server running Qwen
 * Flash-Next (the same server slopcore uses), or OpenAI itself. On llama-server, thinking is
 * switched off through the chat template, as slopcore does: with it on, Qwen spends seconds
 * reasoning before the first word.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

export interface LocalLlmClientOptions {
  baseUrl: string;
  model: string;
  /** Sent as a bearer token; set for OpenAI. */
  apiKey?: string;
  /**
   * 'openai' sends only parameters the OpenAI API accepts (it rejects llama-server's
   * chat_template_kwargs, and newer models reject max_tokens and a custom temperature).
   */
  flavor?: 'llama-server' | 'openai';
  fetchFn?: typeof fetch;
  temperature?: number;
  maxTokens?: number;
  healthTimeoutMs?: number;
}

export class LocalLlmClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly flavor: 'llama-server' | 'openai';
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly healthTimeoutMs: number;

  constructor(options: LocalLlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.flavor = options.flavor ?? 'llama-server';
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetchFn = options.fetchFn ?? fetch;
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 1024;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  }

  /** True when the server answers /models. For OpenAI, true when there is a key (no request per poll). */
  async isAvailable(): Promise<boolean> {
    if (this.flavor === 'openai') {
      return Boolean(this.apiKey);
    }
    try {
      const response = await this.fetchFn(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Yield the reply's text as it streams in. */
  async *streamChat(messages: ChatMessage[], options: { signal?: AbortSignal } = {}): AsyncGenerator<string> {
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(
        this.flavor === 'openai'
          ? { model: this.model, messages, stream: true, max_completion_tokens: this.maxTokens }
          : {
              model: this.model,
              messages,
              stream: true,
              temperature: this.temperature,
              max_tokens: this.maxTokens,
              chat_template_kwargs: { enable_thinking: false },
            },
      ),
      signal: options.signal,
    });
    const label = this.flavor === 'openai' ? 'OpenAI' : 'Local LLM';
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${label} request failed: HTTP ${response.status} ${body.slice(0, 200)}`);
    }
    if (!response.body) {
      throw new Error(`${label} returned an empty stream.`);
    }

    for await (const data of readServerSentEvents(response.body)) {
      if (data === '[DONE]') {
        return;
      }
      let chunk: { choices?: Array<{ delta?: { content?: unknown } }> };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue;
      }
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        yield content;
      }
    }
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }
}

async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.startsWith('data:')) {
          yield line.slice(5).trim();
        }
        newline = buffered.indexOf('\n');
      }
    }
    const rest = (buffered + decoder.decode()).trim();
    if (rest.startsWith('data:')) {
      yield rest.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}
