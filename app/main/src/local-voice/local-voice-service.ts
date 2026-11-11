/**
 * The conversation pipeline: speech-to-text, a language model, then text-to-speech. Each part is
 * local (services/speech, llama-server) or OpenAI, as chosen on the Settings page. Replies stream
 * sentence by sentence: each sentence is spoken as soon as the LLM finishes it, so the first words
 * play while the rest is still being written.
 */
import type { ChatMessage, LlmToolCall, LlmToolDefinition } from './local-llm-client.js';
import type { ChatClient } from './voice-engines.js';
import type { RegisteredTool, ToolRegistry } from '../tools/tool-registry.js';
import { describeOutcome, type ApprovalBroker } from '../tools/approvals.js';
import type { VoiceMemory } from '../memory-engine/voice-memory.js';
import type { SpeechServiceClient } from './speech-service-client.js';
import {
  KokoroTts,
  SpeechServiceStt,
  type SpeechToTextEngine,
  type TextToSpeechEngine,
} from './speech-engines.js';
import type {
  LocalVoiceEvent,
  LocalVoiceRespondRequest,
  LocalVoiceRespondResult,
  LocalVoiceStatus,
  LocalVoiceSystemStatus,
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
/** Updates that arrive within this long of each other become one system turn. */
export const SYSTEM_COALESCE_MS = 5000;
/** At most one system turn per this long, unless an update is a question. */
export const SYSTEM_MIN_GAP_MS = 20_000;
/** Leads every system note, in the model's input, the history and the memory record. */
export const SYSTEM_NOTE_MARKER = '[Update from the coding agent, not from Kevin]';
const DEFAULT_NOTE_SOURCE = 'the coding agent';
const noteMarker = (source: string) => `[Update from ${source}, not from Kevin]`;

interface QueuedNote {
  text: string;
  urgent: boolean;
  at: number;
  /** Who the update is from, as the marker says it. */
  source: string;
}

/** One marker per run of updates from the same source; with only the default source it is the old single marker. */
function systemNoteText(notes: QueuedNote[]): string {
  const parts: string[] = [];
  let last: string | null = null;
  for (const note of notes) {
    if (note.source !== last) {
      parts.push(noteMarker(note.source));
      last = note.source;
    }
    parts.push(note.text);
  }
  return parts.join(' ');
}

export interface LocalVoiceServiceOptions {
  /** The avatar this service speaks for (default 'echo'). */
  avatarId?: string;
  llm: ChatClient;
  /** services/speech: checked for status, and the STT and TTS engine unless others are given. */
  speech: SpeechServiceClient;
  /** Tools offered to the model (built-ins such as web_search, and MCP tools). */
  tools?: Pick<ToolRegistry, 'list' | 'execute'>;
  /** Kokoro voice for the default TTS engine; the speech service's default when unset. */
  voice?: string;
  stt?: SpeechToTextEngine;
  tts?: TextToSpeechEngine;
  logger?: Logger;
  /** Long-term memory: a brief for each new conversation, and auto-recall before each turn. */
  memory?: VoiceMemory;
  /** Told about every tool call once it has finished, for long-term memory. */
  onToolResult?: (record: LocalVoiceToolRecord) => void;
  /** The active character's own voice for the engine that speaks, if it has picked one. */
  voiceFor?: () => string | undefined | Promise<string | undefined>;
  /**
   * Tools with confirmationLevel 'confirm' are offered to the model too; a call is not run but
   * recorded here for Kevin to approve (card or a spoken yes). Without it they stay hidden.
   */
  approvals?: Pick<ApprovalBroker, 'request' | 'waitingMessage' | 'resolveSpoken'>;
  /** A line added to the system prompt each turn, such as which workspaces the coding tools reach. */
  extraInstructions?: () => string | null | undefined;
  /** Updates are waiting and a system turn may run now: the renderer should call respond({ system: true }). */
  onSystemReady?: () => void;
  /** Older turns are dropped past this many messages. */
  maxHistoryMessages?: number;
  /** After this long without a turn, the next one starts a fresh conversation. */
  historyIdleResetMs?: number;
  now?: () => number;
}

export interface LocalVoiceToolRecord {
  name: string;
  arguments: unknown;
  /** What the tool returned (in full), or why it failed. */
  result: string;
  ok: boolean;
  at: number;
}

export class LocalVoiceService {
  private llm: ChatClient;
  private speech: SpeechServiceClient;
  private stt: SpeechToTextEngine;
  private tts: TextToSpeechEngine;
  /** The avatar this service talks as. Each avatar has its own service, history and queued notes. */
  readonly avatarId: string;
  private readonly tools?: Pick<ToolRegistry, 'list' | 'execute'>;
  private readonly logger?: Logger;
  private readonly maxHistoryMessages: number;

  private readonly onToolResult?: (record: LocalVoiceToolRecord) => void;
  private readonly voiceFor?: () => string | undefined | Promise<string | undefined>;
  private readonly historyIdleResetMs: number;
  private readonly now: () => number;
  private history: ChatMessage[] = [];
  private readonly memory?: VoiceMemory;
  /** This conversation's brief, fixed at its first turn so the prompt prefix never changes. */
  private brief: string | null = null;
  /** Memories already put in front of the model in this conversation. */
  private recalledIds: string[] = [];
  private lastTurnAt = 0;
  private readonly approvals?: LocalVoiceServiceOptions['approvals'];
  private readonly extraInstructions?: LocalVoiceServiceOptions['extraInstructions'];
  private readonly onSystemReady?: () => void;
  private notes: QueuedNote[] = [];
  private lastSystemTurnAt = Number.NEGATIVE_INFINITY;
  private systemTimer: ReturnType<typeof setTimeout> | null = null;
  private active: { requestId: string; controller: AbortController } | null = null;

  constructor(options: LocalVoiceServiceOptions) {
    this.avatarId = options.avatarId ?? 'echo';
    this.llm = options.llm;
    this.speech = options.speech;
    this.tools = options.tools;
    this.stt = options.stt ?? new SpeechServiceStt(options.speech);
    this.tts = options.tts ?? new KokoroTts(options.speech, options.voice);
    this.logger = options.logger;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 24;
    this.onToolResult = options.onToolResult;
    this.voiceFor = options.voiceFor;
    this.memory = options.memory;
    this.approvals = options.approvals;
    this.extraInstructions = options.extraInstructions;
    this.onSystemReady = options.onSystemReady;
    this.historyIdleResetMs = options.historyIdleResetMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Swap engines after a settings change. The conversation so far is kept; a reply in progress
   * finishes with the engines it started with.
   */
  configure(
    engines: {
      llm?: ChatClient;
      speech?: SpeechServiceClient;
      stt?: SpeechToTextEngine;
      tts?: TextToSpeechEngine;
    },
    options: { closeOldTts?: boolean } = {},
  ): void {
    this.llm = engines.llm ?? this.llm;
    this.speech = engines.speech ?? this.speech;
    this.stt = engines.stt ?? this.stt;
    if (engines.tts && engines.tts !== this.tts) {
      // Services that share one engine: only the first to switch closes the old one.
      if (options.closeOldTts !== false) this.tts.close?.();
      this.tts = engines.tts;
    }
  }

  async status(): Promise<LocalVoiceStatus> {
    const [llmAvailable, speech] = await Promise.all([this.llm.isAvailable(), this.speech.health()]);
    const stt = await this.stt.status(speech);
    return {
      llm: {
        available: llmAvailable,
        model: this.llm.model,
        baseUrl: this.llm.baseUrl,
        provider: this.llm.flavor === 'openai' ? 'openai' : 'local',
      },
      stt,
      tts: this.tts.status(speech),
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
    return this.stt.transcribe(wav);
  }

  /** Stop the reply in progress (or only `requestId`'s, when given). */
  cancel(requestId?: string): void {
    if (this.active && (!requestId || this.active.requestId === requestId)) {
      this.active.controller.abort();
      this.active = null;
    }
  }

  /**
   * Queue an update for Echo to say something about (a coding task needs an answer, a review is
   * ready). Several within SYSTEM_COALESCE_MS become one turn, and turns are at least
   * SYSTEM_MIN_GAP_MS apart unless one of the updates is `urgent` (a question). The renderer runs
   * the turn, when the conversation is idle, in answer to onSystemReady.
   */
  notify(text: string, options: { urgent?: boolean; source?: string } = {}): void {
    const note = text.trim();
    if (!note) return;
    this.notes.push({ text: note, urgent: options.urgent === true, at: this.now(), source: options.source?.trim() || DEFAULT_NOTE_SOURCE });
    this.scheduleSystemReady();
  }

  systemStatus(): LocalVoiceSystemStatus {
    return {
      pending: this.notes.length,
      ready: this.systemReady(),
      texts: this.notes.map((note) => note.text),
      urgent: this.notes.some((note) => note.urgent),
    };
  }

  private systemReadyAt(): number {
    if (this.notes.length === 0) return Number.POSITIVE_INFINITY;
    const coalesced = this.notes[0].at + SYSTEM_COALESCE_MS;
    const urgent = this.notes.some((note) => note.urgent);
    return urgent ? coalesced : Math.max(coalesced, this.lastSystemTurnAt + SYSTEM_MIN_GAP_MS);
  }

  private systemReady(): boolean {
    return this.notes.length > 0 && this.now() >= this.systemReadyAt();
  }

  private scheduleSystemReady(): void {
    if (this.systemTimer) clearTimeout(this.systemTimer);
    this.systemTimer = null;
    if (this.notes.length === 0) return;
    const wait = Math.max(0, this.systemReadyAt() - this.now());
    this.systemTimer = setTimeout(() => {
      this.systemTimer = null;
      if (this.systemReady()) this.onSystemReady?.();
      else this.scheduleSystemReady();
    }, wait);
    this.systemTimer.unref?.();
  }

  /**
   * The queued updates as one note for the model; empties the queue. The notes stay in flight:
   * `restore` puts them back at the front (and re-arms the timer) if the turn fails or is cancelled.
   */
  private takeSystemNote(): { text: string; restore: () => void } | null {
    if (!this.systemReady()) return null;
    const notes = this.notes;
    const previousTurnAt = this.lastSystemTurnAt;
    this.notes = [];
    this.lastSystemTurnAt = this.now();
    if (this.systemTimer) clearTimeout(this.systemTimer);
    this.systemTimer = null;
    let restored = false;
    return {
      text: systemNoteText(notes),
      restore: () => {
        if (restored) return;
        restored = true;
        this.notes = [...notes, ...this.notes];
        this.lastSystemTurnAt = previousTurnAt;
        this.scheduleSystemReady();
      },
    };
  }

  resetHistory(): void {
    this.history = [];
    this.brief = null;
    this.recalledIds = [];
  }

  /** Say one line out loud without asking the model: speech only, sent as a 'sentence' event of the request that is about to be answered. */
  async speakOnly(requestId: string, text: string, emit: (event: LocalVoiceEvent) => void): Promise<void> {
    const spoken = toSpeakableText(text);
    if (!spoken) return;
    try {
      const voice = await Promise.resolve(this.voiceFor?.()).catch(() => undefined);
      const wav = await this.tts.synthesize(spoken, voice ? { voice } : {});
      emit({ requestId, type: 'sentence', index: 0, text, wav });
    } catch (error) {
      this.logger?.warn('Local voice: could not speak the holding line', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async respond(
    request: LocalVoiceRespondRequest,
    emit: (event: LocalVoiceEvent) => void,
  ): Promise<LocalVoiceRespondResult> {
    const { requestId } = request;
    const preview = request.preview === true;
    const system = request.system === true && !preview;
    let inputText = request.text;
    let systemNote: string | undefined;
    let restoreNotes: (() => void) | undefined;
    if (system) {
      const taken = this.takeSystemNote();
      if (!taken) {
        return { requestId, text: '', cancelled: true };
      }
      systemNote = taken.text;
      restoreNotes = taken.restore;
      inputText = taken.text;
    }
    try {
      return await this.runTurn(request, emit, { requestId, preview, system, inputText, systemNote, restoreNotes });
    } catch (error) {
      restoreNotes?.();
      throw error;
    }
  }

  private async runTurn(
    request: LocalVoiceRespondRequest,
    emit: (event: LocalVoiceEvent) => void,
    turn: { requestId: string; preview: boolean; system: boolean; inputText: string; systemNote?: string; restoreNotes?: () => void },
  ): Promise<LocalVoiceRespondResult> {
    const { requestId, preview, system, inputText, systemNote, restoreNotes } = turn;
    this.cancel();
    const controller = new AbortController();
    this.active = { requestId, controller };
    const { signal } = controller;

    if (!preview && this.now() - this.lastTurnAt > this.historyIdleResetMs) {
      this.resetHistory();
    }

    // A preview stays out of long-term memory entirely.
    const memory = preview ? undefined : this.memory;
    memory?.activity?.(true);
    // Both run at once and have their own time limits; neither throws.
    const [brief, recalled] = await Promise.all([
      this.brief === null && memory ? memory.brief() : Promise.resolve(preview ? null : this.brief),
      system ? Promise.resolve(null) : (memory?.recall(inputText, this.recalledIds) ?? Promise.resolve(null)),
    ]);
    if (signal.aborted) {
      memory?.activity?.(false);
      restoreNotes?.();
      return { requestId, text: '', cancelled: true };
    }
    if (!preview) {
      this.brief = brief;
    }
    if (recalled) {
      this.recalledIds.push(...recalled.ids);
      this.logger?.info('Local voice: recalled memories', { requestId, count: recalled.ids.length });
    }
    // The recalled block rides in the user message (Qwen's template wants one system message,
    // first) and stays in the history as sent, so later turns keep the same prefix.
    let userContent = recalled ? `${recalled.block}\n\n${inputText}` : inputText;

    // A pending approval: a clear yes or no settles it before the model hears anything, and the
    // model is told what happened. Anything else goes to the model as normal.
    if (!preview && !system && this.approvals) {
      const outcome = await this.approvals.resolveSpoken(inputText).catch(() => null);
      if (outcome) {
        userContent = `${userContent}\n\n[Approval handled: ${describeOutcome(outcome)} Tell Kevin in one short sentence.]`;
        this.logger?.info('Local voice: spoken approval handled', { decision: outcome.decision, tool: outcome.approval.toolName });
      }
    }

    // Tools that need approval ("confirm") are offered when there is a broker to ask Kevin;
    // forbidden ones ("block") never are, and a call to one is refused as an unknown tool.
    const tools = (preview ? [] : (this.tools?.list() ?? [])).filter(
      (tool) =>
        tool.confirmationLevel === 'none' ||
        tool.confirmationLevel === 'notify' ||
        (tool.confirmationLevel === 'confirm' && this.approvals !== undefined),
    );
    const systemPrompt = [
      request.instructions?.trim(),
      SPOKEN_REPLY_GUIDANCE,
      tools.length ? TOOL_GUIDANCE : null,
      tools.length ? this.extraInstructions?.()?.trim() : null,
      brief,
    ]
      .filter(Boolean)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(preview ? [] : this.history),
      { role: 'user', content: userContent },
    ];

    const { llm, tts } = this;
    const voice = await Promise.resolve(this.voiceFor?.()).catch(() => undefined);
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
          const wav = spoken ? await tts.synthesize(spoken, { signal, ...(voice ? { voice } : {}) }) : new Uint8Array(0);
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
        for await (const part of llm.streamChat(messages, { signal, tools: toToolDefinitions(offered) })) {
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
      memory?.activity?.(false);
    }
    cancelled ||= signal.aborted;
    if (cancelled) restoreNotes?.();
    if (preview) {
      this.logger?.info('Local voice: preview finished', { requestId, cancelled, sentences: index });
      return { requestId, text: reply, cancelled };
    }

    // Tool exchanges stay out of the history: trimming it could split a call from its result.
    // A system note is kept as a user-role message because Qwen's chat template allows a system
    // message only at the start; its marker says plainly that it did not come from Kevin.
    this.history.push({ role: 'user', content: userContent });
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
    return { requestId, text: reply, cancelled, ...(systemNote ? { note: systemNote } : {}) };
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
    } else if (tool.confirmationLevel === 'confirm' && this.approvals) {
      // Not run: Kevin has to approve it first (the card, or a spoken yes).
      const approval = await this.approvals.request(tool, params);
      content = this.approvals.waitingMessage(approval);
      this.logger?.info('Local voice: tool call waits for approval', { name: call.name, label, approvalId: approval.id });
      emit({ ...event, status: 'done', detail: 'waiting for approval' });
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
    this.reportToolResult(call.name, params ?? call.arguments, failure ?? content, failure === null);
    if (failure !== null) {
      this.logger?.warn('Local voice: tool call failed', { name: call.name, label, message: failure });
      emit({ ...event, status: 'failed', detail: failure });
      return JSON.stringify({ error: failure });
    }
    return content.length > MAX_TOOL_RESULT_CHARS ? `${content.slice(0, MAX_TOOL_RESULT_CHARS)}…` : content;
  }

  private reportToolResult(name: string, args: unknown, result: string, ok: boolean): void {
    if (!this.onToolResult) {
      return;
    }
    try {
      this.onToolResult({ name, arguments: args, result, ok, at: this.now() });
    } catch (error) {
      this.logger?.warn('Local voice: recording a tool call failed', {
        name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
