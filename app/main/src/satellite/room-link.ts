/**
 * RoomLink: the satellite's end of the room link on Node (docs/features/room-link-protocol.md).
 *
 * The whole link (hello, ping, calls, reconnect) is `RoomLinkCore` in link-core.ts, which the web satellite uses
 * too. This file gives it the `ws` package as its socket.
 */
import WebSocket, { type RawData } from 'ws';
import { MAX_FRAME_BYTES } from '../room-hub/frames.js';
import { RoomLinkCore, type LinkSocket, type RoomLinkOptions, type SocketFactory } from './link-core.js';

export * from './link-shared.js';
export type { RoomLinkOptions } from './link-core.js';

function toFrame(data: RawData, isBinary: boolean): string | Uint8Array {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  return isBinary ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.toString('utf8');
}

/** The `ws` package as a link socket. */
export const wsSocketFactory: SocketFactory = (url, handlers, options) => {
  const ws = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: options.handshakeTimeoutMs });
  ws.on('open', () => handlers.onOpen());
  ws.on('message', (data: RawData, isBinary: boolean) => handlers.onMessage(toFrame(data, isBinary)));
  ws.on('close', () => handlers.onClose());
  ws.on('error', (error) => handlers.onError(error.message));
  const socket: LinkSocket = {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send: (frame) => ws.send(frame, { binary: typeof frame !== 'string' }),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
    detach: () => {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
    },
  };
  return socket;
};

export class RoomLink extends RoomLinkCore {
  constructor(options: RoomLinkOptions) {
    super(options, wsSocketFactory);
  }
}
