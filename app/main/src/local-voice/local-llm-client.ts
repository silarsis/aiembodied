/**
 * Streaming chat client for a local OpenAI-compatible server (llama-server running Qwen
 * Flash-Next, the same server slopcore uses). Thinking is switched off through the chat
 * template, as slopcore does: with it on, Qwen spends seconds reasoning before the first word.
 * Tool calling needs llama-server's --jinja flag, which scripts/start-local-llm.ps1 passes.
 */

export interface LlmToolCall {
  id: string;
  name: string;
  /** JSON text, as the model wrote it. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

/** A function the model may call, in chat-completions form. */
export interface LlmToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/** Streamed reply text, then (when the model asks for tools) the calls it made. */
export type LlmStreamPart = { type: 'text'; text: string } | { type: 'tool_calls'; calls: LlmToolCall[] };

export interface LocalLlmClientOptions {
  baseUrl: string;
  model: string;
  fetchFn?: typeof fetch;
  temperature?: number;
  maxTokens?: number;
  healthTimeoutMs?: number;
}

export class LocalLlmClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly healthTimeoutMs: number;

  constructor(options: LocalLlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 1024;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  }

  /** True when the server answers /models. */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Yield the reply's text as it streams in, and finally any tool calls it asked for. */
  async *streamChat(
    messages: ChatMessage[],
    options: { signal?: AbortSignal; tools?: LlmToolDefinition[] } = {},
  ): AsyncGenerator<LlmStreamPart> {
    const tools = options.tools?.length ? { tools: options.tools } : {};
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        chat_template_kwargs: { enable_thinking: false },
        ...tools,
      }),
      signal: options.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Local LLM request failed: HTTP ${response.status} ${body.slice(0, 200)}`);
    }
    if (!response.body) {
      throw new Error('Local LLM returned an empty stream.');
    }

    // Tool calls stream in pieces keyed by index: the id and name first, the arguments after.
    const calls = new Map<number, LlmToolCall>();
    for await (const data of readServerSentEvents(response.body)) {
      if (data === '[DONE]') {
        break;
      }
      let chunk: { choices?: Array<{ delta?: { content?: unknown; tool_calls?: StreamedToolCall[] } }> };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      const content = delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        yield { type: 'text', text: content };
      }
      for (const piece of delta?.tool_calls ?? []) {
        const index = typeof piece.index === 'number' ? piece.index : calls.size;
        const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
        call.id ||= piece.id ?? '';
        call.name += piece.function?.name ?? '';
        call.arguments += piece.function?.arguments ?? '';
        calls.set(index, call);
      }
    }
    if (calls.size > 0) {
      yield {
        type: 'tool_calls',
        calls: [...calls.values()].filter((call) => call.name).map((call, i) => ({ ...call, id: call.id || `call_${i}` })),
      };
    }
  }
}

interface StreamedToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
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
