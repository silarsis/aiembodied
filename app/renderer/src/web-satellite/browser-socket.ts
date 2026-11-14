import type { LinkSocket, SocketFactory } from '../../../main/src/satellite/link-core.js';

/** The slice of the browser's WebSocket the link uses (so a test can hand in Node's). */
export type WebSocketCtor = new (url: string) => WebSocket;

/**
 * The browser's WebSocket as a link socket. A text message is a string, a binary one an ArrayBuffer (so
 * `binaryType` is set to 'arraybuffer'). The browser has no handshake timeout of its own: the link's heartbeat
 * drops a connection that never opens, because no traffic arrives.
 */
export function browserSocketFactory(Ctor: WebSocketCtor = globalThis.WebSocket): SocketFactory {
  return (url, handlers) => {
    let ws: WebSocket;
    try {
      ws = new Ctor(url);
    } catch (error) {
      // A bad address throws at once. Report it as a connection that closes, so the link retries the usual way.
      const message = error instanceof Error ? error.message : String(error);
      const timer = setTimeout(() => {
        handlers.onError(message);
        handlers.onClose();
      }, 0);
      const dead: LinkSocket = { isOpen: false, send: () => undefined, close: () => undefined, terminate: () => clearTimeout(timer), detach: () => clearTimeout(timer) };
      return dead;
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === 'string') handlers.onMessage(data);
      else if (data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) handlers.onMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    };
    ws.onclose = () => handlers.onClose();
    ws.onerror = () => handlers.onError('The connection failed.');
    const socket: LinkSocket = {
      get isOpen() {
        return ws.readyState === 1;
      },
      send: (frame) => ws.send(frame as string | ArrayBufferView<ArrayBuffer>),
      close: (code, reason) => ws.close(code, reason),
      terminate: () => ws.close(),
      detach: () => {
        ws.onopen = ws.onmessage = ws.onclose = null;
        ws.onerror = () => undefined;
      },
    };
    return socket;
  };
}
