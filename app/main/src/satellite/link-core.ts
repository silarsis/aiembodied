/**
 * RoomLinkCore: the satellite's end of the room link (docs/features/room-link-protocol.md), without a WebSocket library.
 *
 * It keeps one WebSocket open to bija's `/v1/link`, says hello with the device token, answers pings, and turns
 * the satellite's IPC calls into `call` ops with an answer to wait for. When the link drops it tries again
 * (1 s, doubling to 30 s) and everything waiting on bija fails with "Lost touch with bija.".
 *
 * Nothing here knows about Electron, Node or the browser: the socket comes from a `SocketFactory`. The Node
 * satellite gives it the `ws` package (room-link.ts); the web satellite gives it the browser's WebSocket. The wire
 * format is room-hub/frames.ts, the same file bija uses.
 */
import { FrameError, decodeMessage, encodeMessage, type Op } from '../room-hub/frames.js';
import {
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  CALL_TIMEOUT_MS,
  FIRST_CONNECT_WAIT_MS,
  LINK_PROTOCOL,
  LONG_RUNNING_CHANNELS,
  LOST_TOUCH,
  LinkError,
  PING_MS,
  TIMEOUT_MS,
  type LinkStatus,
  type Welcome,
} from './link-shared.js';

/** The slice of a WebSocket the link uses. An adapter turns `ws` or the browser's WebSocket into this. */
export interface LinkSocket {
  /** The connection is open and can send. */
  readonly isOpen: boolean;
  send(frame: string | Uint8Array): void;
  /** A polite close. */
  close(code: number, reason: string): void;
  /** Drop the connection now. */
  terminate(): void;
  /** Stop calling the handlers and ignore later errors (the link is done with this socket). */
  detach(): void;
}

export interface LinkSocketHandlers {
  onOpen(): void;
  /** One frame: a string for text, bytes for binary. */
  onMessage(data: string | Uint8Array): void;
  onClose(): void;
  onError(message: string): void;
}

/** Opens a socket to `url` and reports through `handlers`. `handshakeTimeoutMs` bounds the connect where the library can. */
export type SocketFactory = (url: string, handlers: LinkSocketHandlers, options: { handshakeTimeoutMs: number }) => LinkSocket;

/** `unref` exists on Node timers only; a browser timer is a number. */
function unref(timer: unknown): void {
  (timer as { unref?: () => void } | null)?.unref?.();
}

export interface RoomLinkOptions {
  /** `ws://host:port` (no path). */
  url: string;
  deviceId: string;
  token: string;
  appVersion: string;
  /** An `ipc` op: an event for the renderer. */
  onIpc: (channel: string, args: unknown[]) => void;
  onStatus: (status: LinkStatus) => void;
  onWelcome?: (welcome: Welcome) => void;
  /** Bija asked this PC's devices off. */
  onDeviceOff?: (reason: string) => void;
  /** The round trip of a ping, in ms, each time bija answers one. */
  onPong?: (rttMs: number) => void;
  pingMs?: number;
  timeoutMs?: number;
  backoffFirstMs?: number;
  backoffMaxMs?: number;
  callTimeoutMs?: number;
  firstConnectWaitMs?: number;
  logger?: Pick<Console, 'warn' | 'info' | 'debug'>;
}

interface Pending {
  resolve: (value: unknown, payload: Uint8Array | null, op: Op) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RoomLinkCore {
  private readonly options: RoomLinkOptions;
  private socket: LinkSocket | null = null;
  private state: LinkStatus = { state: 'idle' };
  private welcomeValue: Welcome | null = null;
  private stopped = true;
  private everOnline = false;
  private serial = 0;
  private lastTraffic = 0;
  private backoffMs: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly onlineWaiters = new Set<(online: boolean) => void>();

  constructor(
    options: RoomLinkOptions,
    private readonly socketFactory: SocketFactory,
  ) {
    this.options = options;
    this.backoffMs = options.backoffFirstMs ?? BACKOFF_FIRST_MS;
  }

  status(): LinkStatus {
    return { ...this.state };
  }

  welcome(): Welcome | null {
    return this.welcomeValue;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.everOnline = false;
    this.backoffMs = this.options.backoffFirstMs ?? BACKOFF_FIRST_MS;
    this.setStatus({ state: 'connecting' });
    this.open();
  }

  /** Closes the link for good (forget, quit). Anything waiting fails. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.detach();
      try {
        socket.close(1000, 'bye');
      } catch {
        socket.terminate();
      }
    }
    this.failAll(new LinkError(LOST_TOUCH, 'offline'));
    this.releaseWaiters(false);
    this.welcomeValue = null;
    this.state = { state: 'idle' };
  }

  /**
   * Asks bija to run an IPC channel and resolves with its answer. Fails at once with "Lost touch with bija." when
   * the link is down; the very first connection is given a few seconds, since the window asks for things at start-up.
   */
  async call(channel: string, args: unknown[] = []): Promise<unknown> {
    const reply = await this.request({ op: 'call', channel, args }, LONG_RUNNING_CHANNELS.has(channel) ? null : (this.options.callTimeoutMs ?? CALL_TIMEOUT_MS));
    return reply.value;
  }

  /** Fetches a room asset through bija (`asset.get`). */
  async getAsset(url: string): Promise<{ mime: string; data: Uint8Array }> {
    const reply = await this.request({ op: 'asset.get', url }, this.options.callTimeoutMs ?? CALL_TIMEOUT_MS);
    if (!reply.payload) throw new LinkError('bija sent no file.', 'bad-reply');
    return { mime: typeof reply.op.mime === 'string' ? reply.op.mime : 'application/octet-stream', data: reply.payload };
  }

  /** Fire-and-forget ops (`presence`, `device.state`, `wake.heard`). False when the link is down. */
  send(op: Op): boolean {
    if (this.state.state !== 'online') return false;
    return this.write(op);
  }

  // -- Calls ------------------------------------------------------------------------------------

  private async request(op: Op, timeoutMs: number | null): Promise<{ value: unknown; payload: Uint8Array | null; op: Op }> {
    if (this.state.state === 'connecting' && !this.everOnline) {
      const online = await this.waitOnline(this.options.firstConnectWaitMs ?? FIRST_CONNECT_WAIT_MS);
      if (!online) throw new LinkError(LOST_TOUCH, 'offline');
    }
    if (this.state.state !== 'online') throw new LinkError(LOST_TOUCH, this.state.state === 'refused' ? (this.state.code ?? 'refused') : 'offline');
    const ref = `c${++this.serial}`;
    return new Promise((resolve, reject) => {
      const entry: Pending = {
        resolve: (value, payload, reply) => resolve({ value, payload, op: reply }),
        reject,
        timer: null,
      };
      if (timeoutMs !== null) {
        entry.timer = setTimeout(() => {
          this.pending.delete(ref);
          reject(new LinkError('bija did not answer in time.', 'timeout'));
        }, timeoutMs);
        unref(entry.timer);
      }
      this.pending.set(ref, entry);
      if (!this.write({ ...op, ref })) {
        this.pending.delete(ref);
        if (entry.timer) clearTimeout(entry.timer);
        reject(new LinkError(op.op === 'call' ? 'The request is too large to send.' : LOST_TOUCH, 'too-large'));
      }
    });
  }

  private waitOnline(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (online: boolean) => {
        clearTimeout(timer);
        this.onlineWaiters.delete(done);
        resolve(online);
      };
      const timer = setTimeout(() => done(false), ms);
      unref(timer);
      this.onlineWaiters.add(done);
    });
  }

  private releaseWaiters(online: boolean): void {
    for (const waiter of [...this.onlineWaiters]) waiter(online);
  }

  private failAll(error: Error): void {
    for (const [ref, entry] of [...this.pending]) {
      this.pending.delete(ref);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  // -- The socket -------------------------------------------------------------------------------

  private open(): void {
    if (this.stopped) return;
    const socket: LinkSocket = this.socketFactory(
      `${this.options.url}/v1/link`,
      {
        onOpen: () => {
          if (this.socket !== socket) return;
          this.lastTraffic = Date.now();
          this.write({ op: 'hello', protocol: LINK_PROTOCOL, deviceId: this.options.deviceId, token: this.options.token, appVersion: this.options.appVersion });
        },
        onMessage: (data) => {
          if (this.socket !== socket) return;
          this.lastTraffic = Date.now();
          this.onMessage(data);
        },
        onClose: () => this.dropped(socket),
        // 'close' follows an error that ends the socket; one that does not is caught by the heartbeat.
        onError: (message) => this.options.logger?.debug('Room link socket error', { message }),
      },
      { handshakeTimeoutMs: this.options.timeoutMs ?? TIMEOUT_MS },
    );
    this.socket = socket;
    this.lastTraffic = Date.now();
    this.startPing();
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const every = this.options.pingMs ?? PING_MS;
    const limit = this.options.timeoutMs ?? TIMEOUT_MS;
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket) return;
      if (Date.now() - this.lastTraffic > limit) {
        this.options.logger?.warn('Room link: no traffic from bija; dropping the link');
        socket.terminate();
        this.dropped(socket);
        return;
      }
      if (this.state.state === 'online') this.write({ op: 'ping', t: Date.now() });
    }, every);
    unref(this.pingTimer);
  }

  private write(op: Op): boolean {
    const socket = this.socket;
    if (!socket || !socket.isOpen) return false;
    try {
      socket.send(encodeMessage(op));
      return true;
    } catch (error) {
      this.options.logger?.warn('Room link could not send', { op: op.op, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  private onMessage(data: string | Uint8Array): void {
    let decoded;
    try {
      decoded = decodeMessage(data);
    } catch (error) {
      this.options.logger?.warn('Room link: bad frame from bija', { message: error instanceof FrameError ? error.message : String(error) });
      return;
    }
    const { op, payload } = decoded;
    const ref = typeof op.ref === 'string' ? op.ref : undefined;
    switch (op.op) {
      case 'welcome':
        this.onWelcome(op as unknown as Welcome);
        return;
      case 'pong':
        if (typeof op.t === 'number') this.options.onPong?.(Math.max(0, Date.now() - op.t));
        return;
      case 'result':
      case 'asset': {
        const entry = ref ? this.pending.get(ref) : undefined;
        if (!ref || !entry) return;
        this.pending.delete(ref);
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve(op.value ?? null, payload, op);
        return;
      }
      case 'error':
        this.onError(op, ref);
        return;
      case 'ipc':
        if (typeof op.channel === 'string') {
          try {
            this.options.onIpc(op.channel, Array.isArray(op.args) ? op.args : []);
          } catch (error) {
            this.options.logger?.warn('Room link: delivering an event failed', { channel: op.channel, message: error instanceof Error ? error.message : String(error) });
          }
        }
        return;
      case 'device.off':
        this.options.onDeviceOff?.(typeof op.reason === 'string' ? op.reason : '');
        return;
      default:
        this.options.logger?.debug('Room link: ignoring an op', { op: op.op });
    }
  }

  private onWelcome(welcome: Welcome): void {
    this.welcomeValue = welcome;
    this.everOnline = true;
    this.backoffMs = this.options.backoffFirstMs ?? BACKOFF_FIRST_MS;
    this.setStatus({ state: 'online', placeId: welcome.placeId });
    this.options.onWelcome?.(welcome);
    this.releaseWaiters(true);
  }

  private onError(op: Op, ref: string | undefined): void {
    const code = typeof op.code === 'string' ? op.code : 'failed';
    const message = typeof op.message === 'string' ? op.message : 'bija could not do that.';
    if (ref) {
      const entry = this.pending.get(ref);
      if (!entry) return;
      this.pending.delete(ref);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new LinkError(message, code));
      return;
    }
    // An error with no ref ends the link. These mean trying again will not help until something changes.
    if (code === 'auth' || code === 'peer' || code === 'protocol' || code === 'revoked' || code === 'replaced') {
      this.refuse(code, message);
    } else {
      this.options.logger?.warn('Room link: bija reported an error', { code, message });
    }
  }

  private refuse(code: string, message: string): void {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.detach();
      try {
        socket.close(1000, 'refused');
      } catch {
        socket.terminate();
      }
    }
    this.failAll(new LinkError(message, code));
    this.releaseWaiters(false);
    this.welcomeValue = null;
    this.stopped = true;
    this.setStatus({ state: 'refused', code, message });
  }

  private dropped(socket: LinkSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    socket.detach();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.failAll(new LinkError(LOST_TOUCH, 'offline'));
    this.releaseWaiters(false);
    if (this.stopped) return;
    this.welcomeValue = null;
    if (this.state.state !== 'offline') this.setStatus({ state: 'offline' });
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.backoffMaxMs ?? BACKOFF_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, wait);
    unref(this.retryTimer);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }

  private setStatus(status: LinkStatus): void {
    this.state = status;
    try {
      this.options.onStatus({ ...status });
    } catch (error) {
      this.options.logger?.warn('Room link: a status listener failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}
