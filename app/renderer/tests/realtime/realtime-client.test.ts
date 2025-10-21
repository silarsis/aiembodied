import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
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
  let fetchMock: Mock<typeof fetch>;;
  let client: RealtimeClient;
  const states: RealtimeClientState[] = [];
  const remoteStreamHandler = vi.fn();
  const sessionUpdateHandler = vi.fn();

  beforeEach(() => {
    peers.length = 0;
    states.length = 0;
    remoteStreamHandler.mockReset();

    fetchMock = vi
      .fn<Parameters<typeof fetch>, Promise<Response>>()
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
        } as Pick<Headers, 'get'>,
        json: async () => ({
          rtc_connection: {
            sdp: 'fake-answer',
          },
        }),
        text: vi.fn(async () => 'unused'),
      } as unknown as Response);

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

  it('performs SDP negotiation and reports connected state', async () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;

    await client.connect({ apiKey: 'test-key', inputStream: stream });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit).toBeDefined();
    expect(requestInit?.headers).toMatchObject({
      'Content-Type': 'application/sdp',
      Authorization: 'Bearer test-key',
    });
    expect(typeof requestInit?.body).toBe('string');
    expect(requestInit?.body).toBe('fake-offer');
    
    // Check that the model is passed as a query parameter
    const fetchUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(fetchUrl).toContain('model=gpt-4o-realtime-preview-2024-12-17');

    const peer = peers[0];
    expect(peer.addTrack).toHaveBeenCalled();

    peer.emitTrack();
    expect(remoteStreamHandler).toHaveBeenCalled();

    peer.emitConnectionState('connected');
    expect(states.at(-1)?.status).toBe('connected');
  });

  it('sends SDP directly and configures voice via session.update', async () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;

    client.updateSessionConfig({ voice: 'alloy' });

    await client.connect({ apiKey: 'test-key', inputStream: stream });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(typeof requestInit?.body).toBe('string');
    expect(requestInit?.body).toBe('fake-offer');
    
    // Voice should be configured via session.update after connection
    const peer = peers[0];
    const sendCalls = peer.dataChannel.send.mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    
    const sessionUpdatePayloads = sendCalls.map((call) => JSON.parse(call[0] as string));
    expect(sessionUpdatePayloads.some((payload) => 
      payload.type === 'session.update' && payload.session?.voice === 'alloy'
    )).toBe(true);
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
        session: { session_parameters?: Record<string, unknown>; voice?: string; instructions?: string };
      },
    );
    
    // Should include instructions in session_parameters
    expect(
      payloads.some((payload) => payload.session.session_parameters?.instructions === 'Be helpful'),
    ).toBe(true);
    
    // Should include voice directly in session
    expect(payloads.some((payload) => payload.session.voice === 'alloy')).toBe(true);

    // Should mirror instructions directly in session for backward compatibility
    expect(payloads.some((payload) => payload.session.instructions === 'Be helpful')).toBe(true);
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
