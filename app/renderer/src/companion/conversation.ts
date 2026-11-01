/**
 * Turn-taking on the phone. Tap to talk; the reply plays; then it listens a few seconds more for
 * a follow-up, so a back-and-forth needs one tap. Half duplex like the desktop: the mic is off
 * while the avatar speaks, so it never answers itself. Messages the desktop pushes play the same
 * way and also open a follow-up window, so they can be answered.
 */
import { encodeWav } from '../realtime/local-voice-client.js';
import type { CompanionStreamEvent } from '../../../main/src/companion/types.js';
import type { Microphone, SpeechPlayer } from './audio-io.js';
import type { CompanionClient } from './companion-client.js';
import { SpeechDetector } from './speech-detector.js';

export type ConversationPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface Caption {
  speaker: 'user' | 'assistant' | 'notice';
  text: string;
}

export interface ConversationCallbacks {
  onPhase(phase: ConversationPhase): void;
  onCaption(caption: Caption | null): void;
  /** A reply sentence started playing; its avatar tags should fire now. */
  onSentence(text: string): void;
  /** Mic level 0..1 while listening. */
  onLevel?(level: number): void;
}

export const FIRST_LISTEN_TIMEOUT_MS = 8000;
export const FOLLOW_UP_TIMEOUT_MS = 6000;

export class Conversation {
  private phase: ConversationPhase = 'idle';
  private readonly detector = new SpeechDetector();
  private micOn = false;
  private turn: { controller: AbortController; requestId: string | null } | null = null;
  private pushRequests = new Set<string>();
  private disposed = false;
  private epoch = 0;

  constructor(
    private readonly client: CompanionClient,
    private readonly mic: Microphone,
    private readonly player: SpeechPlayer,
    private readonly callbacks: ConversationCallbacks,
    private readonly now: () => number = () => performance.now(),
  ) {}

  getPhase(): ConversationPhase {
    return this.phase;
  }

  /** A tap anywhere on the screen. */
  tap(): void {
    this.player.unlock();
    switch (this.phase) {
      case 'idle':
        this.listen(FIRST_LISTEN_TIMEOUT_MS);
        return;
      case 'listening': {
        // A second tap sends what was said without waiting for a pause, or stops listening.
        const result = this.detector.flush();
        this.stopMic();
        if (result?.type === 'utterance') {
          void this.send(result.samples, result.sampleRate);
        } else {
          this.setPhase('idle');
        }
        return;
      }
      case 'thinking':
      case 'speaking':
        this.interrupt();
        this.listen(FIRST_LISTEN_TIMEOUT_MS);
    }
  }

  /** Something the desktop pushed: a message to speak, or a scene change (handled elsewhere). */
  handlePush(event: CompanionStreamEvent): void {
    if (event.type === 'say') {
      this.pushRequests.add(event.requestId);
      if (this.phase === 'listening') {
        this.stopMic();
      }
      this.callbacks.onCaption({ speaker: 'assistant', text: stripTags(event.text) });
      return;
    }
    if (!('requestId' in event) || !this.pushRequests.has(event.requestId)) {
      return;
    }
    if (event.type === 'sentence') {
      if (this.phase !== 'thinking') {
        this.setPhase('speaking');
      }
      this.player.enqueue(event.wav, () => this.callbacks.onSentence(event.text));
    } else if (event.type === 'done') {
      this.pushRequests.delete(event.requestId);
      const epoch = this.epoch;
      void this.player.finished().then(() => {
        if (epoch === this.epoch && this.phase === 'speaking' && !this.turn) {
          this.listen(FOLLOW_UP_TIMEOUT_MS);
        }
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.interrupt();
    this.stopMic();
  }

  private listen(timeoutMs: number): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.detector.start(this.now(), timeoutMs);
    this.setPhase('listening');
    if (this.micOn) return;
    this.micOn = true;
    void this.mic.start(
      (samples, sampleRate) => this.handleSamples(samples, sampleRate),
      (message) => {
        this.stopMic();
        this.setPhase('idle');
        this.callbacks.onCaption({ speaker: 'notice', text: `Microphone: ${message}` });
      },
    );
  }

  private handleSamples(samples: Float32Array, sampleRate: number): void {
    if (this.phase !== 'listening') return;
    const result = this.detector.push(samples, sampleRate, this.now());
    this.callbacks.onLevel?.(Math.min(1, this.detector.level * 8));
    if (!result) return;
    this.stopMic();
    console.info('[companion] heard', result.type === 'utterance' ? `${Math.round(result.durationMs)} ms of speech` : 'nothing');
    if (result.type === 'timeout') {
      this.setPhase('idle');
      return;
    }
    void this.send(result.samples, result.sampleRate);
  }

  private async send(samples: Float32Array, sampleRate: number): Promise<void> {
    const controller = new AbortController();
    const turn = { controller, requestId: null as string | null };
    this.turn = turn;
    const epoch = ++this.epoch;
    this.setPhase('thinking');
    let reply = '';
    let heard = '';
    let cancelled = false;
    try {
      await this.client.turn(
        encodeWav(downsample(samples, sampleRate, 16000), Math.min(sampleRate, 16000)),
        (event) => {
          if (epoch !== this.epoch) return;
          switch (event.type) {
            case 'transcript':
              turn.requestId = event.requestId;
              heard = event.text;
              this.callbacks.onCaption(heard ? { speaker: 'user', text: heard } : { speaker: 'notice', text: "Sorry, I didn't catch that." });
              break;
            case 'sentence':
              this.player.enqueue(event.wav, () => {
                if (epoch !== this.epoch) return;
                this.setPhase('speaking');
                this.callbacks.onSentence(event.text);
                this.callbacks.onCaption({ speaker: 'assistant', text: stripTags(event.text) });
              });
              break;
            case 'error':
              this.callbacks.onCaption({ speaker: 'notice', text: event.message });
              break;
            case 'done':
              reply = event.text;
              cancelled = event.cancelled;
              break;
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (epoch === this.epoch && !controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        this.callbacks.onCaption({ speaker: 'notice', text: `The desktop did not answer: ${message}` });
      }
    }
    if (this.turn === turn) this.turn = null;
    if (epoch !== this.epoch) return;
    await this.player.finished();
    if (epoch !== this.epoch) return;
    if (heard && reply && !cancelled) {
      this.listen(FOLLOW_UP_TIMEOUT_MS);
    } else {
      this.setPhase('idle');
    }
  }

  private interrupt(): void {
    this.epoch += 1;
    const turn = this.turn;
    this.turn = null;
    if (turn) {
      turn.controller.abort();
      if (turn.requestId) void this.client.cancel(turn.requestId).catch(() => undefined);
    }
    this.pushRequests.clear();
    this.player.stop();
  }

  private stopMic(): void {
    if (!this.micOn) return;
    this.micOn = false;
    this.mic.stop();
    this.callbacks.onLevel?.(0);
  }

  private setPhase(phase: ConversationPhase): void {
    if (this.phase === phase) return;
    console.info(`[companion] ${this.phase} → ${phase}`);
    this.phase = phase;
    this.callbacks.onPhase(phase);
  }
}

/** The words of a reply sentence, without {anim:…} and similar tags. */
export function stripTags(text: string): string {
  return text.replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Naive decimation to `targetRate` (speech only needs 16 kHz; it keeps uploads small). */
export function downsample(samples: Float32Array, sampleRate: number, targetRate: number): Float32Array {
  if (sampleRate <= targetRate) return samples;
  const ratio = sampleRate / targetRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j] ?? 0;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}
