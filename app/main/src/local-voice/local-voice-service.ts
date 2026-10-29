/**
 * The local conversation backend: speech-to-text and text-to-speech through services/speech,
 * replies from a local LLM. Replies stream sentence by sentence: each sentence is spoken as soon
 * as the LLM finishes it, so the first words play while the rest is still being written.
 */
import type { ChatMessage, LocalLlmClient } from './local-llm-client.js';
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

export interface LocalVoiceServiceOptions {
  llm: LocalLlmClient;
  speech: SpeechServiceClient;
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

    const system = [request.instructions?.trim(), SPOKEN_REPLY_GUIDANCE].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...this.history,
      { role: 'user', content: request.text },
    ];

    const thinking = new ThinkFilter();
    const splitter = new SentenceSplitter();
    let index = 0;
    let speaking = Promise.resolve();
    const startedAt = this.now();
    let firstSentenceAt: number | null = null;

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
      for await (const delta of this.llm.streamChat(messages, { signal })) {
        for (const sentence of splitter.push(thinking.push(delta))) {
          speak(sentence);
        }
      }
      const rest = splitter.flush();
      if (rest) {
        speak(rest);
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

    const reply = thinking.visible.trim();
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
