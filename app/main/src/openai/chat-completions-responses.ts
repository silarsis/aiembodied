/**
 * A stand-in for the OpenAI SDK's `responses.create` that talks to an OpenAI-compatible
 * /chat/completions server instead (llama-server, LM Studio, vLLM, Ollama). The helper jobs
 * (animation clips, poses, pose checks, avatar description) were written for the Responses API,
 * which most self-hosted servers don't offer; this lets them run on any chat server.
 *
 * Only what the helpers use is translated: message input with text and image parts, and
 * text.format json_schema. The reply comes back as `output_text`, like the SDK's.
 */

type InputPart = { type?: string; text?: string; image_url?: string };
type InputMessage = { role?: string; content?: string | InputPart[] };

interface ResponsesParams {
  model?: string;
  instructions?: string;
  input?: string | InputMessage[];
  text?: { format?: { type?: string; name?: string; schema?: unknown; strict?: boolean } };
}

export interface ChatResponsesClient {
  responses: { create(params: unknown): Promise<{ output_text: string }> };
}

export function createChatCompletionsResponsesClient(options: {
  baseUrl: string;
  apiKey?: string;
  /** Model to send when a request names none. */
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): ChatResponsesClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  return {
    responses: {
      async create(raw: unknown) {
        const params = (raw ?? {}) as ResponsesParams;
        const body: Record<string, unknown> = {
          model: options.model || params.model || 'default',
          messages: toChatMessages(params),
          stream: false,
          // llama-server's Qwen template: answer directly instead of thinking first.
          chat_template_kwargs: { enable_thinking: false },
        };
        const format = params.text?.format;
        if (format?.type === 'json_schema') {
          body.response_format = {
            type: 'json_schema',
            json_schema: { name: format.name ?? 'output', schema: format.schema, strict: format.strict ?? true },
          };
        } else if (format?.type === 'json_object') {
          body.response_format = { type: 'json_object' };
        }
        const response = await fetchFn(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 300);
          throw new Error(`The chat server at ${baseUrl} answered ${response.status}${detail ? `: ${detail}` : '.'}`);
        }
        const json = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = json.choices?.[0]?.message?.content;
        return { output_text: typeof content === 'string' ? stripThinking(content) : '' };
      },
    },
  };
}

/** Responses-style input as chat messages: input_text becomes text, input_image an image_url part. */
export function toChatMessages(params: ResponsesParams): Array<{ role: string; content: unknown }> {
  const messages: Array<{ role: string; content: unknown }> = [];
  if (params.instructions) messages.push({ role: 'system', content: params.instructions });
  if (typeof params.input === 'string') {
    messages.push({ role: 'user', content: params.input });
    return messages;
  }
  for (const message of params.input ?? []) {
    const role = message.role === 'developer' ? 'system' : message.role ?? 'user';
    if (typeof message.content === 'string') {
      messages.push({ role, content: message.content });
      continue;
    }
    const parts = (message.content ?? []).map((part) =>
      part.type === 'input_image' || part.image_url
        ? { type: 'image_url', image_url: { url: part.image_url } }
        : { type: 'text', text: part.text ?? '' },
    );
    // A text-only message goes as a plain string: some servers reject part lists for system messages.
    messages.push({
      role,
      content: parts.every((part) => part.type === 'text') ? parts.map((part) => (part as { text: string }).text).join('\n') : parts,
    });
  }
  return messages;
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
