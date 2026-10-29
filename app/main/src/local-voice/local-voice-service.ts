/**
 * The local conversation backend: speech-to-text and text-to-speech through services/speech,
 * replies from a local LLM. Replies stream sentence by sentence: each sentence is spoken as soon
 * as the LLM finishes it, so the first words play while the rest is still being written.
 */
import type { ChatMessage, LlmToolCall, LlmToolDefinition, LocalLlmClient } from './local-llm-client.js';
import type { RegisteredTool, ToolRegistry } from '../tools/tool-registry.js';
import type { SpeechServiceClient } from './speech-service-client.js';
import type {
  LocalVoiceEvent,
  LocalVoiceRespondRequest,
  LocalVoiceRespondResult,
  LocalVoiceStatus,
  LocalVoiceTranscribeResult,
} from './types.js';

type Logger = Pick<Console, 'info' | 'warn' | 'error' | 'debug'>;

export const SPOKEN_REPLY_GUIDANCE =
  'You are talking out loud: everything you write is spoken by a text-to-speech voice. ' +
  'Answer in one to three short sentences unless asked for more. Use plain spoken English, ' +
  'with no markdown, lists, headings, emoji or URLs.';

export const TOOL_GUIDANCE =
  'You can call tools. Use one when it would give a better answer than memory, such as web_search ' +
  'for anything current. Then answer from its results in your own words, without reading out links. ' +
  'If a tool returns an error, say briefly that you could not look it up, rather than guessing.';

/** Model rounds per turn; the last one is offered no tools, so it has to answer. */
const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULT_CHARS = 4000;
const DEFAULT_SPOKEN_NOTICE = 'One moment.';

export interface LocalVoiceServiceOptions {
  llm: LocalLlmClient;
  speech: SpeechServiceClient;
  /** Tools offered to the model (built-ins such as web_search, and MCP tools). */
  tools?: Pick<ToolRegistry, 'list' | 'execute'>;
  /** Kokoro voice; the speech service's default when unset. */
  voice?: string;
  logger?: Logger;
  /** Older turns are dropped past this many messages. */
  maxHistoryMessages?: number;
  /** After this long without a turn, the next one starts a fresh conversation. */
  historyIdleResetMs?: number;
  now?: () => number;
}

export class LocalVoiceService {
  private readonly llm: LocalLlmClient;
  private readonly speech: SpeechServiceClient;
  private readonly tools?: Pick<ToolRegistry, 'list' | 'execute'>;
  private readonly voice?: string;
  private readonly logger?: Logger;
  private readonly maxHistoryMessages: number;
  private readonly historyIdleResetMs: number;
  private readonly now: () => number;
  private history: ChatMessage[] = [];
  private lastTurnAt = 0;
  private active: { requestId: string; controller: AbortController } | null = null;

  constructor(options: LocalVoiceServiceOptions) {
    this.llm = options.llm;
    this.speech = options.speech;
    this.tools = options.tools;
    this.voice = options.voice;
    this.logger = options.logger;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 24;
    this.historyIdleResetMs = options.historyIdleResetMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<LocalVoiceStatus> {
    const [llmAvailable, speech] = await Promise.all([this.llm.isAvailable(), this.speech.health()]);
    // The speech service reports ready even when its separate STT server is down, so ask that too.
    const sttUrl = speech?.sttUrl ?? null;
    const sttAvailable = sttUrl ? await this.speech.isSttServerUp(sttUrl) : speech?.ready === true;
    return {
      llm: { available: llmAvailable, model: this.llm.model, baseUrl: this.llm.baseUrl },
      stt: { available: sttAvailable, model: speech?.sttModel ?? null, url: sttUrl },
      speech: {
        available: Boolean(speech),
        ready: speech?.ready === true,
        sttModel: speech?.sttModel ?? null,
        ttsModel: speech?.ttsModel ?? null,
        voices: speech?.voices ?? [],
        defaultVoice: speech?.defaultVoice ?? null,
        error: speech?.error ?? null,
      },
    };
  }

  transcribe(wav: Uint8Array): Promise<LocalVoiceTranscribeResult> {
    return this.speech.transcribe(wav);
  }

  /** Stop the reply in progress (or only `requestId`'s, when given). */
  cancel(requestId?: string): void {
    if (this.active && (!requestId || this.active.requestId === requestId)) {
      this.active.controller.abort();
      this.active = null;
    }
  }

  resetHistory(): void {
    this.history = [];
  }

  async respond(
    request: LocalVoiceRespondRequest,
    emit: (event: LocalVoiceEvent) => void,
  ): Promise<LocalVoiceRespondResult> {
    const { requestId } = request;
    this.cancel();
    const controller = new AbortController();
    this.active = { requestId, controller };
    const { signal } = controller;

    if (this.now() - this.lastTurnAt > this.historyIdleResetMs) {
      this.history = [];
    }

    const tools = this.tools?.list() ?? [];
    const system = [request.instructions?.trim(), SPOKEN_REPLY_GUIDANCE, tools.length ? TOOL_GUIDANCE : null]
      .filter(Boolean)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...this.history,
      { role: 'user', content: request.text },
    ];

    const splitter = new SentenceSplitter();
    let index = 0;
    let speaking = Promise.resolve();
    const startedAt = this.now();
    let firstSentenceAt: number | null = null;
    let reply = '';

    const speak = (sentence: string) => {
      const sentenceIndex = index++;
      const spoken = toSpeakableText(sentence);
      firstSentenceAt ??= this.now();
      speaking = speaking.then(async () => {
        if (signal.aborted) {
          return;
        }
        try {
          const wav = spoken ? await this.speech.synthesize({ text: spoken, voice: this.voice }, { signal }) : new Uint8Array(0);
          if (!signal.aborted) {
            emit({ requestId, type: 'sentence', index: sentenceIndex, text: sentence, wav });
          }
        } catch (error) {
          if (!signal.aborted) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.warn('Local voice: text-to-speech failed for a sentence', { message, sentence: spoken });
            emit({ requestId, type: 'error', message });
          }
        }
      });
    };

    let cancelled = false;
    try {
      for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
        const offered = round < MAX_TOOL_ROUNDS ? tools : [];
        const thinking = new ThinkFilter();
        let calls: LlmToolCall[] = [];
        for await (const part of this.llm.streamChat(messages, { signal, tools: toToolDefinitions(offered) })) {
          if (part.type === 'tool_calls') {
            calls = part.calls;
          } else {
            for (const sentence of splitter.push(thinking.push(part.text))) {
              speak(sentence);
            }
          }
        }
        const rest = splitter.flush();
        if (rest) {
          speak(rest);
        }
        const text = thinking.visible.trim();
        reply = [reply, text].filter(Boolean).join(' ');
        if (calls.length === 0) {
          break;
        }

        // Say something while the tools run, unless the model already did.
        if (!text) {
          const notice = calls.map((call) => findTool(offered, call.name)?.spokenNotice).find(Boolean);
          speak(notice ?? DEFAULT_SPOKEN_NOTICE);
        }
        messages.push({
          role: 'assistant',
          content: text,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });
        for (const call of calls) {
          const content = await this.runTool(requestId, findTool(offered, call.name), call, emit);
          signal.throwIfAborted();
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }
      await speaking;
    } catch (error) {
      if (signal.aborted) {
        cancelled = true;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error('Local voice: reply failed', { message });
        emit({ requestId, type: 'error', message });
        throw error;
      }
    } finally {
      if (this.active?.requestId === requestId) {
        this.active = null;
      }
    }
    cancelled ||= signal.aborted;

    // Tool exchanges stay out of the history: trimming it could split a call from its result.
    this.history.push({ role: 'user', content: request.text });
    if (reply) {
      this.history.push({ role: 'assistant', content: reply });
    }
    this.history = this.history.slice(-this.maxHistoryMessages);
    this.lastTurnAt = this.now();

    this.logger?.info('Local voice: reply finished', {
      requestId,
      cancelled,
      sentences: index,
      firstSentenceMs: firstSentenceAt === null ? null : firstSentenceAt - startedAt,
      totalMs: this.now() - startedAt,
    });
    return { requestId, text: reply, cancelled };
  }

  /** Run one tool call and return what the model sees as its result. */
  private async runTool(
    requestId: string,
    tool: RegisteredTool | undefined,
    call: LlmToolCall,
    emit: (event: LocalVoiceEvent) => void,
  ): Promise<string> {
    let params: unknown;
    try {
      params = call.arguments.trim() ? (JSON.parse(call.arguments) as unknown) : {};
    } catch {
      params = undefined;
    }
    const label = (params !== undefined && tool?.describeCall?.(params)) || call.arguments.slice(0, 80);
    const event = { requestId, type: 'tool' as const, callId: call.id, name: call.name, label };
    emit({ ...event, status: 'started' });

    let failure: string | null = null;
    let content = '';
    if (!tool || !this.tools) {
      failure = `There is no tool called ${call.name}.`;
    } else if (params === undefined) {
      failure = 'The tool arguments were not valid JSON.';
    } else {
      const result = await this.tools.execute(tool.id, params);
      if (result.success) {
        content = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? null);
        this.logger?.info('Local voice: tool call finished', { name: call.name, label, durationMs: result.durationMs });
        emit({ ...event, status: 'done', detail: `${result.durationMs} ms` });
      } else {
        failure = result.error ?? 'The tool failed.';
      }
    }
    if (failure !== null) {
      this.logger?.warn('Local voice: tool call failed', { name: call.name, label, message: failure });
      emit({ ...event, status: 'failed', detail: failure });
      return JSON.stringify({ error: failure });
    }
    return content.length > MAX_TOOL_RESULT_CHARS ? `${content.slice(0, MAX_TOOL_RESULT_CHARS)}…` : content;
  }
}

function toToolDefinitions(tools: RegisteredTool[]): LlmToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.toolName, description: tool.description, parameters: tool.inputSchema },
  }));
}

function findTool(tools: RegisteredTool[], name: string): RegisteredTool | undefined {
  return tools.find((tool) => tool.toolName === name);
}

/**
 * Removes <think>…</think> blocks from a streamed reply (Qwen can emit an empty one even with
 * thinking off), holding back a partial "<think" tag until it is clear what it is.
 */
export class ThinkFilter {
  private raw = '';
  private emitted = 0;
  visible = '';

  push(delta: string): string {
    this.raw += delta;
    let visible = this.raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
    const partial = /<\/?t?h?i?n?k?$/.exec(visible);
    if (partial && '<think>'.startsWith(partial[0])) {
      visible = visible.slice(0, partial.index);
    }
    const next = visible.slice(this.emitted);
    this.emitted = visible.length;
    this.visible = visible;
    return next;
  }
}

const MIN_SENTENCE_CHARS = 12;
const MAX_CLAUSE_CHARS = 220;

/**
 * Splits streamed text into sentences for text-to-speech. Never splits inside an avatar tag
 * ({anim:…}, {move:…}); a tag travels with the sentence it is in, so the renderer can play it as
 * that sentence starts. Very long sentences are cut at a comma so speech does not stall.
 */
export class SentenceSplitter {
  private buffer = '';

  push(text: string): string[] {
    this.buffer += text;
    const sentences: string[] = [];
    for (;;) {
      const cut = findCut(this.buffer);
      if (cut < 0) {
        break;
      }
      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) {
        sentences.push(sentence);
      }
    }
    return sentences;
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest || null;
  }
}

function findCut(text: string): number {
  let depth = 0;
  let lastComma = -1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (char === '\n' && text.slice(0, i).trim().length > 0) {
        return i + 1;
      }
      const next = text[i + 1];
      if ('.!?…'.includes(char) && next !== undefined && /\s/.test(next) && i + 1 >= MIN_SENTENCE_CHARS) {
        return i + 1;
      }
      if ((char === ',' || char === ';' || char === ':') && next !== undefined && /\s/.test(next)) {
        lastComma = i + 1;
      }
    }
  }
  if (text.length > MAX_CLAUSE_CHARS && lastComma >= MIN_SENTENCE_CHARS && depth === 0) {
    return lastComma;
  }
  return -1;
}

/** The words to speak: avatar tags and markdown removed. Empty when nothing is left to say. */
export function toSpeakableText(text: string): string {
  const spoken = text
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/<\/?think>/g, ' ')
    .replace(/[*_#`>~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(spoken) ? spoken : '';
}
