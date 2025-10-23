import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type RealtimeClientState } from '../../src/realtime/realtime-client.js';

class FakeMediaStreamTrack {
  readonly kind = 'audio';

  stop = vi.fn();
}

class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[] = [new FakeMediaStreamTrack() as unknown as MediaStreamTrack];

  getTracks() {
    return this.tracks;
  }
}

class FakeReceiver {
  track: MediaStreamTrack | null = { kind: 'audio' } as MediaStreamTrack;
  playoutDelayHint = 0;
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  oniceconnectionstatechange: ((event: Event) => void) | null = null;
  onicegatheringstatechange: ((event: Event) => void) | null = null;
  onsignalingstatechange: ((event: Event) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  readonly addTrack = vi.fn();
  readonly addTransceiver = vi.fn();
  readonly createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'fake-offer' } as RTCSessionDescriptionInit));
  readonly setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
  });
  readonly setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
  });
  readonly close = vi.fn();
  private readonly receiver = new FakeReceiver();
  readonly dataChannel = {
    readyState: 'open' as RTCDataChannelState,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null as ((this: RTCDataChannel, ev: Event) => void) | null,
    onclose: null as ((this: RTCDataChannel, ev: Event) => void) | null,
    onerror: null as ((this: RTCDataChannel, ev: Event) => void) | null,
    onmessage: null as ((this: RTCDataChannel, ev: MessageEvent) => void) | null,
  };

  createDataChannel() {
    return this.dataChannel as unknown as RTCDataChannel;
  }

  getReceivers() {
    return [this.receiver as unknown as RTCRtpReceiver];
  }

  emitConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event('connectionstatechange'));
  }

  emitTrack(stream: MediaStream = new FakeMediaStream() as unknown as MediaStream) {
    const trackEvent = {
      streams: [stream],
      track: { kind: 'audio' },
    } as unknown as RTCTrackEvent;
    this.ontrack?.(trackEvent);
  }

  emitIceCandidate(candidate: RTCIceCandidate | null) {
    this.onicecandidate?.({ candidate } as RTCPeerConnectionIceEvent);
  }

  emitIceConnectionState(state: RTCIceConnectionState) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.(new Event('iceconnectionstatechange'));
  }

  emitIceGatheringState(state: RTCIceGatheringState) {
    this.iceGatheringState = state;
    this.onicegatheringstatechange?.(new Event('icegatheringstatechange'));
  }

  emitSignalingState(state: RTCSignalingState) {
    this.signalingState = state;
    this.onsignalingstatechange?.(new Event('signalingstatechange'));
  }
}

describe('RealtimeClient', () => {
  const peers: FakePeerConnection[] = [];
  // Function mock preserving vi.fn() metadata and fetch call signature
  type FetchMock = ReturnType<typeof vi.fn> & ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>);
  let fetchMock: FetchMock;
  let client: RealtimeClient;
  const states: RealtimeClientState[] = [];
  const remoteStreamHandler = vi.fn();
  const sessionUpdateHandler = vi.fn();
  const logHandler = vi.fn();

  beforeEach(() => {
    peers.length = 0;
    states.length = 0;
    remoteStreamHandler.mockReset();
    logHandler.mockReset();

    fetchMock = (vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
        } as Pick<Headers, 'get'>,
        json: async () => ({
          id: 'call_123',
          sdp: 'fake-answer',
        }),
        text: vi.fn(async () => 'unused'),
      } as unknown as Response) as unknown) as FetchMock;

    client = new RealtimeClient({
      fetchFn: (input, init) => fetchMock(input, init),
      createPeerConnection: () => {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return peer as unknown as RTCPeerConnection;
      },
      reconnectDelaysMs: [0, 0, 0],
      callbacks: {
        onStateChange: (state) => {
          states.push(state);
        },
        onRemoteStream: remoteStreamHandler,
        onSessionUpdated: sessionUpdateHandler,
        onLog: logHandler,
      },
      jitterBufferMs: 80,
    });
  });

  afterEach(async () => {
    await client.destroy();
    vi.useRealTimers();
    sessionUpdateHandler.mockReset();
    logHandler.mockReset();
  });

  it('performs JSON handshake negotiation when supported and reports connected state', async () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;

    await client.connect({ apiKey: 'test-key', inputStream: stream });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit).toBeDefined();
    expect(requestInit?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-key',
    });
    expect(typeof requestInit?.body).toBe('string');
    const parsedBody = JSON.parse(requestInit?.body as string) as {
      sdp: string;
      session: Record<string, unknown>;
    };

    expect(parsedBody.sdp).toBe('fake-offer');
    expect(parsedBody.session).toMatchObject({
      type: 'realtime',
      model: 'gpt-4o-realtime-preview-2024-12-17',
    });

    const audioConfig = (parsedBody.session.audio ?? {}) as Record<string, unknown>;
    const inputConfig = (audioConfig.input ?? {}) as { format?: Record<string, unknown> };
    expect((inputConfig.format ?? {}).type).toBe('pcm16');

    // Check that the request targets the calls endpoint
    const fetchUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(fetchUrl).toContain('/v1/realtime/calls');

    const peer = peers[0];
    expect(peer.addTrack).toHaveBeenCalled();

    peer.emitTrack();
    expect(remoteStreamHandler).toHaveBeenCalled();

    peer.emitConnectionState('connected');
    expect(states.at(-1)?.status).toBe('connected');
  });

  it('logs handshake payloads including voice configuration', async () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;

    client.updateSessionConfig({ voice: 'alloy', instructions: 'Hello' });

    await client.connect({ apiKey: 'test-key', inputStream: stream });

    const logMessages = logHandler.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.message === 'Realtime JSON handshake request');

    expect(logMessages.length).toBeGreaterThan(0);
    const latest = logMessages.at(-1);
    expect(latest?.data).toMatchObject({
      body: {
        sdp: 'fake-offer',
        session: {
          audio: { output: { voice: 'alloy' } },
          session_parameters: {
            instructions: 'Hello',
          },
        },
      },
    });
    expect(latest?.json).toContain('"voice": "alloy"');
  });

  it('includes voice and instructions in session.update payloads', async () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;

    client.updateSessionConfig({ voice: 'alloy', instructions: 'Be helpful' });

    await client.connect({ apiKey: 'test-key', inputStream: stream });

    const peer = peers[0];
    const sendCalls = peer.dataChannel.send.mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const payloads = sendCalls.map((call) =>
      JSON.parse(call[0] as string) as {
        session: {
          session_parameters?: Record<string, unknown>;
          voice?: string;
          instructions?: string;
          audio?: { output?: { voice?: string } };
        };
      },
    );
    
    // Should include instructions in session_parameters
    expect(
      payloads.some((payload) => payload.session.session_parameters?.instructions === 'Be helpful'),
    ).toBe(true);
    
    // Should include voice directly in session
    expect(payloads.some((payload) => payload.session.voice === 'alloy')).toBe(true);
    expect(payloads.some((payload) => payload.session.audio?.output?.voice === 'alloy')).toBe(true);

    // Should mirror instructions directly in session for backward compatibility
    expect(payloads.some((payload) => payload.session.instructions === 'Be helpful')).toBe(true);

    const handshakeBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      session: { instructions?: string; session_parameters?: Record<string, unknown> };
    };
    expect(handshakeBody.session.instructions).toBe('Be helpful');
    expect(handshakeBody.session.session_parameters?.instructions).toBe('Be helpful');
  });

  it('parses session.updated payloads using the new schema', async () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;

    await client.connect({ apiKey: 'test-key', inputStream: stream });

    const peer = peers[0];
    const dataChannel = peer.dataChannel;
    const messageHandler = dataChannel.onmessage;
    expect(messageHandler).toBeTypeOf('function');

    const payload = {
      type: 'session.updated',
      session: {
        audio: {
          output: {
            voice: 'verse',
          },
        },
        session_parameters: {
          instructions: 'Stay concise',
          voice: 'alloy',
          turn_detection: { type: 'server_vad' },
        },
      },
    } satisfies Record<string, unknown>;

    messageHandler?.call(dataChannel as unknown as RTCDataChannel, {
      data: JSON.stringify(payload),
    } as MessageEvent);

    expect(sessionUpdateHandler).toHaveBeenCalledWith({
      voice: 'alloy',
      instructions: 'Stay concise',
      turnDetection: 'server_vad',
    });
  });

  it('retries connection when the peer disconnects', async () => {
    vi.useFakeTimers();
    const stream = new FakeMediaStream() as unknown as MediaStream;

    await client.connect({ apiKey: 'test-key', inputStream: stream });
    const firstPeer = peers[0];
    firstPeer.emitConnectionState('connected');

    firstPeer.emitConnectionState('disconnected');
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(states.some((state) => state.status === 'reconnecting' && state.attempt === 1)).toBe(true);
  });

  it('surfaces errors when negotiation fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      } as Pick<Headers, 'get'>,
      json: async () => ({}),
      text: vi.fn(async () => ''),
    } as unknown as Response);

    const stream = new FakeMediaStream() as unknown as MediaStream;

    await expect(client.connect({ apiKey: 'bad-key', inputStream: stream })).rejects.toThrow();
    expect(states.at(-1)).toMatchObject({ status: 'error' });
  });

  it('logs request details when the realtime endpoint responds with HTTP 400', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      } as Pick<Headers, 'get'>,
      json: async () => ({ error: { message: 'bad request' } }),
      text: vi.fn(async () => ''),
    } as unknown as Response);

    const stream = new FakeMediaStream() as unknown as MediaStream;

    await expect(client.connect({ apiKey: 'test-key', inputStream: stream })).rejects.toThrow();

    const errorLogs = logHandler.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.message === 'Realtime endpoint request failed with HTTP 400');
    expect(errorLogs.length).toBeGreaterThan(0);
    const logEntry = errorLogs.at(-1);
    expect(logEntry?.data).toMatchObject({
      endpoint: expect.stringContaining('/v1/realtime/calls'),
      body: expect.objectContaining({ sdp: 'fake-offer' }),
    });
    expect(logEntry?.json).toContain('"fake-offer"');
  });
});
