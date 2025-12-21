export type RealtimeClientStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface RealtimeClientState {
  status: RealtimeClientStatus;
  attempt?: number;
  error?: string;
}

export interface RealtimeClientCallbacks {
  onStateChange?: (state: RealtimeClientState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onLog?: (entry: {
    level: 'info' | 'warn' | 'error';
    message: string;
    data?: unknown;
    json?: string;
  }) => void;
  onFirstAudioFrame?: () => void;
  onSessionUpdated?: (session: { voice?: string; instructions?: string; turnDetection?: string }) => void;
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
  // Handshake content type: default JSON; some deployments require application/sdp
  handshakeMode?: 'json' | 'sdp';
  sessionConfig?: {
    instructions?: string;
    turnDetection?: 'none' | 'server_vad';
    vad?: { threshold?: number; silenceDurationMs?: number; minSpeechDurationMs?: number };
    voice?: string;
    modalities?: string[];
    inputAudioFormat?: { type: string; sampleRateHz?: number; channels?: number };
    sessionParameters?: Record<string, unknown>;
  };
}

export interface RealtimeClientConnectOptions {
  apiKey: string;
  inputStream: MediaStream;
  iceServers?: RTCIceServer[];
}

// Note: older code used a typed negotiation answer; currently unused.

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
  private sessionConfig?: RealtimeClientOptions['sessionConfig'];
  private handshakeMode: 'json' | 'sdp';
  constructor(options: RealtimeClientOptions = {}) {
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/realtime/calls';
    this.model = options.model ?? 'gpt-4o-realtime-preview-2024-12-17';
    this.fetchFn = options.fetchFn ?? window.fetch.bind(window);
    this.createPeerConnectionFn = options.createPeerConnection ?? ((config?: RTCConfiguration) => new RTCPeerConnection(config));
    this.reconnectDelays = options.reconnectDelaysMs ?? [750, 1500, 3000];
    this.callbacks = options.callbacks ?? {};
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Math.max(this.reconnectDelays.length, 3);
    this.jitterBufferMs = options.jitterBufferMs ?? 100;
    this.sessionConfig = options.sessionConfig;
    this.handshakeMode = options.handshakeMode ?? 'json';
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

    this.log('info', 'Realtime connect requested', {
      hasStream: Boolean(options.inputStream),
      hasIceServers: Boolean(options.iceServers?.length),
    });

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
    this.log('info', 'Realtime disconnect requested');
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

    peer.onconnectionstatechange = (event) => {
      this.log('info', 'Realtime peer connection state change event', {
        state: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        event,
      });
      this.handleConnectionStateChange();
    };

    peer.oniceconnectionstatechange = (event) => {
      this.log('info', 'Realtime ICE connection state change', {
        state: peer.iceConnectionState,
        event,
      });
    };

    peer.onicegatheringstatechange = (event) => {
      this.log('info', 'Realtime ICE gathering state change', {
        state: peer.iceGatheringState,
        event,
      });
    };

    peer.onsignalingstatechange = (event) => {
      this.log('info', 'Realtime signaling state change', {
        state: peer.signalingState,
        event,
      });
    };

    peer.onicecandidate = (event) => {
      this.log('info', 'Realtime ICE candidate event', {
        candidate: event.candidate,
        event,
      });
      if (!event.candidate) {
        this.log('info', 'ICE candidate gathering complete');
      }
    };

    peer.ontrack = (event) => {
      this.log('info', 'Realtime track event received', event);
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
      this.controlChannel.onopen = (event) => {
        this.log('info', 'Realtime control data channel opened', event);
        this.sendSessionUpdate();
      };
      this.controlChannel.onclose = (event) => {
        this.log('warn', 'Realtime control data channel closed', event);
      };
      this.controlChannel.onerror = (event) => {
        this.log('warn', 'Realtime control data channel error', event);
      };
      this.controlChannel.onmessage = (event) => {
        this.log('info', 'Realtime control channel message received', {
          data: event.data,
        });
        try {
          const payload = typeof event.data === 'string' ? JSON.parse(event.data) : null;
          if (payload && typeof payload === 'object') {
            const type = (payload as { type?: string }).type;
            if (type === 'session.updated' || type === 'session.update') {
              const session = (payload as { session?: Record<string, unknown> }).session ?? {};
              const audio = session && typeof session === 'object' ? ((session as { audio?: unknown }).audio as unknown) : undefined;
              const audioOutput =
                audio && typeof audio === 'object'
                  ? ((audio as { output?: unknown }).output as { voice?: unknown } | undefined)
                  : undefined;
              const sessionParameters =
                session && typeof session === 'object'
                  ? ((session as { session_parameters?: unknown }).session_parameters as Record<string, unknown> | undefined)
                  : undefined;
              const voiceFromSessionParameters =
                typeof sessionParameters?.['voice'] === 'string'
                  ? (sessionParameters['voice'] as string)
                  : undefined;
              const voiceFromSession =
                typeof session['voice'] === 'string' ? (session['voice'] as string) : undefined;
              const voiceFromAudioOutput =
                typeof audioOutput?.voice === 'string' ? (audioOutput.voice as string) : undefined;
              const voice = voiceFromSessionParameters ?? voiceFromSession ?? voiceFromAudioOutput;
              const instructions =
                typeof sessionParameters?.['instructions'] === 'string'
                  ? (sessionParameters['instructions'] as string)
                  : typeof session['instructions'] === 'string'
                  ? (session['instructions'] as string)
                  : undefined;
              const td = (sessionParameters?.['turn_detection'] ?? session['turn_detection']) as { type?: string } | undefined;
              const turnDetection = td && typeof td.type === 'string' ? td.type : undefined;
              this.callbacks.onSessionUpdated?.({ voice, instructions, turnDetection });
              this.log('info', 'Received session.updated from realtime API', { voice, turnDetection, hasInstructions: Boolean(instructions) });
            }
          }
        } catch (error) {
          this.log('warn', 'Failed to parse control channel message', error);
        }
      };
    } catch (error) {
      this.log('warn', 'Failed to create realtime control data channel', error);
      this.controlChannel = null;
    }

    await this.exchangeOffer(peer, options.apiKey);
  }

  private async exchangeOffer(peer: RTCPeerConnection, apiKey: string): Promise<void> {
    const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    await peer.setLocalDescription(offer);

    const offerSdp = offer.sdp ?? '';

    const answerSdp =
      this.handshakeMode === 'sdp'
        ? await this.performSdpHandshake(apiKey, offerSdp)
        : await this.performJsonHandshake(apiKey, offerSdp);

    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    if (this.controlChannel && this.controlChannel.readyState === 'open') {
      this.sendSessionUpdate();
    }
  }

  private async performJsonHandshake(apiKey: string, offerSdp: string): Promise<string> {
    const sessionConfig = this.buildInitialSessionConfiguration();
    const requestBody: Record<string, unknown> = { sdp: offerSdp };

    if (Object.keys(sessionConfig).length > 0) {
      requestBody.session = sessionConfig;
    }

    this.log('info', 'Realtime JSON handshake request', {
      endpoint: this.endpoint,
      body: requestBody,
    });

    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const contentTypeHeader = response.headers?.get?.('content-type') ?? '';
    const normalizedContentType = contentTypeHeader.toLowerCase();

    this.log('info', 'Realtime JSON handshake response metadata', {
      status: response.status,
      contentType: normalizedContentType,
    });

    if (response.status === 400) {
      this.log('error', 'Realtime endpoint request failed with HTTP 400', {
        endpoint: this.endpoint,
        body: requestBody,
      });
    }

    if (!response.ok) {
      const { detail } = await this.readHandshakeErrorDetail(response, normalizedContentType);
      const message = `Realtime handshake failed: HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
      throw new Error(message);
    }

    if (normalizedContentType.includes('application/json')) {
      const payload = (await response.json()) as
        | { sdp?: unknown; rtc_connection?: { sdp?: unknown } | null }
        | undefined
        | null;
      if (payload && typeof payload === 'object') {
        if (typeof payload.sdp === 'string') {
          return payload.sdp;
        }
        const rtcConnection = payload.rtc_connection;
        if (rtcConnection && typeof rtcConnection === 'object' && typeof rtcConnection.sdp === 'string') {
          return rtcConnection.sdp;
        }
      }
    } else {
      const answerText = await response.text();
      if (answerText) {
        return answerText;
      }
    }

    throw new Error('Realtime handshake failed: missing answer SDP in response.');
  }

  private async performSdpHandshake(apiKey: string, offerSdp: string): Promise<string> {
    this.log('info', 'Realtime SDP handshake request', {
      endpoint: this.endpoint,
    });

    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
      },
      body: offerSdp,
    });

    const contentTypeHeader = response.headers?.get?.('content-type') ?? '';
    const normalizedContentType = contentTypeHeader.toLowerCase();

    this.log('info', 'Realtime SDP handshake response metadata', {
      status: response.status,
      contentType: normalizedContentType,
    });

    if (response.status === 400) {
      this.log('error', 'Realtime endpoint request failed with HTTP 400', {
        endpoint: this.endpoint,
        body: '<SDP omitted>',
      });
    }

    if (!response.ok) {
      const { detail } = await this.readHandshakeErrorDetail(response, normalizedContentType);
      const message = `Realtime handshake failed: HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
      throw new Error(message);
    }

    if (normalizedContentType.includes('application/json')) {
      const payload = (await response.json()) as
        | { sdp?: unknown; rtc_connection?: { sdp?: unknown } | null }
        | undefined
        | null;
      if (payload && typeof payload === 'object') {
        if (typeof payload.sdp === 'string') {
          return payload.sdp;
        }
        const rtcConnection = payload.rtc_connection;
        if (rtcConnection && typeof rtcConnection === 'object' && typeof rtcConnection.sdp === 'string') {
          return rtcConnection.sdp;
        }
      }
    } else {
      const answerText = await response.text();
      if (answerText) {
        return answerText;
      }
    }

    throw new Error('Realtime handshake failed: missing answer SDP in response.');
  }

  private async readHandshakeErrorDetail(
    response: Response,
    normalizedContentType: string,
  ): Promise<{ detail?: string; code?: string }> {
    let detail: string | undefined;
    let code: string | undefined;

    try {
      if (normalizedContentType.includes('application/json')) {
        const errorPayload = await response.json();
        if (errorPayload && typeof errorPayload === 'object') {
          const errorField = (errorPayload as { error?: { code?: unknown } | null }).error;
          if (errorField && typeof errorField === 'object') {
            const codeValue = (errorField as { code?: unknown }).code;
            if (typeof codeValue === 'string') {
              code = codeValue;
            }
          }
        }
        detail = JSON.stringify(errorPayload);
      } else {
        detail = await response.text();
      }
    } catch {
      // ignore body read errors for diagnostics
    }

    return { detail, code };
  }

  updateSessionConfig(next: RealtimeClientOptions['sessionConfig']): void {
    this.sessionConfig = { ...(this.sessionConfig ?? {}), ...(next ?? {}) };
    this.sendSessionUpdate();
  }

  getSessionConfigSnapshot(): Record<string, unknown> {
    return this.buildInitialSessionConfiguration();
  }

  private sendSessionUpdate(): void {
    if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
      return;
    }

    const payload: Record<string, unknown> = { type: 'session.update', session: {} };
    const session = payload.session as Record<string, unknown>;
    const sessionParameters: Record<string, unknown> = {
      ...(this.sessionConfig?.sessionParameters ?? {}),
    };

    const instructions = this.sessionConfig?.instructions;
    if (instructions) {
      sessionParameters.instructions = instructions;
      session.instructions = instructions;
    }

    const turnDetection = this.buildTurnDetectionConfig();
    if (turnDetection) {
      sessionParameters.turn_detection = turnDetection;
      session.turn_detection = turnDetection;
    }

    if (Object.keys(sessionParameters).length > 0) {
      session.session_parameters = sessionParameters;
    }

    if (this.sessionConfig?.voice) {
      session.voice = this.sessionConfig.voice;
      const previousAudio = (session.audio as Record<string, unknown> | undefined) ?? {};
      const previousOutput =
        previousAudio && typeof previousAudio['output'] === 'object' && previousAudio['output'] !== null
          ? (previousAudio['output'] as Record<string, unknown>)
          : {};

      const audioPayload: Record<string, unknown> = {
        ...previousAudio,
        output: {
          ...previousOutput,
          voice: this.sessionConfig.voice,
        },
      };

      session.audio = audioPayload;
    }

    try {
      if (Object.keys(session).length === 0) {
        return;
      }

      this.controlChannel.send(JSON.stringify(payload));
      this.log('info', 'Sent session.update to realtime API', payload);
    } catch (error) {
      this.log('warn', 'Failed to send session.update', error);
    }
  }

  private buildInitialSessionConfiguration(): Record<string, unknown> {
    const session: Record<string, unknown> = {
      type: 'realtime',
      model: this.model,
    };

    const modalities = this.sessionConfig?.modalities;
    if (Array.isArray(modalities) && modalities.length > 0) {
      session.output_modalities = modalities;
    } else {
      session.output_modalities = ['audio'];
    }

    const instructions = this.sessionConfig?.instructions;
    if (instructions) {
      session.instructions = instructions;
    }

    const turnDetection = this.buildTurnDetectionConfig();
    if (turnDetection) {
      session.turn_detection = turnDetection;
    }

    const inputFormat = this.buildInputAudioFormat();
    const audio: Record<string, unknown> = {};

    if (inputFormat) {
      audio.input = { format: inputFormat };
    }

    if (this.sessionConfig?.voice) {
      audio.output = { voice: this.sessionConfig.voice };
    }

    if (Object.keys(audio).length > 0) {
      session.audio = audio;
    }

    const sessionParameters: Record<string, unknown> = {
      ...(this.sessionConfig?.sessionParameters ?? {}),
    };

    if (instructions) {
      sessionParameters.instructions = instructions;
    }

    if (turnDetection) {
      sessionParameters.turn_detection = turnDetection;
    }

    if (Object.keys(sessionParameters).length > 0) {
      session.session_parameters = sessionParameters;
    }

    return session;
  }

  private buildInputAudioFormat(): Record<string, unknown> | undefined {
    if (!this.sessionConfig?.inputAudioFormat) {
      return { type: 'pcm16', sample_rate_hz: 16000, channels: 1 };
    }

    const { type, sampleRateHz, channels } = this.sessionConfig.inputAudioFormat;
    if (!type) {
      return undefined;
    }

    return {
      type,
      ...(typeof sampleRateHz === 'number' ? { sample_rate_hz: sampleRateHz } : {}),
      ...(typeof channels === 'number' ? { channels } : {}),
    };
  }

  private buildTurnDetectionConfig(): Record<string, unknown> | undefined {
    if (this.sessionConfig?.turnDetection === 'none') {
      return { type: 'none' };
    }

    if (this.sessionConfig?.turnDetection === 'server_vad') {
      return {
        type: 'server_vad',
        ...(typeof this.sessionConfig.vad?.threshold === 'number'
          ? { threshold: this.sessionConfig.vad.threshold }
          : {}),
        ...(typeof this.sessionConfig.vad?.silenceDurationMs === 'number'
          ? { silence_duration_ms: this.sessionConfig.vad.silenceDurationMs }
          : {}),
        ...(typeof this.sessionConfig.vad?.minSpeechDurationMs === 'number'
          ? { min_speech_duration_ms: this.sessionConfig.vad.minSpeechDurationMs }
          : {}),
      };
    }

    return undefined;
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

  // Removed JSON-based negotiation parsing in favor of application/sdp exchange

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
    const json = this.serializeLogData(data);
    this.callbacks.onLog?.({ level, message, data, json });
  }

  private serializeLogData(data: unknown): string | undefined {
    if (data === undefined) {
      return undefined;
    }

    if (typeof data === 'string') {
      return data;
    }

    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return typeof data === 'object' ? '[unserializable object]' : String(data);
    }
  }
}
