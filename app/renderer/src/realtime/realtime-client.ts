export type RealtimeClientStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface RealtimeClientState {
  status: RealtimeClientStatus;
  attempt?: number;
  error?: string;
}

export interface RealtimeClientCallbacks {
  onStateChange?: (state: RealtimeClientState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onLog?: (entry: { level: 'info' | 'warn' | 'error'; message: string; data?: unknown }) => void;
  onFirstAudioFrame?: () => void;
}

export interface RealtimeClientOptions {
  endpoint?: string;
  model?: string;
  fetchFn?: typeof fetch;
  createPeerConnection?: (config?: RTCConfiguration) => RTCPeerConnection;
  callbacks?: RealtimeClientCallbacks;
  reconnectDelaysMs?: number[];
  jitterBufferMs?: number;
  maxReconnectAttempts?: number;
}

export interface RealtimeClientConnectOptions {
  apiKey: string;
  inputStream: MediaStream;
  iceServers?: RTCIceServer[];
}

type NegotiationAnswer = {
  sdp: string;
  type?: RTCSdpType;
};

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function isHtmlMediaWithSink(
  element: HTMLMediaElement,
): element is HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> } {
  return typeof (element as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === 'function';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown realtime client error';
}

export class RealtimeClient {
  private readonly endpoint: string;

  private readonly model: string;

  private readonly fetchFn: typeof fetch;

  private readonly createPeerConnectionFn: (config?: RTCConfiguration) => RTCPeerConnection;

  private readonly reconnectDelays: number[];

  private readonly callbacks: RealtimeClientCallbacks;

  private readonly maxReconnectAttempts: number;

  private state: RealtimeClientState = { status: 'idle' };

  private currentStream: MediaStream | null = null;

  private currentApiKey: string | null = null;

  private currentIceServers: RTCIceServer[] | null = null;

  private peer: RTCPeerConnection | null = null;

  private controlChannel: RTCDataChannel | null = null;

  private remoteStream: MediaStream | null = null;

  private remoteAudioElement: HTMLAudioElement | null = null;

  private outputDeviceId: string | null = null;

  private reconnectInFlight = false;

  private reconnectAttempts = 0;

  private shouldReconnect = false;

  private disposed = false;

  private jitterBufferMs: number;

  constructor(options: RealtimeClientOptions = {}) {
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/realtime/sessions';
    this.model = options.model ?? 'gpt-4o-realtime-preview-2024-12-17';
    this.fetchFn = options.fetchFn ?? window.fetch.bind(window);
    this.createPeerConnectionFn = options.createPeerConnection ?? ((config?: RTCConfiguration) => new RTCPeerConnection(config));
    this.reconnectDelays = options.reconnectDelaysMs ?? [750, 1500, 3000];
    this.callbacks = options.callbacks ?? {};
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Math.max(this.reconnectDelays.length, 3);
    this.jitterBufferMs = options.jitterBufferMs ?? 100;
  }

  getState(): RealtimeClientState {
    return this.state;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  bindRemoteAudioElement(element: HTMLAudioElement | null): void {
    this.remoteAudioElement = element;
    if (element && this.remoteStream) {
      element.srcObject = this.remoteStream;
      void element.play().catch((error: unknown) => {
        this.log('warn', 'Failed to autoplay realtime audio', error);
      });
      void this.applyOutputDevice();
    }
  }

  async setOutputDeviceId(deviceId?: string): Promise<void> {
    this.outputDeviceId = deviceId ?? null;
    await this.applyOutputDevice();
  }

  setJitterBufferMs(value: number): void {
    this.jitterBufferMs = value;
    this.applyJitterBufferHint();
  }

  async connect(options: RealtimeClientConnectOptions): Promise<void> {
    if (this.disposed) {
      throw new Error('Realtime client has been disposed.');
    }

    if (!options.apiKey) {
      throw new Error('Realtime API key is required to establish a connection.');
    }

    this.currentApiKey = options.apiKey;
    this.currentStream = options.inputStream;
    this.currentIceServers = options.iceServers ?? null;
    this.reconnectAttempts = 0;
    this.shouldReconnect = true;

    this.updateState({ status: 'connecting' });

    try {
      await this.establishConnection(options);
    } catch (error) {
      const message = describeError(error);
      this.updateState({ status: 'error', error: message });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    this.reconnectAttempts = 0;
    this.reconnectInFlight = false;
    this.currentStream = null;
    this.currentApiKey = null;
    this.currentIceServers = null;
    this.cleanupPeer();
    this.updateState({ status: 'idle' });
  }

  async destroy(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    await this.disconnect();
  }

  notifySpeechActivity(active: boolean): void {
    if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
      return;
    }

    const payload = JSON.stringify({ type: active ? 'user_speech_start' : 'user_speech_stop' });
    try {
      this.controlChannel.send(payload);
    } catch (error) {
      this.log('warn', 'Failed to send speech activity update', error);
    }
  }

  private async establishConnection(options: RealtimeClientConnectOptions): Promise<void> {
    if (!this.currentStream) {
      throw new Error('No microphone stream available for realtime connection.');
    }

    this.cleanupPeer();

    const configuration: RTCConfiguration | undefined = options.iceServers?.length
      ? { iceServers: options.iceServers }
      : undefined;
    const peer = this.createPeerConnectionFn(configuration);
    this.peer = peer;

    peer.onconnectionstatechange = () => {
      this.handleConnectionStateChange();
    };

    peer.onicecandidate = (event) => {
      if (!event.candidate) {
        this.log('info', 'ICE candidate gathering complete');
      }
    };

    peer.ontrack = (event) => {
      this.handleRemoteTrack(event);
    };

    try {
      for (const track of this.currentStream.getTracks()) {
        peer.addTrack(track, this.currentStream);
      }
    } catch (error) {
      this.log('warn', 'Failed to add input tracks to realtime peer connection', error);
    }

    try {
      peer.addTransceiver('audio', { direction: 'recvonly' });
    } catch (error) {
      this.log('info', 'Failed to add recvonly audio transceiver (may be unsupported)', error);
    }

    try {
      this.controlChannel = peer.createDataChannel('oai-events', { ordered: true });
    } catch (error) {
      this.log('warn', 'Failed to create realtime control data channel', error);
      this.controlChannel = null;
    }

    await this.exchangeOffer(peer, options.apiKey);
  }

  private async exchangeOffer(peer: RTCPeerConnection, apiKey: string): Promise<void> {
    const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    await peer.setLocalDescription(offer);

    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Required by OpenAI Realtime HTTP negotiation
        'OpenAI-Beta': 'realtime=v1',
      },
      body: JSON.stringify({
        model: this.model,
        offer: { type: offer.type, sdp: offer.sdp },
      }),
    });

    if (!response.ok) {
      let detail: string | undefined;
      try {
        detail = await response.text();
      } catch {
        // ignore body read errors
      }
      throw new Error(`Realtime handshake failed: HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    const { answer, iceServers } = this.parseNegotiationResponse(await response.json());

    await peer.setRemoteDescription({ type: answer.type ?? 'answer', sdp: answer.sdp });

    if (iceServers?.length) {
      this.log('info', 'Realtime API suggested ICE servers after negotiation', iceServers);
      this.currentIceServers = iceServers;
    }
  }

  private handleRemoteTrack(event: RTCTrackEvent): void {
    const stream = event.streams?.[0] ?? new MediaStream([event.track]);
    this.remoteStream = stream;

    this.applyJitterBufferHint();

    const element = this.remoteAudioElement;
    if (element) {
      element.srcObject = stream;
      void element.play().catch((error: unknown) => {
        this.log('warn', 'Failed to start realtime audio playback', error);
      });
      void this.applyOutputDevice();
    }

    this.callbacks.onRemoteStream?.(stream);

    const track = event.track;
    if (track) {
      if (!track.muted) {
        this.callbacks.onFirstAudioFrame?.();
      } else {
        const handleUnmute = () => {
          track.removeEventListener('unmute', handleUnmute);
          this.callbacks.onFirstAudioFrame?.();
        };
        track.addEventListener('unmute', handleUnmute, { once: true });
      }
    }
  }

  private handleConnectionStateChange(): void {
    if (!this.peer) {
      return;
    }

    const state = this.peer.connectionState;
    switch (state) {
      case 'connected':
        this.reconnectAttempts = 0;
        this.reconnectInFlight = false;
        this.updateState({ status: 'connected' });
        break;
      case 'disconnected':
      case 'failed':
        if (this.shouldReconnect) {
          void this.scheduleReconnect();
        }
        break;
      case 'closed':
        if (!this.shouldReconnect) {
          this.updateState({ status: 'idle' });
        }
        break;
      default:
        this.log('info', `Realtime peer connection state changed: ${state}`);
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectInFlight || !this.currentStream || !this.currentApiKey) {
      return;
    }

    const nextAttempt = this.reconnectAttempts + 1;
    if (nextAttempt > this.maxReconnectAttempts) {
      this.updateState({ status: 'error', error: 'Realtime connection lost after multiple attempts.' });
      this.shouldReconnect = false;
      return;
    }

    this.reconnectInFlight = true;
    const delay = this.reconnectDelays[Math.min(nextAttempt - 1, this.reconnectDelays.length - 1)];
    this.updateState({ status: 'reconnecting', attempt: nextAttempt });

    await wait(delay);

    this.reconnectAttempts = nextAttempt;

    try {
      await this.establishConnection({
        apiKey: this.currentApiKey,
        inputStream: this.currentStream,
        iceServers: this.currentIceServers ?? undefined,
      });
    } catch (error) {
      const message = describeError(error);
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.updateState({ status: 'error', error: `Realtime reconnection failed: ${message}` });
        this.shouldReconnect = false;
      } else {
        this.log('warn', 'Realtime reconnection attempt failed', error);
        this.reconnectInFlight = false;
        void this.scheduleReconnect();
        return;
      }
    }

    this.reconnectInFlight = false;
  }

  private applyJitterBufferHint(): void {
    if (!this.peer) {
      return;
    }

    const receivers = this.peer.getReceivers?.() ?? [];
    for (const receiver of receivers) {
      const withHint = receiver as RTCRtpReceiver & { playoutDelayHint?: number };
      if (withHint.track?.kind === 'audio' && typeof withHint.playoutDelayHint === 'number') {
        withHint.playoutDelayHint = this.jitterBufferMs / 1000;
      }
    }
  }

  private parseNegotiationResponse(value: unknown): { answer: NegotiationAnswer; iceServers?: RTCIceServer[] } {
    if (!value || typeof value !== 'object') {
      throw new Error('Realtime handshake response missing SDP answer.');
    }

    const payload = value as {
      answer?: unknown;
      sdp?: unknown;
      type?: unknown;
      iceServers?: unknown;
    };

    const answer = this.resolveNegotiationAnswer(payload);
    const iceServers = Array.isArray(payload.iceServers) ? (payload.iceServers as RTCIceServer[]) : undefined;

    return { answer, iceServers };
  }

  private resolveNegotiationAnswer(payload: { answer?: unknown; sdp?: unknown; type?: unknown }): NegotiationAnswer {
    const candidate = payload.answer ?? payload;
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('Realtime handshake response missing SDP answer.');
    }

    const answer = candidate as { sdp?: unknown; type?: unknown };
    if (typeof answer.sdp !== 'string') {
      throw new Error('Realtime handshake response missing SDP answer.');
    }

    const type = typeof answer.type === 'string' ? (answer.type as RTCSdpType) : undefined;

    return { sdp: answer.sdp, type };
  }

  private async applyOutputDevice(): Promise<void> {
    const element = this.remoteAudioElement;
    if (!element) {
      return;
    }

    if (!isHtmlMediaWithSink(element)) {
      return;
    }

    try {
      await element.setSinkId(this.outputDeviceId ?? 'default');
    } catch (error) {
      this.log('warn', 'Failed to route realtime audio to preferred output device', error);
    }
  }

  private cleanupPeer(): void {
    if (this.controlChannel) {
      try {
        this.controlChannel.close();
      } catch (error) {
        this.log('warn', 'Failed to close realtime control channel', error);
      }
      this.controlChannel = null;
    }

    if (this.peer) {
      try {
        this.peer.close();
      } catch (error) {
        this.log('warn', 'Error while closing realtime peer connection', error);
      }
      this.peer = null;
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
