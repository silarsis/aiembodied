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
  iceGatheringState: RTCIceGatheringState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
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
    this.onconnectionstatechange?.();
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

  beforeEach(() => {
    peers.length = 0;
    states.length = 0;
    remoteStreamHandler.mockReset();

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
      },
      jitterBufferMs: 80,
    });
  });

  afterEach(async () => {
    await client.destroy();
    vi.useRealTimers();
    sessionUpdateHandler.mockReset();
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

  it('falls back to legacy SDP handshake when JSON is rejected', async () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;

    const unsupportedResponse = {
      ok: false,
      status: 400,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      } as Pick<Headers, 'get'>,
      json: vi.fn(async () => ({
        error: {
          code: 'unsupported_content_type',
          message: 'Unsupported content type. This API method only accepts application/sdp requests.',
        },
      })),
      text: vi.fn(async () => 'should-not-be-called'),
    } as unknown as Response;

    const successResponse = {
      ok: true,
      status: 201,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/sdp' : null),
      } as Pick<Headers, 'get'>,
      text: vi.fn(async () => 'fallback-answer'),
      json: vi.fn(async () => ({ rtc_connection: { sdp: 'unused' } })),
    } as unknown as Response;

    fetchMock
      .mockResolvedValueOnce(unsupportedResponse)
      .mockResolvedValueOnce(successResponse);

    client.updateSessionConfig({ voice: 'alloy' });

    await client.connect({ apiKey: 'test-key', inputStream: stream });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstCallInit = fetchMock.mock.calls[0]?.[1];
    expect(firstCallInit?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });

    const secondCallUrl = fetchMock.mock.calls[1]?.[0] as string;
    const secondCallInit = fetchMock.mock.calls[1]?.[1];
    expect(secondCallUrl).toContain('/v1/realtime/calls');
    expect(secondCallUrl).toContain('model=gpt-4o-realtime-preview-2024-12-17');
    expect(secondCallInit?.headers).toMatchObject({
      'Content-Type': 'application/sdp',
    });
    expect(secondCallInit?.body).toBe('fake-offer');

    const peer = peers[0];
    const sendCalls = peer.dataChannel.send.mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);

    const sessionUpdatePayloads = sendCalls.map((call) => JSON.parse(call[0] as string));
    expect(
      sessionUpdatePayloads.some((payload) => payload.type === 'session.update' && payload.session?.voice === 'alloy'),
    ).toBe(true);
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
});
