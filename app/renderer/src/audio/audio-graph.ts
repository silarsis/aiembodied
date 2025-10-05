import { calculateRms, normalizeAudioLevel } from './metrics.js';
import { VadController } from './vad-controller.js';

export interface AudioGraphCallbacks {
  onLevel?: (level: number) => void;
  onSpeechActivityChange?: (isActive: boolean) => void;
}

export interface AudioGraphStartOptions {
  inputDeviceId?: string;
}

export class AudioGraph {
  private audioContext: AudioContext | null = null;
  private inputStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private upstreamDestination: MediaStreamAudioDestinationNode | null = null;
  private gateNode: GainNode | null = null;
  private levelAnalyser: AnalyserNode | null = null;
  private visemeAnalyser: AnalyserNode | null = null;
  private levelBuffer: (Float32Array & { buffer: ArrayBuffer }) | null = null;
  private levelInterval: number | null = null;
  private readonly vad = new VadController({ activationThreshold: 0.08, releaseMs: 250 });

  constructor(private readonly callbacks: AudioGraphCallbacks = {}) {}

  async start(options: AudioGraphStartOptions = {}): Promise<void> {
    await this.stop();

    const audioContextCtor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext) as typeof AudioContext | undefined;

    if (!audioContextCtor) {
      throw new Error('Web Audio API is not available in this environment.');
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Media devices API is not available.');
    }

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: options.inputDeviceId ? { exact: options.inputDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const context = new audioContextCtor();
    await context.resume();

    const source = context.createMediaStreamSource(stream);
    const gateNode = context.createGain();
    gateNode.gain.value = 0;

    const destination = context.createMediaStreamDestination();
    gateNode.connect(destination);
    source.connect(gateNode);

    const levelAnalyser = context.createAnalyser();
    levelAnalyser.fftSize = 2048;
    levelAnalyser.smoothingTimeConstant = 0.7;
    source.connect(levelAnalyser);

    const visemeAnalyser = context.createAnalyser();
    visemeAnalyser.fftSize = 2048;
    visemeAnalyser.smoothingTimeConstant = 0.5;
    source.connect(visemeAnalyser);

    this.audioContext = context;
    this.inputStream = stream;
    this.sourceNode = source;
    this.gateNode = gateNode;
    this.upstreamDestination = destination;
    this.levelAnalyser = levelAnalyser;
    this.visemeAnalyser = visemeAnalyser;
    this.levelBuffer = new Float32Array(
      new ArrayBuffer(levelAnalyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
    ) as Float32Array & { buffer: ArrayBuffer };

    this.startLevelMonitor();
  }

  async stop(): Promise<void> {
    if (this.levelInterval !== null) {
      window.clearInterval(this.levelInterval);
      this.levelInterval = null;
    }

    this.vad.reset();

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.gateNode) {
      this.gateNode.disconnect();
      this.gateNode = null;
    }

    if (this.upstreamDestination) {
      this.upstreamDestination.disconnect();
      this.upstreamDestination = null;
    }

    if (this.levelAnalyser) {
      this.levelAnalyser.disconnect();
      this.levelAnalyser = null;
    }

    if (this.visemeAnalyser) {
      this.visemeAnalyser.disconnect();
      this.visemeAnalyser = null;
    }

    if (this.inputStream) {
      for (const track of this.inputStream.getTracks()) {
        track.stop();
      }
      this.inputStream = null;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.levelBuffer = null;
  }

  getUpstreamStream(): MediaStream | null {
    return this.upstreamDestination?.stream ?? null;
  }

  getVisemeAnalyser(): AnalyserNode | null {
    return this.visemeAnalyser;
  }

  private startLevelMonitor() {
    if (!this.levelAnalyser || !this.levelBuffer) {
      return;
    }

    const analyser = this.levelAnalyser;
    const buffer = this.levelBuffer as unknown as Float32Array;

    const tick = () => {
      (analyser.getFloatTimeDomainData as unknown as (data: Float32Array) => void)(buffer);
      const rms = calculateRms(buffer);
      const normalized = normalizeAudioLevel(rms);

      if (this.callbacks.onLevel) {
        this.callbacks.onLevel(normalized);
      }

      const { isActive, changed } = this.vad.update(normalized, performance.now());

      if (changed) {
        this.applyGateState(isActive);
        this.callbacks.onSpeechActivityChange?.(isActive);
      }
    };

    this.levelInterval = window.setInterval(tick, 50);
  }

  private applyGateState(active: boolean) {
    if (!this.gateNode || !this.audioContext) {
      return;
    }

    const gain = this.gateNode.gain;
    const targetValue = active ? 1 : 0;
    const now = this.audioContext.currentTime;
    if (typeof gain.setTargetAtTime === 'function') {
      gain.setTargetAtTime(targetValue, now, 0.05);
    } else {
      gain.setValueAtTime(targetValue, now);
    }
  }
}
