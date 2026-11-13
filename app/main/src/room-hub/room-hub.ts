/**
 * RoomHub: the server side of the room link (docs/features/room-link-protocol.md).
 *
 * A second desktop ("satellite") pairs once with a 6-digit code, then keeps one WebSocket open to this PC.
 * Over it the satellite asks for the data it needs to draw one room (a small allowlist of this app's IPC
 * channels, run through the very same handlers the local window uses), and this PC pushes events back.
 *
 * Safety, in short: the server listens only on 127.0.0.1 and on this PC's Tailscale addresses (never
 * 0.0.0.0), a token is checked on every connection (only its SHA-256 is stored), and a remote peer must be
 * the Tailscale node that paired, owned by the same login as this PC.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { PlaceManager } from '../places/place-manager.js';
import type { SwitchboardBus } from '../switchboard/bus.js';
import type { SwitchboardEventInput } from '../switchboard/types.js';
import { mimeFor, resolveAssetPath } from '../rooms/asset-protocol.js';
import { isAllowedChannel } from './allowlist.js';
import { FrameError, MAX_FRAME_BYTES, decodeMessage, encodeBinaryFrame, encodeMessage, type Op } from './frames.js';
import { getIpcHandler, type IpcHandler } from './ipc-registry.js';
import type { RoomDeviceRegistry } from './room-devices.js';
import type { TailscaleLookup } from './tailscale.js';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_HUB_PORT = 8791;
const HELLO_TIMEOUT_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 6000;
const RECHECK_MS = 60_000;
const MAX_PENDING_SOCKETS = 16;
const MAX_PAIR_BODY = 4096;

export interface RoomHubSettings {
  wakeWord: unknown | null;
  pushToTalk: unknown | null;
}

export interface RoomHubOptions {
  registry: RoomDeviceRegistry;
  places: PlaceManager;
  tailscale: TailscaleLookup;
  /** Folder the room asset protocol serves (`<userData>/rooms/assets`). */
  assetRoot: string;
  appVersion?: string;
  /** What `welcome` carries. */
  avatars: () => unknown[];
  settings: () => RoomHubSettings;
  bus?: () => SwitchboardBus | null;
  /** The handler main.ts registered for a channel. */
  handlerFor?: (channel: string) => IpcHandler | undefined;
  /** `presence`, `device.state` and `wake.heard` from a satellite. */
  onSatelliteMessage?: (from: { deviceId: string; placeId: string }, op: Op) => void;
  env?: NodeJS.ProcessEnv;
  /** 0 picks a free port (tests). */
  port?: number;
  /** Addresses to listen on. Default: loopback plus every local IPv4 address in 100.64.0.0/10. */
  listenAddresses?: () => string[];
  /** Loopback peers skip the Tailscale check (a satellite run on this PC for testing). False only in tests of the check itself. */
  trustLoopback?: boolean;
  helloTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  recheckMs?: number;
  logger?: Pick<Console, 'warn' | 'info' | 'debug'>;
}

export interface RoomHubDeviceStatus {
  id: string;
  name: string;
  placeId: string;
  online: boolean;
  lastSeen: number;
  tailscaleNode: string | null;
}

export interface RoomHubStatus {
  running: boolean;
  port: number | null;
  /** Addresses the server listens on. */
  addresses: string[];
  pairing: { code: string; expiresAt: number; placeName: string | null } | null;
  devices: RoomHubDeviceStatus[];
}

export interface PairingStart {
  code: string;
  expiresAt: number;
  /** Where to point the other PC (`http://<host>:<port>`). */
  urls: string[];
}

interface Connection {
  ws: WebSocket;
  address: string;
  deviceId: string | null;
  placeId: string | null;
  lastTraffic: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
  auth: Promise<void> | null;
  ready: boolean;
  closed: boolean;
}

/** True for 100.64.0.0/10, the range Tailscale hands out. */
export function isTailscaleAddress(address: string): boolean {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function tailscaleAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && isTailscaleAddress(entry.address)) out.push(entry.address);
  }
  return [...new Set(out)];
}

export function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.');
}

function peerOf(socket: { remoteAddress?: string }): string {
  const raw = socket.remoteAddress ?? '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/** "the study" -> "study"; unique among `taken`. */
export function slugPlaceId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .replace(/^\s*the\s+/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'room';
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export class RoomHub {
  private readonly options: RoomHubOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly servers = new Map<string, Server>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly sockets = new Set<Connection>();
  private readonly byDevice = new Map<string, Connection>();
  private readonly listeners = new Set<() => void>();
  private boundPort: number | null = null;
  private pairingName: string | null = null;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private offPlaces: (() => void) | null = null;
  private syncing: Promise<void> = Promise.resolve();
  private started = false;

  constructor(options: RoomHubOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
  }

  // -- Life cycle ----------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.offPlaces = this.options.places.onChanged(() => this.pushPlaces());
    this.recheckTimer = setInterval(() => void this.refresh(), this.options.recheckMs ?? RECHECK_MS);
    this.recheckTimer.unref?.();
    const timeout = this.options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), Math.max(10, Math.min(1000, Math.floor(timeout / 3))));
    this.heartbeatTimer.unref?.();
    await this.sync();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.offPlaces?.();
    this.offPlaces = null;
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.recheckTimer = this.heartbeatTimer = this.pairingTimer = null;
    await this.syncing.catch(() => undefined);
    await this.closeServers([...this.servers.keys()]);
  }

  /** Starts or stops the server as needed, and picks up new Tailscale addresses. */
  async refresh(): Promise<void> {
    if (!this.started) return;
    await this.sync();
    this.emitChanged();
  }

  private shouldRun(): boolean {
    const flag = this.env.ROOM_HUB_ENABLED;
    if (flag === '0') return false;
    if (flag === '1') return true;
    return this.options.registry.list().length > 0 || this.options.registry.activePairing() !== null;
  }

  private configuredPort(): number {
    if (this.options.port !== undefined) return this.options.port;
    const fromEnv = Number.parseInt(this.env.ROOM_HUB_PORT ?? '', 10);
    return Number.isInteger(fromEnv) && fromEnv >= 0 && fromEnv < 65536 ? fromEnv : DEFAULT_HUB_PORT;
  }

  private desiredAddresses(): string[] {
    if (!this.shouldRun()) return [];
    const addresses = this.options.listenAddresses ? this.options.listenAddresses() : ['127.0.0.1', ...tailscaleAddresses()];
    return [...new Set(addresses)];
  }

  private sync(): Promise<void> {
    this.syncing = this.syncing.catch(() => undefined).then(() => this.doSync());
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const wanted = this.desiredAddresses();
    await this.closeServers([...this.servers.keys()].filter((address) => !wanted.includes(address)));
    for (const address of wanted) {
      if (this.servers.has(address)) continue;
      const server = createServer((req, res) => void this.handleHttp(req, res));
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
      const port = this.boundPort ?? this.configuredPort();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen({ host: address, port }, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } catch (error) {
        this.options.logger?.warn('Room hub could not listen', { address, port, message: error instanceof Error ? error.message : String(error) });
        server.close();
        continue;
      }
      server.on('error', (error) => this.options.logger?.warn('Room hub server error', { address, message: error.message }));
      const bound = server.address();
      if (bound && typeof bound === 'object' && this.boundPort === null && this.configuredPort() === 0) this.boundPort = bound.port;
      this.servers.set(address, server);
    }
    if (this.servers.size === 0) this.boundPort = null;
  }

  private async closeServers(addresses: string[]): Promise<void> {
    for (const address of addresses) {
      const server = this.servers.get(address);
      if (!server) continue;
      this.servers.delete(address);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.servers.size === 0) {
      for (const conn of [...this.sockets]) conn.ws.terminate();
      this.boundPort = null;
    }
  }

  // -- Status and settings page --------------------------------------------------------------------

  port(): number | null {
    const first = this.servers.values().next().value as Server | undefined;
    const bound = first?.address();
    return bound && typeof bound === 'object' ? bound.port : null;
  }

  status(): RoomHubStatus {
    const pairing = this.options.registry.activePairing();
    return {
      running: this.servers.size > 0,
      port: this.port(),
      addresses: [...this.servers.keys()],
      pairing: pairing ? { ...pairing, placeName: this.pairingName } : null,
      devices: this.options.registry.list().map((device) => ({
        id: device.id,
        name: device.name,
        placeId: device.placeId,
        online: this.byDevice.get(device.id)?.ready === true,
        lastSeen: device.lastSeen,
        tailscaleNode: device.tailscaleNode,
      })),
    };
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A failing listener must not stop the others.
      }
    }
  }

  /** A new one-time code. `placeName` (typed on this PC) names the new room; the satellite's own name is the fallback. */
  async startPairing(placeName?: string): Promise<PairingStart> {
    const pairing = this.options.registry.startPairing();
    this.pairingName = placeName?.trim() ? placeName.trim().slice(0, 80) : null;
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = setTimeout(() => void this.refresh(), Math.max(0, pairing.expiresAt - Date.now()) + 50);
    this.pairingTimer.unref?.();
    await this.refresh();
    return { code: pairing.code, expiresAt: pairing.expiresAt, urls: await this.pairingUrls() };
  }

  async cancelPairing(): Promise<void> {
    this.options.registry.cancelPairing();
    this.pairingName = null;
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
    await this.refresh();
  }

  private async pairingUrls(): Promise<string[]> {
    const port = this.port();
    if (port === null) return [];
    const urls: string[] = [];
    const self = this.servers.size > 0 ? await this.options.tailscale.self() : null;
    if (self && [...this.servers.keys()].some(isTailscaleAddress)) urls.push(`http://${self.node}:${port}`);
    for (const address of this.servers.keys()) if (!isLoopback(address)) urls.push(`http://${address}:${port}`);
    for (const address of this.servers.keys()) if (isLoopback(address)) urls.push(`http://${address}:${port}`);
    return urls;
  }

  /** Forgets a desktop room: its token stops working, it is disconnected, its place goes and its avatars come home. */
  async revoke(deviceId: string): Promise<boolean> {
    const device = this.options.registry.revoke(deviceId);
    if (!device) return false;
    const conn = this.byDevice.get(deviceId);
    if (conn) {
      this.send(conn, { op: 'error', code: 'revoked', message: 'This desktop room was removed.' });
      this.closeConnection(conn, 1008, 'revoked');
    }
    this.options.places.removePlace(device.placeId);
    this.journal('place.revoked', device.placeId, { kind: 'service', id: 'room-hub' }, { placeId: device.placeId, deviceId, address: conn?.address ?? null });
    await this.refresh();
    return true;
  }

  /** Asks a satellite to turn its devices off. The hub can never turn them on. */
  deviceOff(deviceId: string, reason: string): boolean {
    const conn = this.byDevice.get(deviceId);
    if (!conn?.ready) return false;
    return this.send(conn, { op: 'device.off', reason });
  }

  /** Sends an op to a connected satellite (events the hub pushes on its own). */
  sendToDevice(deviceId: string, op: Op): boolean {
    const conn = this.byDevice.get(deviceId);
    return conn?.ready ? this.send(conn, op) : false;
  }

  /** Sends an op to the satellite that draws this place. False when none is connected there. */
  sendToPlace(placeId: string, op: Op): boolean {
    const deviceId = this.deviceForPlace(placeId);
    return deviceId ? this.sendToDevice(deviceId, op) : false;
  }

  /** Sends an op to every connected satellite. */
  sendToAll(op: Op): void {
    for (const conn of this.byDevice.values()) if (conn.ready) this.send(conn, op);
  }

  /** The device id of the satellite that draws this place, when connected. */
  deviceForPlace(placeId: string): string | null {
    for (const [deviceId, conn] of this.byDevice) if (conn.ready && conn.placeId === placeId) return deviceId;
    return null;
  }

  // -- Journal -------------------------------------------------------------------------------------

  /** Fire-and-forget, like the floor's journal. */
  private journal(type: string, scene: string | undefined, producer: SwitchboardEventInput['producer'], payload: Record<string, unknown>): void {
    try {
      const bus = this.options.bus?.();
      if (!bus) return;
      bus.publish({ type, producer, to: [], ...(scene ? { scene } : {}), audience: 'private', payload });
    } catch {
      // Journaling must never disturb the link.
    }
  }

  // -- HTTP: pairing -------------------------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...headers });
      res.end(text);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://hub');
      if (req.method === 'POST' && url.pathname === '/v1/pair') {
        await this.handlePair(req, reply);
        return;
      }
      reply(404, { error: 'not-found' });
    } catch (error) {
      this.options.logger?.warn('Room hub request failed', { message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) reply(500, { error: 'failed' });
    }
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PAIR_BODY) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(null));
    });
  }

  private needsPeerCheck(address: string): boolean {
    return !isLoopback(address) || this.options.trustLoopback === false;
  }

  private async handlePair(req: IncomingMessage, reply: (status: number, body: Record<string, unknown>, headers?: Record<string, string>) => void): Promise<void> {
    const { registry, places, tailscale } = this.options;
    const address = peerOf(req.socket);
    const lockedFor = registry.lockout.lockedFor(address);
    if (lockedFor > 0) {
      reply(429, { error: 'locked' }, { 'Retry-After': String(Math.ceil(lockedFor / 1000)) });
      return;
    }
    const raw = await this.readBody(req);
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    if (!body) {
      reply(400, { error: 'bad-request' });
      return;
    }
    if (!registry.codeMatches(body.code)) {
      const nowLocked = registry.lockout.fail(address);
      this.journal('place.refused', undefined, { kind: 'service', id: 'room-hub' }, { address, code: 'pairing-code' });
      reply(nowLocked ? 429 : 401, { error: nowLocked ? 'locked' : 'bad-code' }, nowLocked ? { 'Retry-After': '60' } : {});
      return;
    }
    // Who is asking: nobody to look up on this PC itself; anyone else must be a node of this PC's own Tailscale login.
    let node: string | null = null;
    let login: string | null = null;
    if (this.needsPeerCheck(address)) {
      const [peer, self] = await Promise.all([tailscale.whois(address), tailscale.self()]);
      if (!peer || !self || peer.login !== self.login) {
        this.journal('place.refused', undefined, { kind: 'service', id: 'room-hub' }, { address, code: 'peer' });
        reply(403, { error: 'peer' });
        return;
      }
      node = peer.node;
      login = peer.login;
    }
    // Used up here, after the awaits above: two pairings with one code cannot both win.
    if (!registry.consumeCode(body.code)) {
      reply(401, { error: 'bad-code' });
      return;
    }
    const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName : 'Desktop room';
    const requested = this.pairingName ?? (typeof body.placeName === 'string' && body.placeName.trim() ? body.placeName.trim().slice(0, 80) : 'the study');
    this.pairingName = null;
    const deviceId = `room-${randomBytes(6).toString('hex')}`;
    const placeId = slugPlaceId(requested, places.list().map((place) => place.id));
    const place = places.addPlace({ id: placeId, name: requested, node: deviceId });
    if (!place) {
      reply(500, { error: 'failed' });
      return;
    }
    let paired;
    try {
      paired = registry.addDevice({ id: deviceId, name: deviceName, placeId, tailscaleNode: node, tailscaleLogin: login });
    } catch (error) {
      places.removePlace(placeId);
      // Log the reason here; the unauthenticated caller only gets a fixed message.
      this.options.logger?.warn('Room hub could not add a device', { message: error instanceof Error ? error.message : String(error) });
      reply(409, { error: 'too-many-devices', message: 'Too many desktop rooms are paired. Revoke one on bija first.' });
      return;
    }
    this.journal('place.paired', placeId, { kind: 'service', id: 'room-hub' }, { placeId, deviceId, address, node });
    reply(200, { deviceId, token: paired.token, placeId, protocol: PROTOCOL_VERSION });
    void this.refresh();
  }

  // -- WebSocket -----------------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://hub').pathname;
    } catch {
      pathname = '';
    }
    const pending = [...this.sockets].filter((conn) => !conn.ready).length;
    if (pathname !== '/v1/link' || pending >= MAX_PENDING_SOCKETS) {
      socket.destroy();
      return;
    }
    const address = peerOf(req.socket);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, address));
  }

  private accept(ws: WebSocket, address: string): void {
    const conn: Connection = { ws, address, deviceId: null, placeId: null, lastTraffic: Date.now(), helloTimer: null, auth: null, ready: false, closed: false };
    this.sockets.add(conn);
    conn.helloTimer = setTimeout(() => {
      if (!conn.auth) {
        this.send(conn, { op: 'error', code: 'hello-timeout', message: 'No hello within 5 seconds.' });
        this.closeConnection(conn, 1008, 'hello timeout');
      }
    }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    conn.helloTimer.unref?.();
    ws.on('message', (data: RawData, isBinary: boolean) => {
      conn.lastTraffic = Date.now();
      void this.onMessage(conn, data, isBinary);
    });
    ws.on('close', () => this.cleanup(conn));
    ws.on('error', () => this.cleanup(conn));
  }

  private async onMessage(conn: Connection, data: RawData, isBinary: boolean): Promise<void> {
    let decoded;
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      decoded = decodeMessage(isBinary ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.toString('utf8'));
    } catch (error) {
      this.send(conn, { op: 'error', code: 'bad-frame', message: error instanceof FrameError ? error.message : 'Bad frame.' });
      return;
    }
    const { op } = decoded;
    if (op.op === 'hello') {
      if (conn.auth) {
        this.closeConnection(conn, 1008, 'second hello');
        return;
      }
      conn.auth = this.hello(conn, op);
      await conn.auth;
      return;
    }
    if (!conn.auth) {
      this.send(conn, { op: 'error', code: 'auth', message: 'Say hello first.' });
      this.closeConnection(conn, 1008, 'no hello');
      return;
    }
    await conn.auth;
    if (!conn.ready || conn.closed || !conn.deviceId || !conn.placeId) return;
    const ref = typeof op.ref === 'string' ? op.ref : undefined;
    switch (op.op) {
      case 'ping':
        this.send(conn, { op: 'pong', t: op.t });
        return;
      case 'call':
        await this.handleCall(conn, op, ref);
        return;
      case 'asset.get':
        await this.handleAsset(conn, op, ref);
        return;
      case 'presence':
      case 'device.state':
      case 'wake.heard':
        this.options.onSatelliteMessage?.({ deviceId: conn.deviceId, placeId: conn.placeId }, op);
        return;
      default:
        this.send(conn, { op: 'error', ...(ref ? { ref } : {}), code: 'unknown-op', message: `Unknown op ${String(op.op).slice(0, 40)}.` });
    }
  }

  private refuse(conn: Connection, address: string, code: 'auth' | 'peer' | 'protocol', extra: Record<string, unknown> = {}): void {
    this.journal('place.refused', undefined, { kind: 'service', id: 'room-hub' }, { address, code });
    this.send(conn, { op: 'error', code, message: code === 'auth' ? 'Not paired.' : code === 'peer' ? 'This PC is not the one that paired.' : 'Protocol mismatch.', ...extra });
    this.closeConnection(conn, 1008, code);
  }

  private async hello(conn: Connection, op: Op): Promise<void> {
    const { registry, places, tailscale } = this.options;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    if (op.protocol !== PROTOCOL_VERSION) {
      this.refuse(conn, conn.address, 'protocol', { hub: PROTOCOL_VERSION, client: op.protocol ?? null });
      return;
    }
    const deviceId = typeof op.deviceId === 'string' ? op.deviceId : '';
    const token = typeof op.token === 'string' ? op.token : '';
    const device = registry.get(deviceId);
    if (!registry.verifyToken(deviceId, token) || !device) {
      this.refuse(conn, conn.address, 'auth');
      return;
    }
    if (this.needsPeerCheck(conn.address)) {
      const [peer, self] = await Promise.all([tailscale.whois(conn.address), tailscale.self()]);
      if (conn.closed) return;
      if (!peer || !self || !device.tailscaleNode || peer.node !== device.tailscaleNode || peer.login !== self.login) {
        this.refuse(conn, conn.address, 'peer');
        return;
      }
    }
    const place = places.get(device.placeId);
    if (!place) {
      this.refuse(conn, conn.address, 'auth');
      return;
    }
    // One connection per device: the newest hello wins.
    const previous = this.byDevice.get(deviceId);
    conn.deviceId = deviceId;
    conn.placeId = place.id;
    this.byDevice.set(deviceId, conn);
    if (previous) {
      this.send(previous, { op: 'error', code: 'replaced', message: 'Another connection took over.' });
      this.closeConnection(previous, 1000, 'replaced');
    }
    registry.touch(deviceId);
    // Online first (it pushes places:changed to the others, not to this socket yet), then the welcome with the fresh snapshot.
    places.setOnline(place.id, true);
    const settings = this.options.settings();
    this.send(conn, {
      op: 'welcome',
      protocol: PROTOCOL_VERSION,
      placeId: place.id,
      place: places.get(place.id),
      snapshot: places.snapshot(place.id),
      avatars: this.options.avatars(),
      settings: { wakeWord: settings.wakeWord ?? null, pushToTalk: settings.pushToTalk ?? null },
    });
    conn.ready = true;
    this.journal('place.online', place.id, { kind: 'device', id: deviceId }, { placeId: place.id, deviceId, address: conn.address });
    this.emitChanged();
  }

  private async handleCall(conn: Connection, op: Op, ref: string | undefined): Promise<void> {
    const fail = (code: string, message: string): void => void this.send(conn, { op: 'error', ...(ref ? { ref } : {}), code, message });
    if (!ref) {
      fail('bad-request', 'A call needs a ref.');
      return;
    }
    const channel = op.channel;
    if (!isAllowedChannel(channel)) {
      fail('denied', 'That channel is not available to a desktop room.');
      return;
    }
    const args = Array.isArray(op.args) ? (op.args as unknown[]) : [];
    const { places } = this.options;
    try {
      let value: unknown;
      if (channel === 'places:snapshot') {
        // Relative to the satellite: its own place is the local one.
        value = places.snapshot(conn.placeId as string);
      } else if (channel === 'places:arrived' && !places.snapshot().transit.some((move) => move.avatarId === args[0] && move.to === conn.placeId)) {
        // Only the place an avatar is walking to may confirm its arrival.
        value = undefined;
      } else {
        const handler = (this.options.handlerFor ?? getIpcHandler)(channel);
        if (!handler) {
          fail('unavailable', 'That channel is not available on this PC.');
          return;
        }
        const event = {
          sender: {
            id: -1,
            send: (eventChannel: string, ...eventArgs: unknown[]) => void this.send(conn, { op: 'ipc', channel: eventChannel, args: eventArgs }),
            isDestroyed: () => conn.closed,
          },
          senderFrame: null,
          // Handlers that depend on where the caller is (who is present, which floor) read this.
          placeId: conn.placeId,
        };
        value = await (handler as (event: unknown, ...rest: unknown[]) => unknown)(event, ...args);
      }
      if (!this.send(conn, { op: 'result', ref, value: value === undefined ? null : value }) && !conn.closed) {
        fail('too-large', 'The answer is too large to send.');
      }
    } catch (error) {
      fail('failed', error instanceof Error ? error.message : String(error));
    }
  }

  private async handleAsset(conn: Connection, op: Op, ref: string | undefined): Promise<void> {
    const fail = (code: string, message: string): void => void this.send(conn, { op: 'error', ...(ref ? { ref } : {}), code, message });
    if (!ref) {
      fail('bad-request', 'An asset request needs a ref.');
      return;
    }
    const file = typeof op.url === 'string' ? resolveAssetPath(this.options.assetRoot, op.url) : null;
    if (!file) {
      fail('not-found', 'No such asset.');
      return;
    }
    try {
      const data = await readFile(file);
      if (conn.closed) return;
      conn.ws.send(encodeBinaryFrame({ op: 'asset', ref, mime: mimeFor(file) }, data), { binary: true });
    } catch (error) {
      fail(error instanceof FrameError ? 'too-large' : 'not-found', 'No such asset.');
    }
  }

  /** The places snapshot, seen from each satellite's own place. */
  private pushPlaces(): void {
    for (const conn of this.byDevice.values()) {
      if (!conn.ready || !conn.placeId) continue;
      this.send(conn, { op: 'ipc', channel: 'places:changed', args: [this.options.places.snapshot(conn.placeId)] });
    }
    this.emitChanged();
  }

  private send(conn: Connection, op: Op): boolean {
    if (conn.closed || conn.ws.readyState !== 1) return false;
    try {
      const frame = encodeMessage(op);
      conn.ws.send(frame, { binary: typeof frame !== 'string' });
      return true;
    } catch (error) {
      this.options.logger?.warn('Room hub could not send', { op: op.op, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  private closeConnection(conn: Connection, code: number, reason: string): void {
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
    this.cleanup(conn);
  }

  private checkHeartbeats(): void {
    const limit = this.options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    const time = Date.now();
    for (const conn of [...this.sockets]) {
      if (conn.ready && time - conn.lastTraffic > limit) {
        conn.ws.terminate();
        this.cleanup(conn);
      }
    }
  }

  /** The socket is gone (closed, dropped, timed out). Idempotent. A replaced connection does not take the place offline. */
  private cleanup(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    this.sockets.delete(conn);
    if (!conn.deviceId || !conn.placeId || this.byDevice.get(conn.deviceId) !== conn) return;
    this.byDevice.delete(conn.deviceId);
    this.options.places.setOnline(conn.placeId, false);
    this.journal('place.offline', conn.placeId, { kind: 'device', id: conn.deviceId }, { placeId: conn.placeId, deviceId: conn.deviceId, address: conn.address });
    this.emitChanged();
  }
}
