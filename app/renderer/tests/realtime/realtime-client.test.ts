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
  private readonly dataChannel = {
    readyState: 'open' as RTCDataChannelState,
    send: vi.fn(),
    close: vi.fn(),
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
  let fetchMock: Mock<[RequestInfo | URL, RequestInit?], Promise<Response>>;
  let client: RealtimeClient;
  const states: RealtimeClientState[] = [];
  const remoteStreamHandler = vi.fn();

  beforeEach(() => {
    peers.length = 0;
    states.length = 0;
    remoteStreamHandler.mockReset();

    fetchMock = vi
      .fn<[RequestInfo | URL, RequestInit?], Promise<Response>>()
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'fake-answer',
      } as Response);

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
      },
      jitterBufferMs: 80,
    });
  });

  afterEach(async () => {
    await client.destroy();
    vi.useRealTimers();
  });

  it('performs SDP negotiation and reports connected state', async () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;

    await client.connect({ apiKey: 'test-key', inputStream: stream });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit).toBeDefined();
    expect(requestInit?.body).toBe('fake-offer');

    const peer = peers[0];
    expect(peer.addTrack).toHaveBeenCalled();

    peer.emitTrack();
    expect(remoteStreamHandler).toHaveBeenCalled();

    peer.emitConnectionState('connected');
    expect(states.at(-1)?.status).toBe('connected');
  });

  it('includes voice preference in handshake when staged before connect', async () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;

    client.updateSessionConfig({ voice: 'alloy' });

    await client.connect({ apiKey: 'test-key', inputStream: stream });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = fetchMock.mock.calls[0]?.[0];
    expect(requestUrl).toBeDefined();
    expect(String(requestUrl)).toContain('voice=alloy');
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
      json: async () => ({}),
    } as Response);

    const stream = new FakeMediaStream() as unknown as MediaStream;

    await expect(client.connect({ apiKey: 'bad-key', inputStream: stream })).rejects.toThrow();
    expect(states.at(-1)).toMatchObject({ status: 'error' });
  });
});
