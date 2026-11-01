/**
 * The phone page's connection to the desktop: authenticated fetches, NDJSON streams, and the
 * long-lived push stream (reconnected with backoff when the desktop or Wi-Fi goes away).
 */
import type { CompanionScene, CompanionStreamEvent } from '../../../main/src/companion/types.js';
import type { AvatarMotionStreamRequest } from '../avatar/types.js';

export interface CompanionConnection {
  /** The desktop's base URL; empty for the page's own origin (how the phone loads it). */
  baseUrl: string;
  code: string;
  deviceId: string;
  deviceName: string;
}

export type PushState = 'connecting' | 'connected' | 'offline' | 'unauthorized';

export class CompanionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class CompanionClient {
  constructor(
    private readonly connection: CompanionConnection,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  get deviceId(): string {
    return this.connection.deviceId;
  }

  getScene(): Promise<CompanionScene> {
    return this.request('/api/scene').then((response) => response.json() as Promise<CompanionScene>);
  }

  loadAvatar(id: string): Promise<ArrayBuffer> {
    return this.request(`/api/avatar/${encodeURIComponent(id)}`).then((response) => response.arrayBuffer());
  }

  loadAnimation(id: string): Promise<ArrayBuffer> {
    return this.request(`/api/animations/${encodeURIComponent(id)}`).then((response) => response.arrayBuffer());
  }

  loadPose(id: string): Promise<unknown> {
    return this.request(`/api/poses/${encodeURIComponent(id)}`).then((response) => response.json() as Promise<unknown>);
  }

  /** The background image as an object URL; revoke it when replaced. */
  async loadBackgroundUrl(id: string): Promise<string> {
    const blob = await (await this.request(`/api/background/${encodeURIComponent(id)}`)).blob();
    return URL.createObjectURL(blob);
  }

  /** Send one utterance (WAV) and receive the reply as it is generated. */
  async turn(wav: ArrayBuffer, onEvent: (event: CompanionStreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const response = await this.request('/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      signal,
    });
    await readNdjson(response, onEvent);
  }

  async motion(request: AvatarMotionStreamRequest, onEvent: (event: CompanionStreamEvent) => void): Promise<void> {
    const response = await this.request('/api/motion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    await readNdjson(response, onEvent);
  }

  async cancel(requestId?: string): Promise<void> {
    await this.request('/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  }

  /**
   * Keep the push stream open: scene changes and messages from the desktop. Reconnects with
   * backoff (1 s doubling to 15 s) and treats a stream with no ping for 40 s as dead.
   */
  openPushStream(onEvent: (event: CompanionStreamEvent) => void, onState: (state: PushState) => void): () => void {
    let closed = false;
    let controller: AbortController | null = null;
    let retryTimer: number | null = null;
    let watchdog: number | null = null;
    let delay = 1000;

    const armWatchdog = () => {
      if (watchdog !== null) window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => controller?.abort(), 40_000);
    };

    const connect = async () => {
      if (closed) return;
      onState('connecting');
      controller = new AbortController();
      try {
        const response = await this.request('/api/events', { signal: controller.signal });
        onState('connected');
        delay = 1000;
        armWatchdog();
        await readNdjson(response, (event) => {
          armWatchdog();
          onEvent(event);
        });
      } catch (error) {
        if (closed) return;
        if (error instanceof CompanionHttpError && error.status === 401) {
          onState('unauthorized');
          return;
        }
      } finally {
        if (watchdog !== null) window.clearTimeout(watchdog);
      }
      if (closed) return;
      onState('offline');
      retryTimer = window.setTimeout(() => void connect(), delay);
      delay = Math.min(delay * 2, 15_000);
    };

    void connect();
    return () => {
      closed = true;
      controller?.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (watchdog !== null) window.clearTimeout(watchdog);
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.connection.code}`);
    headers.set('X-Companion-Device', this.connection.deviceId);
    headers.set('X-Companion-Name', encodeURIComponent(this.connection.deviceName));
    const response = await this.fetchFn(`${this.connection.baseUrl}${path}`, { ...init, headers, cache: 'no-store' });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { error?: string };
        message = body.error ?? message;
      } catch {
        // Not JSON; keep the status line.
      }
      throw new CompanionHttpError(response.status, message);
    }
    return response;
  }
}

/** Call `onEvent` for each JSON line of a streamed response. */
export async function readNdjson(response: Response, onEvent: (event: CompanionStreamEvent) => void): Promise<void> {
  if (!response.body) {
    for (const line of (await response.text()).split('\n')) {
      if (line.trim()) onEvent(JSON.parse(line) as CompanionStreamEvent);
    }
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as CompanionStreamEvent);
      newline = buffer.indexOf('\n');
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) onEvent(JSON.parse(rest) as CompanionStreamEvent);
}

const STORAGE_KEY = 'aiembodied.companion';

/**
 * Where the connection details come from: the Android app opens the page with
 * #code=…&device=…&name=… (the fragment never reaches the server or its logs). In a browser,
 * the code typed into the pairing form is kept in localStorage.
 */
export function readConnection(location: Pick<Location, 'hash'>, storage: Storage | null): CompanionConnection | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  let saved: Partial<CompanionConnection> = {};
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') as Partial<CompanionConnection>;
  } catch {
    saved = {};
  }
  const deviceId = params.get('device') ?? saved.deviceId ?? `web-${randomId()}`;
  const deviceName = params.get('name') ?? saved.deviceName ?? 'Browser';
  const code = params.get('code') ?? saved.code ?? '';
  if (!params.get('device')) {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ ...saved, deviceId, deviceName }));
  }
  return code ? { baseUrl: '', code, deviceId, deviceName } : null;
}

export function saveBrowserCode(storage: Storage | null, code: string): void {
  let saved: Partial<CompanionConnection> = {};
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') as Partial<CompanionConnection>;
  } catch {
    saved = {};
  }
  storage?.setItem(STORAGE_KEY, JSON.stringify({ ...saved, code }));
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
