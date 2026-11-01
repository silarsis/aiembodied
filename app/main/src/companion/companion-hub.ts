/**
 * The desktop end of the phone companion: an HTTP server on the LAN that serves the phone page,
 * runs the phone's turns through the same conversation pipeline as the desktop (so it is one
 * assistant with one memory), and keeps a push stream open to each phone so the desktop can
 * send it messages and scene changes. See ./types.ts for the protocol.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { LocalVoiceEvent, LocalVoiceRespondRequest, LocalVoiceRespondResult, LocalVoiceTranscribeResult } from '../local-voice/types.js';
import type { AvatarMotionChunkEvent, AvatarMotionStreamRequest, AvatarMotionStreamResult } from '../avatar/types.js';
import {
  CompanionRegistry,
  cleanDeviceName,
  formatPairingCode,
  isValidDeviceId,
} from './companion-registry.js';
import type {
  CompanionDevice,
  CompanionHubApi,
  CompanionSayRequest,
  CompanionSayResult,
  CompanionScene,
  CompanionStatus,
  CompanionStreamEvent,
} from './types.js';

type Logger = Pick<Console, 'info' | 'warn' | 'error' | 'debug'>;

export const DEFAULT_COMPANION_PORT = 8790;
const MAX_UTTERANCE_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const PING_INTERVAL_MS = 15_000;
const AUTH_FAILURE_LIMIT = 10;
const AUTH_FAILURE_WINDOW_MS = 60_000;

export interface CompanionVoice {
  transcribe(wav: Uint8Array): Promise<LocalVoiceTranscribeResult>;
  respond(request: LocalVoiceRespondRequest, emit: (event: LocalVoiceEvent) => void): Promise<LocalVoiceRespondResult>;
  cancel(requestId?: string): void;
  speak(requestId: string, text: string, emit: (event: LocalVoiceEvent) => void, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface CompanionHubOptions {
  registry: CompanionRegistry;
  /** The renderer build (dist/), holding companion.html and assets/. */
  staticDirectory: string | null;
  getScene(): Promise<CompanionScene>;
  loadAvatar(id: string): Promise<ArrayBuffer | Uint8Array>;
  /** The background image as a data: URL (what BackgroundService.load returns). */
  loadBackground(id: string): Promise<string>;
  loadAnimation(id: string): Promise<ArrayBuffer | Uint8Array>;
  loadPose(id: string): Promise<unknown>;
  getVoice(): CompanionVoice | null;
  /** The desktop's current system prompt (persona, avatar description, animation list). */
  getInstructions(): string | undefined;
  /** Live motion, when the local motion service is up. */
  getMotion?(): ((request: AvatarMotionStreamRequest, onChunk: (chunk: AvatarMotionChunkEvent) => void) => Promise<AvatarMotionStreamResult>) | null;
  /** Each finished phone turn, for the conversation log. */
  onTranscript?(entry: { role: 'user' | 'assistant'; text: string; deviceId: string }): void;
  /** Devices connected, disconnected or seen. */
  onStatusChange?(status: CompanionStatus): void;
  logger?: Logger;
  now?: () => number;
}

interface Client {
  deviceId: string;
  address: string | null;
}

interface PushConnection {
  deviceId: string;
  response: http.ServerResponse;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.vrm': 'model/gltf-binary',
  '.vrma': 'model/gltf-binary',
};

export class CompanionHub implements CompanionHubApi {
  private server: http.Server | null = null;
  private port = DEFAULT_COMPANION_PORT;
  private enabled = false;
  private running = false;
  private error: string | null = null;
  private readonly pushes = new Set<PushConnection>();
  private readonly authFailures = new Map<string, { count: number; since: number }>();
  private pingTimer: NodeJS.Timeout | null = null;
  private sceneTimer: NodeJS.Timeout | null = null;
  private readonly options: CompanionHubOptions;
  private readonly logger?: Logger;
  private readonly now: () => number;

  constructor(options: CompanionHubOptions) {
    this.options = options;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /** Start, stop or move the server to match the Settings page. */
  async apply(settings: { enabled: boolean; port: number }): Promise<void> {
    const port = Number.isInteger(settings.port) && settings.port >= 0 && settings.port < 65536 ? settings.port : DEFAULT_COMPANION_PORT;
    if (settings.enabled === this.enabled && port === this.port && (this.running || !settings.enabled)) {
      return;
    }
    this.enabled = settings.enabled;
    this.port = port;
    await this.stop();
    if (settings.enabled) {
      await this.start();
    }
    this.emitStatus();
  }

  /** The port actually listened on (differs from the setting only when it is 0, in tests). */
  get listeningPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? (address as AddressInfo).port : null;
  }

  getStatus(): CompanionStatus {
    const connected = new Set([...this.pushes].map((push) => push.deviceId));
    const devices: CompanionDevice[] = this.options.registry
      .list()
      .map((device) => ({ ...device, connected: connected.has(device.id) }));
    const port = this.listeningPort ?? this.port;
    return {
      enabled: this.enabled,
      port,
      running: this.running,
      error: this.error,
      pairingCode: formatPairingCode(this.options.registry.pairingCode),
      urls: lanAddresses().map((address) => `http://${address.includes(':') ? `[${address}]` : address}:${port}`),
      devices,
    };
  }

  async rotatePairingCode(): Promise<CompanionStatus> {
    await this.options.registry.rotate();
    // Phones paired with the old code are dropped now, not at their next request.
    for (const push of [...this.pushes]) {
      push.response.end();
    }
    this.emitStatus();
    return this.getStatus();
  }

  async forgetDevice(deviceId: string): Promise<CompanionStatus> {
    await this.options.registry.forget(deviceId);
    this.emitStatus();
    return this.getStatus();
  }

  /** Speak a message on one phone, or on every connected one. */
  async say(request: CompanionSayRequest): Promise<CompanionSayResult> {
    const text = typeof request.text === 'string' ? request.text.trim() : '';
    if (!text) {
      throw new Error('Nothing to say.');
    }
    const targets = [...this.pushes].filter((push) => !request.deviceId || push.deviceId === request.deviceId);
    const delivered = [...new Set(targets.map((push) => push.deviceId))];
    if (targets.length === 0) {
      return { delivered };
    }
    const voice = this.options.getVoice();
    const requestId = `say-${randomUUID()}`;
    const send = (event: CompanionStreamEvent) => {
      for (const push of targets) {
        writeLine(push.response, event);
      }
    };
    send({ type: 'say', requestId, text });
    if (!voice) {
      send({ type: 'error', requestId, message: 'The voice pipeline is unavailable.' });
      send({ type: 'done', requestId, text, cancelled: false });
      return { delivered };
    }
    try {
      await voice.speak(requestId, text, (event) => send(toStreamEvent(event)));
    } catch (error) {
      send({ type: 'error', requestId, message: errorMessage(error) });
    }
    send({ type: 'done', requestId, text, cancelled: false });
    this.options.onTranscript?.({ role: 'assistant', text, deviceId: delivered.join(',') });
    return { delivered };
  }

  /** The avatar, background or animation list changed on the desktop; phones follow along. */
  notifySceneChanged(): void {
    if (this.sceneTimer) {
      clearTimeout(this.sceneTimer);
    }
    this.sceneTimer = setTimeout(() => {
      this.sceneTimer = null;
      if (this.pushes.size === 0) {
        return;
      }
      this.options
        .getScene()
        .then((scene) => {
          for (const push of this.pushes) {
            writeLine(push.response, { type: 'scene', scene });
          }
        })
        .catch((error: unknown) => this.logger?.warn('Companion: scene update failed', { message: errorMessage(error) }));
    }, 250);
  }

  async stop(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const push of [...this.pushes]) {
      push.response.end();
    }
    this.pushes.clear();
    const server = this.server;
    this.server = null;
    this.running = false;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.logger?.info('Companion server stopped');
    }
  }

  private async start(): Promise<void> {
    // The registry file is only read (and created) once the companion is turned on.
    await this.options.registry.ensureLoaded();
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.error =
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Port ${this.port} is already in use. Pick another one.`
          : errorMessage(error);
      this.logger?.error('Companion server failed to start', { port: this.port, message: this.error });
      return;
    }
    server.on('error', (error) => this.logger?.error('Companion server error', { message: errorMessage(error) }));
    this.server = server;
    this.running = true;
    this.error = null;
    this.pingTimer = setInterval(() => {
      for (const push of this.pushes) {
        writeLine(push.response, { type: 'ping', ts: this.now() });
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    this.logger?.info('Companion server listening', { port: this.listeningPort, urls: this.getStatus().urls });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(request.url ?? '/', 'http://companion.invalid');
    try {
      if (url.pathname.startsWith('/api/')) {
        const client = this.authenticate(request);
        await this.handleApi(request, response, url, client);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        await this.serveStatic(url.pathname, response);
      } else {
        throw new HttpError(405, 'Method not allowed.');
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) {
        this.logger?.error('Companion request failed', { path: url.pathname, message: errorMessage(error) });
      }
      if (!response.headersSent) {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: errorMessage(error) }));
      } else if (!response.writableEnded) {
        writeLine(response, { type: 'error', requestId: '', message: errorMessage(error) });
        response.end();
      }
    }
  }

  private authenticate(request: http.IncomingMessage): Client {
    const address = request.socket.remoteAddress ?? 'unknown';
    const failures = this.authFailures.get(address);
    const time = this.now();
    if (failures && time - failures.since > AUTH_FAILURE_WINDOW_MS) {
      this.authFailures.delete(address);
    } else if (failures && failures.count >= AUTH_FAILURE_LIMIT) {
      throw new HttpError(429, 'Too many wrong pairing codes. Wait a minute and try again.');
    }

    const header = request.headers.authorization ?? '';
    const code = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!this.options.registry.matches(code)) {
      const entry = this.authFailures.get(address) ?? { count: 0, since: time };
      entry.count += 1;
      this.authFailures.set(address, entry);
      if (entry.count === AUTH_FAILURE_LIMIT) {
        this.logger?.warn('Companion: too many wrong pairing codes', { address });
      }
      throw new HttpError(401, 'Wrong pairing code. Check Settings → Phone companion on the desktop.');
    }
    this.authFailures.delete(address);

    const deviceId = request.headers['x-companion-device'];
    if (!isValidDeviceId(deviceId)) {
      throw new HttpError(400, 'Missing or invalid X-Companion-Device header.');
    }
    const rawName = request.headers['x-companion-name'];
    const name = cleanDeviceName(typeof rawName === 'string' ? safeDecode(rawName) : undefined, 'Phone');
    const known = this.options.registry.get(deviceId);
    this.options.registry.touch(deviceId, name, stripIpv6Prefix(address));
    if (!known) {
      this.logger?.info('Companion: new device paired', { deviceId, name, address });
      this.emitStatus();
    }
    return { deviceId, address };
  }

  private async handleApi(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    client: Client,
  ): Promise<void> {
    const route = `${request.method} ${url.pathname}`;
    const idFrom = (prefix: string) => decodeURIComponent(url.pathname.slice(prefix.length));

    if (route === 'GET /api/hello') {
      return sendJson(response, { ok: true, app: 'aiembodied', deviceId: client.deviceId });
    }
    if (route === 'GET /api/scene') {
      return sendJson(response, await this.options.getScene());
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/avatar/')) {
      return sendBinary(response, await this.options.loadAvatar(idFrom('/api/avatar/')), 'model/gltf-binary');
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/animations/')) {
      return sendBinary(response, await this.options.loadAnimation(idFrom('/api/animations/')), 'model/gltf-binary');
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/poses/')) {
      return sendJson(response, await this.options.loadPose(idFrom('/api/poses/')));
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/background/')) {
      const image = decodeDataUrl(await this.options.loadBackground(idFrom('/api/background/')));
      return sendBinary(response, image.data, image.mime);
    }
    if (route === 'GET /api/events') {
      return this.openPush(request, response, client);
    }
    if (route === 'POST /api/turn') {
      return this.runTurn(request, response, client);
    }
    if (route === 'POST /api/cancel') {
      const body = (await readJson(request)) as { requestId?: unknown };
      this.options.getVoice()?.cancel(typeof body.requestId === 'string' ? body.requestId : undefined);
      return sendJson(response, { ok: true });
    }
    if (route === 'POST /api/motion') {
      return this.runMotion(request, response);
    }
    if (route === 'POST /api/say') {
      const body = (await readJson(request)) as Partial<CompanionSayRequest>;
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw new HttpError(400, 'Body must be {"text": "...", "deviceId"?: "..."}');
      }
      const result = await this.say({ text: body.text, deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined });
      return sendJson(response, result);
    }
    throw new HttpError(404, 'Not found.');
  }

  private openPush(request: http.IncomingMessage, response: http.ServerResponse, client: Client): void {
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    request.socket.setNoDelay(true);
    request.socket.setKeepAlive(true, 30_000);
    const push: PushConnection = { deviceId: client.deviceId, response };
    this.pushes.add(push);
    this.logger?.info('Companion: device connected', { deviceId: client.deviceId, address: client.address });
    this.emitStatus();
    response.on('close', () => {
      this.pushes.delete(push);
      this.logger?.info('Companion: device disconnected', { deviceId: client.deviceId });
      this.emitStatus();
    });
    writeLine(response, { type: 'ping', ts: this.now() });
    this.options
      .getScene()
      .then((scene) => writeLine(response, { type: 'scene', scene }))
      .catch((error: unknown) => this.logger?.warn('Companion: scene failed', { message: errorMessage(error) }));
  }

  /** One spoken turn: the phone's utterance (a WAV body) in, NDJSON events out. */
  private async runTurn(request: http.IncomingMessage, response: http.ServerResponse, client: Client): Promise<void> {
    const voice = this.options.getVoice();
    if (!voice) {
      throw new HttpError(503, 'The voice pipeline is unavailable on the desktop.');
    }
    const wav = await readBody(request, MAX_UTTERANCE_BYTES);
    if (wav.length < 44) {
      throw new HttpError(400, 'Body must be a WAV file.');
    }
    const requestId = `phone-${randomUUID()}`;
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    request.socket.setNoDelay(true);
    let finished = false;
    response.on('close', () => {
      if (!finished) {
        voice.cancel(requestId);
      }
    });

    const transcript = await voice.transcribe(wav);
    const text = transcript.text.trim();
    writeLine(response, { type: 'transcript', requestId, text });
    if (!text) {
      finished = true;
      writeLine(response, { type: 'done', requestId, text: '', cancelled: false });
      response.end();
      return;
    }
    this.logger?.info('Companion: turn', { deviceId: client.deviceId, chars: text.length });
    this.options.onTranscript?.({ role: 'user', text, deviceId: client.deviceId });
    const result = await voice.respond(
      { requestId, text, instructions: this.options.getInstructions() },
      (event) => writeLine(response, toStreamEvent(event)),
    );
    finished = true;
    if (result.text) {
      this.options.onTranscript?.({ role: 'assistant', text: result.text, deviceId: client.deviceId });
    }
    writeLine(response, { type: 'done', requestId, text: result.text, cancelled: result.cancelled });
    response.end();
  }

  /** A {move:…} tag on the phone: stream the motion chunks back as they are generated. */
  private async runMotion(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const body = (await readJson(request)) as Partial<AvatarMotionStreamRequest>;
    if (typeof body.streamId !== 'string' || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      throw new HttpError(400, 'Body must be {"streamId": "...", "prompt": "..."}');
    }
    const stream = this.options.getMotion?.() ?? null;
    if (!stream) {
      throw new HttpError(503, 'Live motion is unavailable on the desktop.');
    }
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    request.socket.setNoDelay(true);
    const result = await stream(
      { streamId: body.streamId, prompt: body.prompt.trim().slice(0, 200), duration: body.duration, avatarRest: body.avatarRest },
      (chunk) => writeLine(response, { type: 'motion', ...chunk }),
    );
    writeLine(response, { type: 'done', requestId: result.streamId, text: '', cancelled: false });
    response.end();
  }

  private async serveStatic(pathname: string, response: http.ServerResponse): Promise<void> {
    const root = this.options.staticDirectory;
    if (!root) {
      throw new HttpError(404, 'The phone page is not built. Run pnpm build.');
    }
    const relative = pathname === '/' || pathname === '/index.html' ? 'companion.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    if (relative !== 'companion.html' && !relative.startsWith('assets/')) {
      throw new HttpError(404, 'Not found.');
    }
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep)) {
      throw new HttpError(404, 'Not found.');
    }
    let size: number;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) {
        throw new Error('not a file');
      }
      size = stat.size;
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': size,
      // Built assets have content hashes in their names; the page itself must always be fresh.
      'Cache-Control': relative === 'companion.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(response);
    });
  }

  private emitStatus(): void {
    this.options.onStatusChange?.(this.getStatus());
  }
}

function toStreamEvent(event: LocalVoiceEvent): CompanionStreamEvent {
  if (event.type === 'sentence') {
    return { ...event, wav: Buffer.from(event.wav).toString('base64') };
  }
  return event;
}

function writeLine(response: http.ServerResponse, event: CompanionStreamEvent): void {
  if (!response.writableEnded && !response.destroyed) {
    response.write(`${JSON.stringify(event)}\n`);
  }
}

function sendJson(response: http.ServerResponse, value: unknown): void {
  const body = JSON.stringify(value ?? null);
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(body);
}

function sendBinary(response: http.ServerResponse, data: ArrayBuffer | Uint8Array, contentType: string): void {
  const buffer = data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
  response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': buffer.length, 'Cache-Control': 'no-cache' });
  response.end(buffer);
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      throw new HttpError(413, 'Request body too large.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request, MAX_JSON_BYTES);
  if (body.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Body must be JSON.');
  }
}

export function decodeDataUrl(value: string): { data: Buffer; mime: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) {
    throw new HttpError(500, 'Background image is not a data URL.');
  }
  const mime = match[1] ?? 'application/octet-stream';
  const data = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  return { data, mime };
}

/** IPv4 addresses on the LAN (and Tailscale's 100.x), the ones a phone could reach. */
export function lanAddresses(interfaces = os.networkInterfaces()): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

function stripIpv6Prefix(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
