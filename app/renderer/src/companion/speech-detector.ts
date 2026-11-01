/**
 * Finds the end of what was said on the phone's raw microphone: speech is louder than the room
 * by a margin, and an utterance ends after a pause. The noise floor adapts while nobody is
 * talking, so a fan or traffic does not count as speech. (The desktop's segmenter assumes a mic
 * stream already gated by its own VAD; the phone has none.)
 */

export interface SpeechDetectorOptions {
  /** A frame is speech when its level is this many times the noise floor… */
  startRatio?: number;
  /** …and above this absolute level. */
  minRms?: number;
  /** Quiet this long ends an utterance. */
  silenceMs?: number;
  /** Less speech than this (a click, a cough) is ignored. */
  minSpeechMs?: number;
  maxUtteranceMs?: number;
  /** Give up listening when nothing is said for this long. */
  noSpeechTimeoutMs?: number;
  /** Audio kept from just before speech starts, so the first syllable is not clipped. */
  preRollMs?: number;
}

export type SpeechDetectorResult =
  | { type: 'utterance'; samples: Float32Array; sampleRate: number; durationMs: number }
  | { type: 'timeout' }
  | null;

export class SpeechDetector {
  private readonly startRatio: number;
  private readonly minRms: number;
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly maxUtteranceMs: number;
  private readonly noSpeechTimeoutMs: number;
  private readonly preRollMs: number;
  private noiseFloor = 0.004;
  private preRoll: Float32Array[] = [];
  private preRollLength = 0;
  private chunks: Float32Array[] = [];
  private speaking = false;
  private speechMs = 0;
  private startedAt = 0;
  private speechStartAt = 0;
  private lastVoiceAt = 0;
  private sampleRate = 16000;
  private timeoutMs: number;
  /** Between start() and the utterance or timeout that ends it. */
  private active = false;
  /** Level of the last frame, 0..1, for a meter. */
  level = 0;

  constructor(options: SpeechDetectorOptions = {}) {
    this.startRatio = options.startRatio ?? 3;
    this.minRms = options.minRms ?? 0.012;
    this.silenceMs = options.silenceMs ?? 800;
    this.minSpeechMs = options.minSpeechMs ?? 250;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 20_000;
    this.noSpeechTimeoutMs = options.noSpeechTimeoutMs ?? 8000;
    this.preRollMs = options.preRollMs ?? 300;
    this.timeoutMs = this.noSpeechTimeoutMs;
  }

  /** Start listening for one utterance. `timeoutMs` overrides the no-speech timeout. */
  start(nowMs: number, timeoutMs = this.noSpeechTimeoutMs): void {
    this.reset();
    this.startedAt = nowMs;
    this.timeoutMs = timeoutMs;
    this.active = true;
  }

  get hasSpeech(): boolean {
    return this.speaking && this.speechMs >= this.minSpeechMs;
  }

  push(samples: Float32Array, sampleRate: number, nowMs: number): SpeechDetectorResult {
    if (!this.active) {
      return null;
    }
    this.sampleRate = sampleRate;
    const frameMs = (samples.length / sampleRate) * 1000;
    const level = rms(samples);
    this.level = level;
    const voiced = level > Math.max(this.minRms, this.noiseFloor * this.startRatio);

    if (!this.speaking) {
      // Follow the room: quickly down, slowly up, never towards speech.
      this.noiseFloor = level < this.noiseFloor ? this.noiseFloor * 0.7 + level * 0.3 : this.noiseFloor * 0.97 + level * 0.03;
      if (!voiced) {
        this.keepPreRoll(samples);
        if (nowMs - this.startedAt >= this.timeoutMs) {
          this.reset();
          this.active = false;
          return { type: 'timeout' };
        }
        return null;
      }
      this.speaking = true;
      this.speechStartAt = nowMs - frameMs;
      this.chunks = [...this.preRoll];
      this.preRoll = [];
      this.preRollLength = 0;
    }

    this.chunks.push(Float32Array.from(samples));
    if (voiced) {
      this.lastVoiceAt = nowMs;
      this.speechMs += frameMs;
    }
    const paused = nowMs - this.lastVoiceAt >= this.silenceMs;
    const tooLong = nowMs - this.speechStartAt >= this.maxUtteranceMs;
    if (!paused && !tooLong) {
      return null;
    }
    if (this.speechMs < this.minSpeechMs) {
      // Only a click: keep waiting for real speech.
      this.speaking = false;
      this.chunks = [];
      this.speechMs = 0;
      return null;
    }
    return this.finish();
  }

  /** End now with whatever speech was heard (a second tap); null when there was none. */
  flush(): SpeechDetectorResult {
    return this.hasSpeech ? this.finish() : null;
  }

  reset(): void {
    this.chunks = [];
    this.preRoll = [];
    this.preRollLength = 0;
    this.speaking = false;
    this.speechMs = 0;
  }

  private finish(): SpeechDetectorResult {
    const samples = concat(this.chunks);
    const durationMs = (samples.length / this.sampleRate) * 1000;
    const sampleRate = this.sampleRate;
    this.reset();
    this.active = false;
    return { type: 'utterance', samples, sampleRate, durationMs };
  }

  private keepPreRoll(samples: Float32Array): void {
    this.preRoll.push(Float32Array.from(samples));
    this.preRollLength += samples.length;
    const keep = (this.preRollMs / 1000) * this.sampleRate;
    while (this.preRoll.length > 1 && this.preRollLength - (this.preRoll[0]?.length ?? 0) >= keep) {
      this.preRollLength -= this.preRoll.shift()?.length ?? 0;
    }
  }
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((length, chunk) => length + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 16-bit little-endian PCM (base64, as the Android shell sends it) → float samples. */
export function decodePcm16Base64(base64: string): Float32Array {
  const binary = atob(base64);
  const samples = new Float32Array(Math.floor(binary.length / 2));
  for (let i = 0; i < samples.length; i += 1) {
    const low = binary.charCodeAt(i * 2);
    const high = binary.charCodeAt(i * 2 + 1);
    let value = (high << 8) | low;
    if (value >= 0x8000) {
      value -= 0x10000;
    }
    samples[i] = value / 0x8000;
  }
  return samples;
}
