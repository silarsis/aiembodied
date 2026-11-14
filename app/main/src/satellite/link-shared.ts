/**
 * The parts of the room link that need no WebSocket library: constants, types, errors and the hub address parser.
 * The Node satellite (room-link.ts) and the web satellite (renderer/src/web-satellite) both use them.
 */

export const LINK_PROTOCOL = 1;
export const LOST_TOUCH = 'Lost touch with bija.';
export const PING_MS = 2000;
export const TIMEOUT_MS = 6000;
export const BACKOFF_FIRST_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const CALL_TIMEOUT_MS = 60_000;
/** The first connection gets this long before calls give up; after a drop they fail at once. */
export const FIRST_CONNECT_WAIT_MS = 6000;
/** These run for as long as the turn or the stream does, so they have no timeout of their own. */
export const LONG_RUNNING_CHANNELS: ReadonlySet<string> = new Set(['local-voice:respond', 'avatar-motion:stream']);

/** `connecting`: the first try. `online`: welcomed. `offline`: dropped, trying again. `refused`: bija said no (see `code`). */
export type LinkState = 'idle' | 'connecting' | 'online' | 'offline' | 'refused';

export interface LinkStatus {
  state: LinkState;
  /** Why bija refused: auth, peer, protocol, revoked, replaced. */
  code?: string;
  message?: string;
  placeId?: string;
}

export interface Welcome {
  protocol: number;
  placeId: string;
  place: { id: string; name: string; room?: string; [key: string]: unknown };
  snapshot: unknown;
  avatars: unknown[];
  settings: { wakeWord: unknown | null; pushToTalk: unknown | null };
  /** For a web page: `/v1/asset?k=<this>` loads room files by URL while this link is open. Absent from an older hub. */
  assetKey?: string;
}

export class LinkError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LinkError';
  }
}

/** `bija:8791`, `ws://bija`, `http://100.64.0.1:8791/` all name a hub. Null when it is not an address. */
export function parseHubUrl(input: string): { ws: string; http: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') return null;
  if (!url.hostname) return null;
  const port = url.port || '8791';
  const host = url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname;
  return { ws: `${secure ? 'wss' : 'ws'}://${host}:${port}`, http: `${secure ? 'https' : 'http'}://${host}:${port}` };
}

