/**
 * The local voice chain: one user utterance in, a spoken reply out.
 * speech-to-text (services/voice) -> streaming chat (local Qwen via llama-server) -> text-to-speech
 * per sentence (services/voice), with each sentence's audio sent as soon as it is ready.
 */
import type { ChatMessage, LocalLlmClient } from './local-llm-client.js';
import { ReplySegmenter, toSpeakable } from './reply-segmenter.js';
import type {
  LocalVoiceEvent,
  LocalVoiceStatus,
  LocalVoiceTimings,
  LocalVoiceTurnRequest,
  LocalVoiceTurnResult,
} from './types.js';
import type { VoiceServiceClient } from './voice-service-client.js';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

export interface LocalConversationServiceOptions {
  llm: LocalLlmClient;
  speech: VoiceServiceClient;
  ttsVoice?: string;
  /** Messages (user + assistant) kept as context. */
  historyLimit?: number;
  logger?: Logger;
  now?: () => number;
}

const DEFAULT_INSTRUCTIONS =
  'You are a friendly embodied assistant. Your replies are spoken aloud, so keep them short and conversational, with no markdown or lists.';

export class LocalConversationService {
  private readonly llm: LocalLlmClient;
  private readonly speech: VoiceServiceClient;
  private readonly ttsVoice?: string;
  private readonly historyLimit: number;
  private readonly logger?: Logger;
  private readonly now: () => number;
  private history: ChatMessage[] = [];
  private readonly active = new Map<string, AbortController>();

  constructor(options: LocalConversationServiceOptions) {
    this.llm = options.llm;
    this.speech = options.speech;
    this.ttsVoice = options.ttsVoice;
    this.historyLimit = options.historyLimit ?? 20;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<LocalVoiceStatus> {
    const [models, health] = await Promise.all([this.llm.listModels(), this.speech.health()]);
    return {
      backend: 'local',
      llm: { available: models !== null, model: this.llm.model, baseUrl: this.llm.baseUrl },
      speech: {
        available: health !== null,
        ready: health?.ready === true,
        stt: health?.stt ?? null,
        tts: health?.tts ?? null,
      },
    };
  }

  reset(): void {
    this.history = [];
  }

  /** Stops a turn (barge-in). Returns false when it already finished. */
  cancel(turnId: string): boolean {
    const controller = this.active.get(turnId);
    controller?.abort();
    return Boolean(controller);
  }

  async runTurn(
    request: LocalVoiceTurnRequest,
    emit: (event: LocalVoiceEvent) => void,
  ): Promise<LocalVoiceTurnResult> {
    const { turnId } = request;
    // A new utterance supersedes whatever is still being said.
    for (const controller of this.active.values()) {
      controller.abort();
    }
    const controller = new AbortController();
    this.active.set(turnId, controller);
    const { signal } = controller;
    const startedAt = this.now();
    const timings: LocalVoiceTimings = { totalMs: 0 };
    let transcript = '';
    let reply = '';

    const finish = (cancelled: boolean): LocalVoiceTurnResult => {
      timings.totalMs = this.now() - startedAt;
      this.active.delete(turnId);
      if (transcript && reply.trim()) {
        this.remember({ role: 'assistant', content: reply.trim() });
      }
      this.logger?.info('Local voice turn finished.', { turnId, cancelled, ...timings });
      return { turnId, transcript, text: reply.trim(), cancelled, timings };
    };

    try {
      const transcription = await this.speech.transcribe(request.audio, { signal });
      timings.sttMs = this.now() - startedAt;
      transcript = transcription.text;
      if (!transcript) {
        return finish(false);
      }
      emit({ turnId, type: 'transcript', text: transcript });

      const messages: ChatMessage[] = [
        { role: 'system', content: request.instructions?.trim() || DEFAULT_INSTRUCTIONS },
        ...this.history,
        { role: 'user', content: transcript },
      ];
      this.remember({ role: 'user', content: transcript });

      const segmenter = new ReplySegmenter();
      let audioIndex = 0;
      // Sentences are synthesized one after another (in order) while the LLM keeps generating.
      let speaking: Promise<void> = Promise.resolve();
      const handleSegment = (segment: string) => {
        emit({ turnId, type: 'text', text: segment });
        const speakable = toSpeakable(segment);
        if (!speakable) {
          return;
        }
        speaking = speaking.then(async () => {
          if (signal.aborted) {
            return;
          }
          try {
            const audio = await this.speech.synthesize(speakable, { voice: this.ttsVoice, signal });
            if (signal.aborted) {
              return;
            }
            timings.firstAudioMs ??= this.now() - startedAt;
            emit({ turnId, type: 'audio', index: audioIndex, sampleRate: audio.sampleRate, data: audio.pcm });
            audioIndex += 1;
          } catch (error) {
            if (!signal.aborted) {
              this.logger?.warn('Text-to-speech failed for a sentence; skipping it.', {
                turnId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        });
      };

      for await (const delta of this.llm.streamChat(messages, { signal })) {
        timings.firstTokenMs ??= this.now() - startedAt;
        reply += delta;
        segmenter.push(delta).forEach(handleSegment);
      }
      segmenter.flush().forEach(handleSegment);
      await speaking;
      return finish(signal.aborted);
    } catch (error) {
      if (signal.aborted) {
        return finish(true);
      }
      this.active.delete(turnId);
      this.logger?.error('Local voice turn failed.', {
        turnId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private remember(message: ChatMessage): void {
    this.history.push(message);
    if (this.history.length > this.historyLimit) {
      this.history = this.history.slice(-this.historyLimit);
    }
  }
}
