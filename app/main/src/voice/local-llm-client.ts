/**
 * Streaming chat client for an OpenAI-compatible server. The default target is llama-server
 * running Qwen Next Flash on port 1234, the same setup slopcore uses (its `qwen` provider):
 * thinking off and a presence penalty, because with thinking on Qwen spends thousands of
 * tokens before the first word, which is fatal for a spoken reply.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LocalLlmClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  temperature?: number;
  maxTokens?: number;
  /** Merged into the request body (llama-server reads chat_template_kwargs, presence_penalty, ...). */
  extraBody?: Record<string, unknown>;
  healthTimeoutMs?: number;
}

export const QWEN_EXTRA_BODY: Record<string, unknown> = {
  chat_template_kwargs: { enable_thinking: false },
  presence_penalty: 1.0,
};

export class LocalLlmClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly extraBody: Record<string, unknown>;
  private readonly healthTimeoutMs: number;

  constructor(options: LocalLlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey ?? 'local';
    this.fetchFn = options.fetchFn ?? fetch;
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 1024;
    this.extraBody = options.extraBody ?? QWEN_EXTRA_BODY;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  }

  /** Model ids the server lists, or null when it is not reachable. */
  async listModels(): Promise<string[] | null> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string');
    } catch {
      return null;
    }
  }

  /** Yields content deltas as the model produces them. */
  async *streamChat(messages: ChatMessage[], options: { signal?: AbortSignal } = {}): AsyncGenerator<string> {
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        ...this.extraBody,
        model: this.model,
        messages,
        stream: true,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      }),
      signal: options.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM request failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) {
            continue;
          }
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            return;
          }
          const delta = parseDelta(data);
          if (delta) {
            yield delta;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function parseDelta(data: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  const record = payload as { error?: { message?: unknown }; choices?: Array<{ delta?: { content?: unknown } }> };
  if (record.error) {
    throw new Error(`LLM stream error: ${String(record.error.message ?? 'unknown')}`);
  }
  const content = record.choices?.[0]?.delta?.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}
