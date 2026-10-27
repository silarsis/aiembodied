/**
 * Cuts the (already VAD-gated) microphone stream into utterances for the local voice chain.
 * Frames arrive as 16 kHz float samples; an utterance ends after `endSilenceMs` of quiet.
 */

export interface UtteranceDetectorOptions {
  sampleRate?: number;
  /** RMS above this counts as speech. The input is gated to silence between words, so this can be low. */
  speechThreshold?: number;
  endSilenceMs?: number;
  /** Utterances with less speech than this are dropped (coughs, clicks). */
  minSpeechMs?: number;
  /** Audio kept from before speech starts, so the first syllable isn't clipped. */
  preRollMs?: number;
  maxUtteranceMs?: number;
}

export interface UtteranceDetectorEvents {
  onSpeechStart?: () => void;
  onUtterance?: (pcm16: Uint8Array, durationMs: number) => void;
}

export class UtteranceDetector {
  private readonly sampleRate: number;
  private readonly speechThreshold: number;
  private readonly endSilenceMs: number;
  private readonly minSpeechMs: number;
  private readonly preRollMs: number;
  private readonly maxUtteranceMs: number;
  private preRoll: Float32Array[] = [];
  private preRollSamples = 0;
  private frames: Float32Array[] = [];
  private samples = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private active = false;

  constructor(
    private readonly events: UtteranceDetectorEvents,
    options: UtteranceDetectorOptions = {},
  ) {
    this.sampleRate = options.sampleRate ?? 16000;
    this.speechThreshold = options.speechThreshold ?? 0.01;
    this.endSilenceMs = options.endSilenceMs ?? 700;
    this.minSpeechMs = options.minSpeechMs ?? 250;
    this.preRollMs = options.preRollMs ?? 300;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 30000;
  }

  get isSpeaking(): boolean {
    return this.active;
  }

  push(frame: Float32Array): void {
    const copy = new Float32Array(frame);
    const frameMs = (copy.length / this.sampleRate) * 1000;
    const speech = rms(copy) >= this.speechThreshold;

    if (!this.active) {
      if (!speech) {
        this.preRoll.push(copy);
        this.preRollSamples += copy.length;
        const maxPreRoll = (this.preRollMs / 1000) * this.sampleRate;
        while (this.preRoll.length > 1 && this.preRollSamples - this.preRoll[0].length >= maxPreRoll) {
          this.preRollSamples -= this.preRoll[0].length;
          this.preRoll.shift();
        }
        return;
      }
      this.active = true;
      this.frames = this.preRoll;
      this.samples = this.preRollSamples;
      this.preRoll = [];
      this.preRollSamples = 0;
      this.speechMs = 0;
      this.silenceMs = 0;
      this.events.onSpeechStart?.();
    }

    this.frames.push(copy);
    this.samples += copy.length;
    if (speech) {
      this.speechMs += frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }

    const durationMs = (this.samples / this.sampleRate) * 1000;
    if (this.silenceMs >= this.endSilenceMs || durationMs >= this.maxUtteranceMs) {
      this.finish();
    }
  }

  /** Drops whatever is buffered (e.g. on disconnect). */
  reset(): void {
    this.active = false;
    this.frames = [];
    this.samples = 0;
    this.preRoll = [];
    this.preRollSamples = 0;
  }

  private finish(): void {
    const frames = this.frames;
    const samples = this.samples;
    const speechMs = this.speechMs;
    this.reset();
    if (speechMs < this.minSpeechMs) {
      return;
    }
    this.events.onUtterance?.(toPcm16(frames, samples), (samples / this.sampleRate) * 1000);
  }
}

function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    sum += frame[i] * frame[i];
  }
  return frame.length > 0 ? Math.sqrt(sum / frame.length) : 0;
}

export function toPcm16(frames: Float32Array[], totalSamples: number): Uint8Array {
  const out = new Uint8Array(totalSamples * 2);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, frame[i]));
      view.setInt16(offset, Math.round(clamped * 32767), true);
      offset += 2;
    }
  }
  return out;
}

export function pcm16ToFloat(data: Uint8Array): Float32Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Float32Array(Math.floor(data.byteLength / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}
