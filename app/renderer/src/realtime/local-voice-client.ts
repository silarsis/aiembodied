/**
 * Drop-in alternative to RealtimeClient that runs the conversation on this machine:
 * the gated microphone stream is cut into utterances here, the main process runs
 * speech-to-text -> local LLM (Qwen via llama-server) -> text-to-speech, and the reply's
 * audio is played into a MediaStream so the audio element and lip sync work unchanged.
 *
 * Half duplex: while the avatar speaks (and briefly after) the microphone is ignored, since
 * speaker echo would otherwise be heard as a new utterance. Set `bargeIn` to let speech
 * interrupt the reply instead.
 */
import type { LocalVoiceBridge } from '../preload-api.js';
import type { LocalVoiceEvent } from '../../../main/src/voice/types.js';
import type { RealtimeClientCallbacks, RealtimeClientOptions, RealtimeClientState } from './realtime-client.js';
import { pcm16ToFloat, UtteranceDetector, type UtteranceDetectorOptions } from './utterance-detector.js';

export interface LocalVoiceClientCallbacks extends RealtimeClientCallbacks {
  onUserTranscript?: (text: string) => void;
  onAssistantReply?: (text: string) => void;
}

export interface LocalVoiceClientOptions {
  /** Looked up on each use, so a bridge that attaches late is still found. */
  getBridge: () => LocalVoiceBridge | null | undefined;
  callbacks?: LocalVoiceClientCallbacks;
  sessionConfig?: RealtimeClientOptions['sessionConfig'];
  detector?: UtteranceDetectorOptions;
  bargeIn?: boolean;
  /** Mic stays ignored this long after the reply finishes playing (half duplex only). */
  echoTailMs?: number;
  createAudioContext?: (options?: AudioContextOptions) => AudioContext;
}

const CAPTURE_SAMPLE_RATE = 16000;
const CAPTURE_FRAME = 1024;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalVoiceClient {
  private readonly getBridge: () => LocalVoiceBridge | null | undefined;
  private readonly callbacks: LocalVoiceClientCallbacks;
  private readonly detectorOptions: UtteranceDetectorOptions;
  private readonly bargeIn: boolean;
  private readonly echoTailMs: number;
  private readonly createAudioContext: (options?: AudioContextOptions) => AudioContext;
  private sessionConfig: RealtimeClientOptions['sessionConfig'];
  private state: RealtimeClientState = { status: 'idle' };
  private captureContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  private playbackContext: AudioContext | null = null;
  private playbackDestination: MediaStreamAudioDestinationNode | null = null;
  private playingSources = new Set<AudioBufferSourceNode>();
  private nextPlaybackTime = 0;
  private mutedUntil = 0;
  private detector: UtteranceDetector | null = null;
  private unsubscribe: (() => void) | null = null;
  private currentTurnId: string | null = null;
  private firstAudioPending = false;
  private turnCounter = 0;
  private disposed = false;

  constructor(options: LocalVoiceClientOptions) {
    this.getBridge = options.getBridge;
    this.callbacks = options.callbacks ?? {};
    this.sessionConfig = options.sessionConfig;
    this.detectorOptions = options.detector ?? {};
    this.bargeIn = options.bargeIn ?? false;
    this.echoTailMs = options.echoTailMs ?? 400;
    this.createAudioContext = options.createAudioContext ?? ((contextOptions) => new AudioContext(contextOptions));
  }

  getState(): RealtimeClientState {
    return this.state;
  }

  getRemoteStream(): MediaStream | null {
    return this.playbackDestination?.stream ?? null;
  }

  // RealtimeClient API kept for App.tsx; these have nothing to do locally.
  bindRemoteAudioElement(): void {}
  setJitterBufferMs(): void {}
  setReconnectApiKeyProvider(): void {}
  notifySpeechActivity(): void {}

  updateSessionConfig(next: RealtimeClientOptions['sessionConfig']): void {
    this.sessionConfig = { ...this.sessionConfig, ...next };
    if (typeof next?.vad?.silenceDurationMs === 'number' && next.vad.silenceDurationMs > 0) {
      this.detectorOptions.endSilenceMs = next.vad.silenceDurationMs;
    }
  }

  getSessionConfigSnapshot(): Record<string, unknown> {
    return { instructions: this.sessionConfig?.instructions };
  }

  async connect(options: { apiKey?: string; inputStream: MediaStream }): Promise<void> {
    if (this.disposed) {
      throw new Error('Local voice client has been destroyed.');
    }
    await this.disconnect();
    this.updateState({ status: 'connecting' });

    const bridge = this.getBridge();
    if (!bridge) {
      this.updateState({ status: 'error', error: 'Local voice bridge unavailable.' });
      throw new Error('Local voice bridge unavailable.');
    }

    const status = await bridge.getStatus();
    if (!status?.llm.available) {
      const error = `Local LLM not reachable at ${status?.llm.baseUrl ?? 'the configured URL'} (is llama-server running?)`;
      this.updateState({ status: 'error', error });
      throw new Error(error);
    }
    if (!status.speech.ready) {
      const error = status.speech.available
        ? 'Voice service is still loading its models.'
        : 'Voice service not reachable (start services/voice).';
      this.updateState({ status: 'error', error });
      throw new Error(error);
    }

    this.unsubscribe = bridge.onEvent((event) => this.handleEvent(event));

    const playback = this.createAudioContext();
    this.playbackContext = playback;
    this.playbackDestination = playback.createMediaStreamDestination();
    this.nextPlaybackTime = 0;
    this.callbacks.onRemoteStream?.(this.playbackDestination.stream);

    // Chromium resamples the stream to the context's rate, so capture runs at 16 kHz directly.
    const capture = this.createAudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
    const source = capture.createMediaStreamSource(options.inputStream);
    const processor = capture.createScriptProcessor(CAPTURE_FRAME, 1, 1);
    this.detector = new UtteranceDetector(
      {
        onSpeechStart: () => {
          if (this.bargeIn && this.isPlaying()) {
            this.interrupt();
          }
        },
        onUtterance: (pcm) => {
          void this.submitTurn(pcm);
        },
      },
      { ...this.detectorOptions, sampleRate: capture.sampleRate },
    );
    processor.onaudioprocess = (event) => {
      if (!this.bargeIn && (this.isPlaying() || performance.now() < this.mutedUntil)) {
        this.detector?.reset();
        return;
      }
      this.detector?.push(event.inputBuffer.getChannelData(0));
    };
    source.connect(processor);
    // A ScriptProcessor only runs while connected to the destination; it outputs silence.
    processor.connect(capture.destination);
    this.captureContext = capture;
    this.captureSource = source;
    this.captureProcessor = processor;

    this.log('info', 'Local voice chain connected.', status);
    this.updateState({ status: 'connected' });
  }

  async disconnect(): Promise<void> {
    this.interrupt();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detector?.reset();
    this.detector = null;
    if (this.captureProcessor) {
      this.captureProcessor.onaudioprocess = null;
      this.captureProcessor.disconnect();
    }
    this.captureSource?.disconnect();
    this.captureProcessor = null;
    this.captureSource = null;
    const contexts = [this.captureContext, this.playbackContext];
    this.captureContext = null;
    this.playbackContext = null;
    this.playbackDestination = null;
    await Promise.all(contexts.map((context) => context?.close().catch(() => undefined)));
    if (this.state.status !== 'idle') {
      this.updateState({ status: 'idle' });
    }
  }

  async destroy(): Promise<void> {
    this.disposed = true;
    await this.disconnect();
  }

  /** Stops the reply that is playing and cancels its generation. */
  interrupt(): void {
    for (const source of this.playingSources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.playingSources.clear();
    this.nextPlaybackTime = 0;
    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    if (turnId) {
      void this.getBridge()?.cancelTurn(turnId).catch(() => undefined);
    }
  }

  private isPlaying(): boolean {
    return this.playingSources.size > 0;
  }

  private async submitTurn(pcm: Uint8Array): Promise<void> {
    const bridge = this.getBridge();
    if (!bridge) {
      return;
    }
    this.turnCounter += 1;
    const turnId = `local-${Date.now().toString(36)}-${this.turnCounter}`;
    this.currentTurnId = turnId;
    this.firstAudioPending = true;
    try {
      const result = await bridge.runTurn({
        turnId,
        audio: pcm,
        instructions: this.sessionConfig?.instructions,
      });
      if (result.text && !result.cancelled) {
        this.callbacks.onAssistantReply?.(result.text);
      }
      this.log('info', 'Local voice turn finished.', result.timings);
    } catch (error) {
      this.log('error', 'Local voice turn failed.', describeError(error));
    } finally {
      if (this.currentTurnId === turnId) {
        this.currentTurnId = null;
      }
    }
  }

  private handleEvent(event: LocalVoiceEvent): void {
    if (event.turnId !== this.currentTurnId) {
      return;
    }
    if (event.type === 'transcript') {
      this.callbacks.onUserTranscript?.(event.text);
    } else if (event.type === 'text') {
      this.callbacks.onTextContent?.(event.text);
    } else if (event.type === 'audio') {
      this.playAudio(event.data, event.sampleRate);
    }
  }

  private playAudio(data: Uint8Array, sampleRate: number): void {
    const context = this.playbackContext;
    const destination = this.playbackDestination;
    if (!context || !destination) {
      return;
    }
    const samples = pcm16ToFloat(data);
    if (samples.length === 0) {
      return;
    }
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const startAt = Math.max(context.currentTime + 0.05, this.nextPlaybackTime);
    this.nextPlaybackTime = startAt + buffer.duration;
    this.playingSources.add(source);
    source.onended = () => {
      this.playingSources.delete(source);
      if (this.playingSources.size === 0) {
        this.mutedUntil = performance.now() + this.echoTailMs;
      }
    };
    source.start(startAt);
    if (this.firstAudioPending) {
      this.firstAudioPending = false;
      this.callbacks.onFirstAudioFrame?.();
    }
  }

  private updateState(state: RealtimeClientState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    this.callbacks.onLog?.({ level, message, data });
  }
}
