/**
 * The model calls a pursuit makes. It reuses the avatar's own conversation client (a `ChatClient`, the same one
 * its LocalVoiceService talks with) and the same OpenAI-style tool calling, so the character sounds like itself.
 *
 * Two rules keep a live conversation from waiting behind a pursuit:
 * - Calls run one at a time across all pursuits (`LlmGate`, one by default), so a server with two slots
 *   (LOCAL_LLM_SLOTS) always has one left for a conversation turn.
 * - Every call takes the session's AbortSignal; when Kevin starts talking, the request is dropped at once.
 *
 * No Electron.
 */
import type { ChatMessage, LlmToolDefinition } from '../local-voice/local-llm-client.js';
import { ThinkFilter } from '../local-voice/local-voice-service.js';
import type { ChatClient } from '../local-voice/voice-engines.js';
import type { RegisteredTool, ToolExecutionResult } from '../tools/tool-registry.js';

/** Characters of one tool result the model sees (about 1,500 tokens). */
export const MAX_TOOL_RESULT_CHARS = 6000;
/** Tokens are the server's setting; this bounds a runaway reply in characters. */
const MAX_REPLY_CHARS = 4000;

/** At most `limit` model calls at once, across every session. Waiting stops when the signal aborts. */
export class LlmGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit = 1) {}

  /** Runs `work` when a place is free. Rejects with the abort reason if the signal fires first. */
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      // When the place is handed over, `active` already counts it.
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal.reason);
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}

/**
 * A reply as plain lines: avatar tags ({move:...}) removed, runs of spaces folded, line breaks kept (the answer
 * formats here are one labelled line each).
 */
export function tidyReply(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What a tool call returned, as the text the model reads. */
export function resultText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && Array.isArray((data as { content?: unknown }).content)) {
    const parts = (data as { content: unknown[] }).content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }
  return JSON.stringify(data ?? null);
}

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export interface ToolRound {
  name: string;
  arguments: string;
  /** What the tool returned, or why it failed. */
  text: string;
  ok: boolean;
}

export interface PursuitLlmOptions {
  chat: () => ChatClient;
  gate: LlmGate;
  /** The system message: the character's persona and the guidance for its own time. */
  system: () => string;
  execute: (toolId: string, params: unknown) => Promise<ToolExecutionResult>;
  /** Counts one tool call against the session's limit; false when the limit is used up. */
  allowToolCall: () => boolean;
  /** Told about every tool call once it has run (for the log): the name, the arguments, how long it took and how it went. */
  onToolCall?: (call: {
    name: string;
    arguments: string;
    durationMs: number;
    ok: boolean;
    resultLength: number;
    error?: string;
  }) => void;
}

export class PursuitLlm {
  constructor(private readonly options: PursuitLlmOptions) {}

  /** One model call with no tools: the reply text, thinking and avatar tags removed. */
  async ask(user: string, signal: AbortSignal): Promise<string> {
    const { text } = await this.round(
      [
        { role: 'system', content: this.options.system() },
        { role: 'user', content: user },
      ],
      [],
      signal,
    );
    return text;
  }

  /**
   * The character looks something up: it may call the tools for up to `rounds` model calls (the last offers no
   * tools). Returns what it said at the end and every tool result. `results` may be given to see the tool results
   * even when the call throws half way (a timeout): each result is pushed to it as it comes.
   */
  async useTools(
    user: string,
    tools: RegisteredTool[],
    rounds: number,
    signal: AbortSignal,
    results: ToolRound[] = [],
  ): Promise<{ text: string; results: ToolRound[] }> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.options.system() },
      { role: 'user', content: user },
    ];
    let text = '';
    for (let round = 1; round <= rounds; round += 1) {
      const offered = round < rounds ? tools : [];
      const reply = await this.round(messages, offered, signal);
      text = reply.text;
      if (reply.calls.length === 0) break;
      messages.push({
        role: 'assistant',
        content: reply.text,
        tool_calls: reply.calls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of reply.calls) {
        signal.throwIfAborted();
        const ran = await this.runTool(tools, call.name, call.arguments);
        results.push({ name: call.name, arguments: call.arguments, text: ran.text, ok: ran.ok });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: clip(ran.text, MAX_TOOL_RESULT_CHARS),
        });
      }
    }
    return { text, results };
  }

  private async runTool(
    tools: RegisteredTool[],
    name: string,
    rawArguments: string,
  ): Promise<{ text: string; ok: boolean }> {
    const tool = tools.find((candidate) => candidate.toolName === name);
    if (!tool)
      return { text: JSON.stringify({ error: `There is no tool called ${name}.` }), ok: false };
    if (!this.options.allowToolCall())
      return { text: JSON.stringify({ error: 'You have looked enough for now.' }), ok: false };
    let params: unknown;
    try {
      params = rawArguments.trim() ? (JSON.parse(rawArguments) as unknown) : {};
    } catch {
      return {
        text: JSON.stringify({ error: 'The tool arguments were not valid JSON.' }),
        ok: false,
      };
    }
    const startedAt = Date.now();
    let outcome: { text: string; ok: boolean; error?: string };
    try {
      const result = await this.options.execute(tool.id, params);
      outcome = result.success
        ? { text: resultText(result.data), ok: true }
        : {
            text: JSON.stringify({ error: result.error ?? 'The tool failed.' }),
            ok: false,
            error: result.error ?? 'The tool failed.',
          };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { text: JSON.stringify({ error: message }), ok: false, error: message };
    }
    try {
      this.options.onToolCall?.({
        name,
        arguments: rawArguments,
        durationMs: Date.now() - startedAt,
        ok: outcome.ok,
        resultLength: outcome.text.length,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    } catch {
      /* A logging listener must not break the call. */
    }
    return outcome;
  }

  /** One streamed model call under the gate. */
  private round(messages: ChatMessage[], tools: RegisteredTool[], signal: AbortSignal) {
    const definitions: LlmToolDefinition[] = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.toolName,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    return this.options.gate.run(signal, async () => {
      const thinking = new ThinkFilter();
      let calls: Array<{ id: string; name: string; arguments: string }> = [];
      for await (const part of this.options
        .chat()
        .streamChat(messages, { signal, tools: definitions })) {
        if (part.type === 'tool_calls') calls = part.calls;
        else thinking.push(part.text);
        if (thinking.visible.length > MAX_REPLY_CHARS) break;
      }
      return { text: tidyReply(thinking.visible), calls };
    });
  }
}
