/**
 * Microphone in and speech out for the phone page.
 *
 * The phone loads this page from the desktop over plain http on the LAN, which browsers do not
 * treat as a secure context, so getUserMedia is unavailable there. The Android app records the
 * mic natively and hands 16 kHz PCM to the page through `window.companionNative`. In a desktop
 * browser (http://localhost is secure) the page uses getUserMedia instead, which is handy for
 * trying the page without a phone.
 */
import { decodePcm16Base64 } from './speech-detector.js';

export type SamplesListener = (samples: Float32Array, sampleRate: number) => void;

export interface Microphone {
  readonly kind: 'android' | 'browser';
  start(listener: SamplesListener, onError: (message: string) => void): Promise<void>;
  stop(): void;
}

/** What the Android app exposes to the page (see MainActivity.kt). */
export interface AndroidCompanionBridge {
  startMic(): void;
  stopMic(): void;
  openSettings(): void;
  /** Keep the screen on (true while the page is up). */
  setKeepScreenOn?(on: boolean): void;
}

/** What the page exposes to the Android app. */
export interface CompanionNativeCallbacks {
  onAudio(base64Pcm16: string, sampleRate: number): void;
  onMicError(message: string): void;
  /** The app came back to the foreground. */
  onResume?(): void;
}

declare global {
  interface Window {
    AndroidCompanion?: AndroidCompanionBridge;
    companionNative?: CompanionNativeCallbacks;
  }
}

export function getAndroidBridge(): AndroidCompanionBridge | null {
  return typeof window !== 'undefined' && window.AndroidCompanion ? window.AndroidCompanion : null;
}

class AndroidMicrophone implements Microphone {
  readonly kind = 'android' as const;

  constructor(private readonly bridge: AndroidCompanionBridge) {}

  async start(listener: SamplesListener, onError: (message: string) => void): Promise<void> {
    window.companionNative = {
      ...window.companionNative,
      onAudio: (base64, sampleRate) => listener(decodePcm16Base64(base64), sampleRate),
      onMicError: onError,
    };
    this.bridge.startMic();
  }

  stop(): void {
    this.bridge.stopMic();
  }
}

class BrowserMicrophone implements Microphone {
  readonly kind = 'browser' as const;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;

  async start(listener: SamplesListener, onError: (message: string) => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError('This page needs the Android app (or a browser on localhost) to use the microphone.');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      return;
    }
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(this.stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    processor.onaudioprocess = (event) => listener(Float32Array.from(event.inputBuffer.getChannelData(0)), context.sampleRate);
    this.context = context;
    this.processor = processor;
  }

  stop(): void {
    if (this.processor) this.processor.onaudioprocess = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.stream = null;
    this.context = null;
    this.processor = null;
  }
}

export function createMicrophone(): Microphone {
  const bridge = getAndroidBridge();
  return bridge ? new AndroidMicrophone(bridge) : new BrowserMicrophone();
}

/**
 * Plays reply sentences back to back. Each sentence's `onStart` runs as its audio starts, so
 * avatar tags in it fire in step with the words. The audio also goes to `stream`, which the
 * lip-sync driver listens to.
 */
export class SpeechPlayer {
  private context: AudioContext | null = null;
  private output: MediaStreamAudioDestinationNode | null = null;
  private playhead = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly timers = new Set<number>();
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private endTimer: number | null = null;
  private endWaiters: Array<() => void> = [];

  /** Create (or wake) the audio context; call from a tap so autoplay rules are met. */
  unlock(): MediaStream {
    if (!this.context) {
      this.context = new AudioContext();
      this.output = this.context.createMediaStreamDestination();
    }
    void this.context.resume();
    return (this.output as MediaStreamAudioDestinationNode).stream;
  }

  get stream(): MediaStream | null {
    return this.output?.stream ?? null;
  }

  get playing(): boolean {
    return this.context !== null && (this.sources.size > 0 || this.playhead > this.context.currentTime);
  }

  /** Queue a sentence (base64 WAV, possibly empty for a sentence that is only tags). */
  enqueue(wavBase64: string, onStart: () => void): void {
    this.unlock();
    const generation = this.generation;
    this.chain = this.chain.then(async () => {
      const context = this.context;
      const output = this.output;
      if (!context || !output || generation !== this.generation) return;
      let buffer: AudioBuffer | null = null;
      if (wavBase64) {
        try {
          buffer = await context.decodeAudioData(base64ToArrayBuffer(wavBase64));
        } catch (error) {
          console.warn('[companion] could not decode a sentence', error);
        }
      }
      if (generation !== this.generation) return;
      const startAt = Math.max(context.currentTime + 0.05, this.playhead);
      const delayMs = Math.max(0, (startAt - context.currentTime) * 1000);
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        onStart();
      }, delayMs);
      this.timers.add(timer);
      if (!buffer) {
        this.scheduleEnd();
        return;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.connect(output);
      source.onended = () => {
        this.sources.delete(source);
        this.scheduleEnd();
      };
      this.sources.add(source);
      source.start(startAt);
      this.playhead = startAt + buffer.duration;
    });
  }

  /** Resolves once everything queued so far has played. */
  async finished(): Promise<void> {
    await this.chain;
    if (!this.playing && this.timers.size === 0) return;
    await new Promise<void>((resolve) => {
      this.endWaiters.push(resolve);
      this.scheduleEnd();
    });
  }

  /** Stop speaking now and drop anything queued. */
  stop(): void {
    this.generation += 1;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear();
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.playhead = 0;
    this.chain = Promise.resolve();
    this.resolveEnd();
  }

  private scheduleEnd(): void {
    if (this.endTimer !== null) window.clearTimeout(this.endTimer);
    this.endTimer = window.setTimeout(() => {
      this.endTimer = null;
      if (this.playing || this.timers.size > 0) {
        this.scheduleEnd();
      } else {
        this.resolveEnd();
      }
    }, 150);
  }

  private resolveEnd(): void {
    const waiters = this.endWaiters;
    this.endWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
