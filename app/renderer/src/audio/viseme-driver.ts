import { calculateRms, normalizeAudioLevel } from './metrics.js';

export interface VisemeFrame {
  /**
   * Timeline timestamp for the audio frame in milliseconds.
   */
  t: number;
  /**
   * Discrete viseme bucket index (0-4 for the MVP).
   */
  index: number;
  /**
   * Smoothed mouth openness intensity in the 0..1 range.
   */
  intensity: number;
  /**
   * Optional blink trigger flag. Consumers should treat the frame as the start
   * of a blink when present.
   */
  blink?: boolean;
}

export interface VisemeDriverCallbacks {
  onFrame?: (frame: VisemeFrame) => void;
  onError?: (error: Error) => void;
}

export interface VisemeDriverOptions {
  /** Desired viseme cadence in frames per second. */
  frameRate?: number;
  /** Attack smoothing window in milliseconds. */
  attackMs?: number;
  /** Release smoothing window in milliseconds. */
  releaseMs?: number;
  /** Minimum normalized level treated as silence. */
  noiseFloor?: number;
  /** Gamma curve exponent applied after noise floor subtraction. */
  intensityExponent?: number;
  /** Intensity thresholds that map to viseme buckets. */
  thresholds?: number[];
  /** Max intensity that still allows a blink to fire. */
  blinkMaxIntensity?: number;
  /** Interval range between blink attempts, in milliseconds. */
  blinkIntervalRangeMs?: [number, number];
  /** Suppression window applied when speech is active, in milliseconds. */
  blinkSuppressionMs?: number;
  /**
   * Custom frame scheduler. Primarily used for testing to emulate
   * `requestAnimationFrame`.
   */
  scheduler?: FrameScheduler;
  /**
   * Now provider. Defaults to `performance.now()` when available or
   * `Date.now()`.
   */
  now?: () => number;
  /** Random function used for blink jitter. */
  random?: () => number;
  /** Buffer factory override, useful for deterministic testing. */
  createBuffer?: (length: number) => Float32Array;
  /** FFT size applied when attaching to a MediaStream analyser. */
  analyserFftSize?: number;
  /** Smoothing constant applied to the analyser node. */
  analyserSmoothing?: number;
}

export interface FrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

interface AnalyserLike {
  fftSize: number;
  getFloatTimeDomainData(dataArray: Float32Array): void;
}

interface AttachStreamOptions {
  audioContext?: AudioContext;
  fftSize?: number;
  smoothingTimeConstant?: number;
}

const DEFAULT_THRESHOLDS = [0.22, 0.38, 0.58, 0.78];

function createDefaultScheduler(): FrameScheduler {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return {
      request: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
      cancel: (handle: number) => window.cancelAnimationFrame(handle),
    };
  }

  return {
    request: (callback: FrameRequestCallback) => {
      const timeout = setTimeout(() => {
        callback((typeof performance !== 'undefined' ? performance.now() : Date.now()));
      }, 1000 / 60);
      return timeout as unknown as number;
    },
    cancel: (handle: number) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
  };
}

export class VisemeDriver {
  private readonly frameIntervalMs: number;

  private readonly attackMs: number;

  private readonly releaseMs: number;

  private readonly noiseFloor: number;

  private readonly intensityExponent: number;

  private readonly thresholds: number[];

  private readonly blinkMaxIntensity: number;

  private readonly blinkIntervalRange: [number, number];

  private readonly blinkSuppressionMs: number;

  private readonly scheduler: FrameScheduler;

  private readonly now: () => number;

  private readonly random: () => number;

  private readonly createBuffer: (length: number) => Float32Array;

  private readonly analyserFftSize: number;

  private readonly analyserSmoothing: number;

  private analyser: AnalyserLike | null = null;

  private analyserBuffer: Float32Array | null = null;

  private analyserCleanup: (() => Promise<void> | void) | null = null;

  private running = false;

  private frameHandle: number | null = null;

  private startTimestamp = 0;

  private lastFrameTimestamp = 0;

  private smoothedIntensity = 0;

  private nextBlinkAt = 0;

  private currentStream: MediaStream | null = null;

  constructor(private readonly callbacks: VisemeDriverCallbacks = {}, options: VisemeDriverOptions = {}) {
    const frameRate = Math.max(1, options.frameRate ?? 60);
    this.frameIntervalMs = 1000 / frameRate;
    this.attackMs = Math.max(1, options.attackMs ?? 30);
    this.releaseMs = Math.max(1, options.releaseMs ?? 60);
    this.noiseFloor = Math.min(0.5, Math.max(0, options.noiseFloor ?? 0.02));
    this.intensityExponent = Math.max(0.01, options.intensityExponent ?? 0.55);
    this.thresholds = (options.thresholds ?? DEFAULT_THRESHOLDS).slice().sort((a, b) => a - b);
    this.blinkMaxIntensity = Math.min(1, Math.max(0, options.blinkMaxIntensity ?? 0.25));
    const [minBlink, maxBlink] = options.blinkIntervalRangeMs ?? [2800, 4200];
    this.blinkIntervalRange = [Math.max(250, minBlink), Math.max(Math.max(250, minBlink), maxBlink)];
    this.blinkSuppressionMs = Math.max(0, options.blinkSuppressionMs ?? 220);
    this.scheduler = options.scheduler ?? createDefaultScheduler();
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.random = options.random ?? Math.random;
    this.createBuffer = options.createBuffer ?? ((length) => new Float32Array(length));
    this.analyserFftSize = Math.max(32, options.analyserFftSize ?? 2048);
    this.analyserSmoothing = Math.min(0.99, Math.max(0, options.analyserSmoothing ?? 0.5));
  }

  async attachToStream(stream: MediaStream | null, options: AttachStreamOptions = {}): Promise<void> {
    if (!stream) {
      await this.cleanupAnalyser();
      return;
    }

    if (this.currentStream === stream) {
      return;
    }

    await this.cleanupAnalyser();

    const context = options.audioContext ?? new AudioContext({ latencyHint: 'interactive' });
    const ownsContext = !options.audioContext;

    try {
      if (context.state === 'suspended') {
        await context.resume();
      }
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = options.fftSize ?? this.analyserFftSize;
    analyser.smoothingTimeConstant = options.smoothingTimeConstant ?? this.analyserSmoothing;
    source.connect(analyser);

    const cleanup = async () => {
      try {
        source.disconnect();
      } catch (error) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      try {
        analyser.disconnect();
      } catch (error) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }

      if (ownsContext) {
        try {
          await context.close();
        } catch (error) {
          this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    await this.setAnalyser(analyser, cleanup);
    this.currentStream = stream;

    if (!this.running) {
      this.start();
    }
  }

  async setAnalyser(analyser: AnalyserLike | null, cleanup?: () => Promise<void> | void): Promise<void> {
    await this.cleanupAnalyser();

    if (!analyser) {
      return;
    }

    this.analyser = analyser;
    this.analyserBuffer = this.createBuffer(analyser.fftSize);
    this.analyserCleanup = cleanup ?? null;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    const now = this.now();
    this.startTimestamp = now;
    this.lastFrameTimestamp = now;
    this.scheduleNextBlink(now);
    this.scheduleFrame();
  }

  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.frameHandle !== null) {
      this.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
  }

  async destroy(): Promise<void> {
    this.stop();
    await this.cleanupAnalyser();
  }

  private async cleanupAnalyser(): Promise<void> {
    const cleanup = this.analyserCleanup;
    this.analyserCleanup = null;
    this.analyser = null;
    this.analyserBuffer = null;
    this.currentStream = null;

    if (cleanup) {
      try {
        await cleanup();
      } catch (error) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private scheduleFrame(): void {
    if (!this.running) {
      return;
    }

    this.frameHandle = this.scheduler.request(this.handleFrame);
  }

  private handleFrame = (): void => {
    if (!this.running) {
      return;
    }

    this.frameHandle = null;
    const now = this.now();
    const deltaMs = Math.max(this.frameIntervalMs, now - this.lastFrameTimestamp);

    let rawIntensity = 0;

    if (this.analyser && this.analyserBuffer) {
      try {
        this.analyser.getFloatTimeDomainData(this.analyserBuffer);
        const rms = calculateRms(this.analyserBuffer);
        const normalized = normalizeAudioLevel(rms);
        rawIntensity = this.applyIntensityCurve(normalized);
      } catch (error) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        rawIntensity = 0;
      }
    }

    this.smoothedIntensity = this.applySmoothing(this.smoothedIntensity, rawIntensity, deltaMs);
    const visemeIndex = this.mapIntensityToViseme(this.smoothedIntensity);
    const blink = this.evaluateBlink(now, this.smoothedIntensity);

    const frame: VisemeFrame = {
      t: Math.max(0, now - this.startTimestamp),
      index: visemeIndex,
      intensity: this.smoothedIntensity,
      ...(blink ? { blink: true } : {}),
    };

    this.callbacks.onFrame?.(frame);

    this.lastFrameTimestamp = now;
    this.scheduleFrame();
  };

  private applyIntensityCurve(value: number): number {
    if (!Number.isFinite(value) || value <= this.noiseFloor) {
      return 0;
    }

    const normalized = Math.min(1, Math.max(0, (value - this.noiseFloor) / (1 - this.noiseFloor)));
    return Math.pow(normalized, this.intensityExponent);
  }

  private applySmoothing(previous: number, target: number, deltaMs: number): number {
    if (!Number.isFinite(previous)) {
      previous = 0;
    }

    if (!Number.isFinite(target)) {
      target = 0;
    }

    if (deltaMs <= 0) {
      return target;
    }

    const window = target > previous ? this.attackMs : this.releaseMs;
    const alpha = Math.min(1, deltaMs / window);
    return previous + (target - previous) * alpha;
  }

  private mapIntensityToViseme(intensity: number): number {
    for (let index = 0; index < this.thresholds.length; index += 1) {
      if (intensity < this.thresholds[index]) {
        return index;
      }
    }

    return this.thresholds.length;
  }

  private evaluateBlink(now: number, intensity: number): boolean {
    if (intensity > this.blinkMaxIntensity) {
      this.nextBlinkAt = Math.max(this.nextBlinkAt, now + this.blinkSuppressionMs);
      return false;
    }

    if (this.nextBlinkAt === 0) {
      this.scheduleNextBlink(now);
      return false;
    }

    if (now < this.nextBlinkAt) {
      return false;
    }

    this.scheduleNextBlink(now);
    return true;
  }

  private scheduleNextBlink(reference: number): void {
    const [min, max] = this.blinkIntervalRange;
    const span = Math.max(0, max - min);
    const jitter = span === 0 ? 0 : this.random() * span;
    this.nextBlinkAt = reference + min + jitter;
  }
}
