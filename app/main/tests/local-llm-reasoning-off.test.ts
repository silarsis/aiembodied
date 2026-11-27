import { describe, expect, it } from 'vitest';

import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { createChatCompletionsResponsesClient } from '../src/openai/chat-completions-responses.js';

/** A fetch that records each request body and answers both a stream and a plain completion. */
function recordingFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.stream) {
      const events = 'data: {"choices":[{"delta":{"content":"Hi."}}]}\n\ndata: [DONE]\n\n';
      return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({ choices: [{ message: { content: 'Hi.' } }] });
  };
  return { bodies, fetchFn };
}

async function streamedKwargs(model: string): Promise<unknown> {
  const { bodies, fetchFn } = recordingFetch();
  const client = new LocalLlmClient({ baseUrl: 'http://llm/v1', model, fetchFn });
  for await (const part of client.streamChat([{ role: 'user', content: 'Hello' }])) {
    void part;
  }
  return bodies[0]?.chat_template_kwargs;
}

async function helperKwargs(model: string): Promise<unknown> {
  const { bodies, fetchFn } = recordingFetch();
  const client = createChatCompletionsResponsesClient({ baseUrl: 'http://llm/v1', model, fetchFn });
  await client.responses.create({ input: 'Hello' });
  return bodies[0]?.chat_template_kwargs;
}

describe('local LLM requests switch reasoning off per model', () => {
  it('asks Inkling for reasoning_effort none, since its template ignores enable_thinking', async () => {
    const expected = { enable_thinking: false, reasoning_effort: 'none' };
    expect(await streamedKwargs('Inkling-2-Mini-UD-Q8_K_XL')).toEqual(expected);
    expect(await helperKwargs('inkling-2-mini-ud-q8_k_xl')).toEqual(expected);
  });

  it('sends other models only enable_thinking, so reasoning_effort keeps its own meaning there', async () => {
    for (const model of ['gemma-4-e4b-it-obliterated-q8_0', 'gpt-oss-20b', 'qwen']) {
      expect(await streamedKwargs(model)).toEqual({ enable_thinking: false });
      expect(await helperKwargs(model)).toEqual({ enable_thinking: false });
    }
  });
});
