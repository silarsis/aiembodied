import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { PlaceManager } from '../../src/places/place-manager.js';
import { RoomDeviceRegistry } from '../../src/room-hub/room-devices.js';
import { RoomHub, isLoopback, isTailscaleAddress, slugPlaceId, tailscaleAddresses } from '../../src/room-hub/room-hub.js';
import { isAllowedChannel } from '../../src/room-hub/allowlist.js';
import { decodeMessage, encodeBinaryFrame, encodeMessage, type Op } from '../../src/room-hub/frames.js';
import type { TailscaleIdentity, TailscaleLookup } from '../../src/room-hub/tailscale.js';
import type { SwitchboardBus } from '../../src/switchboard/bus.js';
import type { SwitchboardEventInput } from '../../src/switchboard/types.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Collects everything the hub sends, so a test can wait for the next op of a kind. */
class Client {
  readonly messages: Array<{ op: Op; payload: Uint8Array | null }> = [];
  closed: { code: number; reason: string } | null = null;
  private readonly waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const decoded = decodeMessage(isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString('utf8'));
      this.messages.push(decoded);
      this.waiters.splice(0).forEach((wake) => wake());
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.waiters.splice(0).forEach((wake) => wake());
    });
    ws.on('error', () => undefined);
  }

  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/link`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const client = new Client(ws);
    cleanups.push(() => ws.terminate());
    return client;
  }

  send(op: Op | string | Uint8Array): void {
    this.ws.send(typeof op === 'string' || op instanceof Uint8Array ? op : encodeMessage(op));
  }

  async next(match: (op: Op) => boolean, timeoutMs = 3000): Promise<{ op: Op; payload: Uint8Array | null }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.messages.findIndex((message) => match(message.op));
      if (index >= 0) return this.messages.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`No matching message. Got: ${JSON.stringify(this.messages.map((message) => message.op.op))}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  async waitClosed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('Socket did not close.');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return this.closed;
  }
}

interface Options {
  heartbeatTimeoutMs?: number;
  graceMs?: number;
  tailscale?: TailscaleLookup;
  env?: NodeJS.ProcessEnv;
  trustLoopback?: boolean;
  handlers?: Record<string, (event: { sender: { send: (channel: string, ...args: unknown[]) => void; isDestroyed(): boolean } }, ...args: unknown[]) => unknown>;
}

async function startHub(options: Options = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), 'room-hub-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const assetRoot = path.join(folder, 'assets');
  mkdirSync(path.join(assetRoot, 'polyhaven', 'chair'), { recursive: true });
  writeFileSync(path.join(assetRoot, 'polyhaven', 'chair', 'chair.glb'), Buffer.from([1, 2, 3, 4, 5]));
  const data = new Map<string, string>();
  const store = { getValue: (key: string) => data.get(key) ?? null, setValue: (key: string, value: string) => void data.set(key, value) };
  const published: SwitchboardEventInput[] = [];
  const bus = { publish: (event: SwitchboardEventInput) => (published.push(event), null) } as unknown as SwitchboardBus;
  const places = new PlaceManager({ store, registry: { list: () => PROFILES }, bus: () => bus, graceMs: options.graceMs ?? 60_000 });
  const registry = new RoomDeviceRegistry(path.join(folder, 'room-devices.json'));
  const handlers = options.handlers ?? {};
  const hub = new RoomHub({
    registry,
    places,
    tailscale: options.tailscale ?? { whois: async () => null, self: async () => null },
    assetRoot,
    avatars: () => PROFILES,
    settings: () => ({ wakeWord: { model: 'hey_echo' }, pushToTalk: null }),
    bus: () => bus,
    handlerFor: (channel) => handlers[channel] as never,
    env: options.env ?? {},
    trustLoopback: options.trustLoopback,
    port: 0,
    listenAddresses: () => ['127.0.0.1'],
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    helloTimeoutMs: 300,
  });
  await hub.start();
  cleanups.push(() => hub.stop());
  return { hub, places, registry, published, folder };
}

async function pair(hub: RoomHub, body: Record<string, unknown> = {}) {
  const started = await hub.startPairing();
  const response = await fetch(`http://127.0.0.1:${hub.port()}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: started.code, deviceName: "Kevin's desk", placeName: 'the study', ...body }),
  });
  return { response, json: (await response.json()) as Record<string, unknown>, code: started.code };
}

async function connect(hub: RoomHub, paired: Record<string, unknown>) {
  const client = await Client.open(hub.port() as number);
  client.send({ op: 'hello', protocol: 1, deviceId: paired.deviceId, token: paired.token, appVersion: 'test' });
  return client;
}

describe('RoomHub', () => {
  it('stays off until a code is made or a device is paired, and honours ROOM_HUB_ENABLED', async () => {
    const idle = await startHub();
    expect(idle.hub.status().running).toBe(false);
    expect(idle.hub.port()).toBeNull();
    await idle.hub.startPairing();
    expect(idle.hub.status().running).toBe(true);
    await idle.hub.cancelPairing();
    expect(idle.hub.status().running).toBe(false);

    const forced = await startHub({ env: { ROOM_HUB_ENABLED: '1' } });
    expect(forced.hub.status().running).toBe(true);
    const off = await startHub({ env: { ROOM_HUB_ENABLED: '0' } });
    await off.hub.startPairing();
    expect(off.hub.status().running).toBe(false);
  });

  it('pairs with a code: makes a device and a place, once', async () => {
    const { hub, places, registry, published } = await startHub();
    const { response, json, code } = await pair(hub);
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ placeId: 'study', protocol: 1 });
    expect(json.deviceId).toMatch(/^room-/);
    expect(typeof json.token).toBe('string');
    expect(places.get('study')).toMatchObject({ name: 'the study', node: json.deviceId });
    expect(registry.get(json.deviceId as string)).toMatchObject({ name: "Kevin's desk", placeId: 'study', tailscaleNode: null });
    expect(published.map((event) => event.type)).toContain('place.paired');
    // The code is one-time.
    const again = await fetch(`http://127.0.0.1:${hub.port()}/v1/pair`, { method: 'POST', body: JSON.stringify({ code }) });
    expect(again.status).toBe(401);
    // The hub keeps running because a device is paired now.
    expect(hub.status().running).toBe(true);
  });

  it('uses the room name typed on bija over the one the satellite sends, and keeps place ids unique', async () => {
    const { hub, places } = await startHub();
    await hub.startPairing('Attic');
    let response = await fetch(`http://127.0.0.1:${hub.port()}/v1/pair`, { method: 'POST', body: JSON.stringify({ code: hub.status().pairing?.code, placeName: 'the study' }) });
    expect(((await response.json()) as { placeId: string }).placeId).toBe('attic');
    await hub.startPairing('Attic');
    response = await fetch(`http://127.0.0.1:${hub.port()}/v1/pair`, { method: 'POST', body: JSON.stringify({ code: hub.status().pairing?.code }) });
    expect(((await response.json()) as { placeId: string }).placeId).toBe('attic-2');
    expect(places.list().map((place) => place.id)).toEqual(['home', 'next-door', 'attic', 'attic-2']);
  });

  it('refuses a wrong code (401), journals it, and locks the address out after 10 (429)', async () => {
    const { hub, published } = await startHub();
    await hub.startPairing();
    const url = `http://127.0.0.1:${hub.port()}/v1/pair`;
    const wrong = async () => (await fetch(url, { method: 'POST', body: JSON.stringify({ code: '000000x' }) })).status;
    for (let i = 0; i < 9; i += 1) expect(await wrong()).toBe(401);
    expect(await wrong()).toBe(429);
    // Even the right code is refused now.
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ code: hub.status().pairing?.code }) })).status).toBe(429);
    expect(published.filter((event) => event.type === 'place.refused')).toHaveLength(10);
    expect(published.find((event) => event.type === 'place.refused')?.payload).toMatchObject({ address: '127.0.0.1', code: 'pairing-code' });
  });

  it('answers 404 to other paths and 400 to a body that is not JSON', async () => {
    const { hub } = await startHub();
    await hub.startPairing();
    const base = `http://127.0.0.1:${hub.port()}`;
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/v1/pair`, { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('welcomes a paired satellite with its place, snapshot, avatars and settings', async () => {
    const { hub, places, published } = await startHub();
    const { json } = await pair(hub);
    const client = await connect(hub, json);
    const { op } = await client.next((message) => message.op === 'welcome');
    expect(op).toMatchObject({
      protocol: 1,
      placeId: 'study',
      place: { id: 'study', name: 'the study', node: json.deviceId, online: true },
      avatars: PROFILES,
      settings: { wakeWord: { model: 'hey_echo' }, pushToTalk: null },
    });
    const snapshot = op.snapshot as ReturnType<PlaceManager['snapshot']>;
    expect(snapshot.localPlaceId).toBe('study');
    expect(snapshot.places.find((place) => place.id === 'study')?.online).toBe(true);
    expect(places.isOnline('study')).toBe(true);
    expect(hub.status().devices[0]).toMatchObject({ placeId: 'study', online: true });
    expect(published.find((event) => event.type === 'place.online')).toMatchObject({ scene: 'study', payload: { placeId: 'study', deviceId: json.deviceId } });
    client.send({ op: 'ping', t: 42 });
    expect((await client.next((message) => message.op === 'pong')).op.t).toBe(42);
  });

  it('refuses a bad token, an unknown device and no hello', async () => {
    const { hub } = await startHub();
    const { json } = await pair(hub);
    const bad = await connect(hub, { ...json, token: 'x'.repeat(43) });
    expect((await bad.next((message) => message.op === 'error')).op).toMatchObject({ code: 'auth' });
    expect((await bad.waitClosed()).code).toBe(1008);
    const unknown = await connect(hub, { deviceId: 'room-nope', token: json.token });
    expect((await unknown.next((message) => message.op === 'error')).op).toMatchObject({ code: 'auth' });
    const silent = await Client.open(hub.port() as number);
    expect((await silent.next((message) => message.op === 'error')).op).toMatchObject({ code: 'hello-timeout' });
    const early = await Client.open(hub.port() as number);
    early.send({ op: 'ping', t: 1 });
    expect((await early.next((message) => message.op === 'error')).op).toMatchObject({ code: 'auth' });
  });

  it('refuses a protocol mismatch with both versions', async () => {
    const { hub } = await startHub();
    const { json } = await pair(hub);
    const client = await Client.open(hub.port() as number);
    client.send({ op: 'hello', protocol: 2, deviceId: json.deviceId, token: json.token });
    expect((await client.next((message) => message.op === 'error')).op).toMatchObject({ code: 'protocol', hub: 1, client: 2 });
    expect((await client.waitClosed()).code).toBe(1008);
  });

  it('refuses a revoked device and disconnects it', async () => {
    const { hub, places } = await startHub({ env: { ROOM_HUB_ENABLED: '1' } });
    const { json } = await pair(hub);
    const client = await connect(hub, json);
    await client.next((message) => message.op === 'welcome');
    expect(await hub.revoke(json.deviceId as string)).toBe(true);
    expect((await client.waitClosed()).code).toBe(1008);
    expect(places.get('study')).toBeNull();
    const again = await connect(hub, json);
    expect((await again.next((message) => message.op === 'error')).op).toMatchObject({ code: 'auth' });
  });

  it('keeps one connection per device: a new hello closes the old socket', async () => {
    const { hub, places } = await startHub();
    const { json } = await pair(hub);
    const first = await connect(hub, json);
    await first.next((message) => message.op === 'welcome');
    const second = await connect(hub, json);
    await second.next((message) => message.op === 'welcome');
    await first.waitClosed();
    // The old socket going away must not take the place offline.
    expect(places.isOnline('study')).toBe(true);
    second.send({ op: 'ping', t: 1 });
    await second.next((message) => message.op === 'pong');
  });

  describe('peer check (Tailscale)', () => {
    // The tests connect from 127.0.0.1; `trustLoopback: false` makes the hub treat that address like a remote one.
    function remote(peer: TailscaleIdentity | null, self: TailscaleIdentity | null = { node: 'bija', login: 'kevin@example.com' }) {
      const state = { peer, self };
      const tailscale: TailscaleLookup = { whois: async () => state.peer, self: async () => state.self };
      return { state, tailscale };
    }
    const desk = { node: 'kevins-desk', login: 'kevin@example.com' };

    it('records the node and login at pairing, and accepts the same node later', async () => {
      const { tailscale } = remote(desk);
      const { hub, registry } = await startHub({ tailscale, trustLoopback: false });
      const { response, json } = await pair(hub);
      expect(response.status).toBe(200);
      expect(registry.get(json.deviceId as string)).toMatchObject({ tailscaleNode: 'kevins-desk', tailscaleLogin: 'kevin@example.com' });
      const client = await connect(hub, json);
      expect((await client.next((message) => message.op === 'welcome' || message.op === 'error')).op.op).toBe('welcome');
    });

    it('refuses pairing from another login, or when Tailscale cannot say who it is', async () => {
      const other = remote({ node: 'stranger', login: 'eve@example.com' });
      const first = await startHub({ tailscale: other.tailscale, trustLoopback: false });
      expect((await pair(first.hub)).response.status).toBe(403);
      expect(first.places.list().map((place) => place.id)).toEqual(['home', 'next-door']);
      const none = remote(null);
      const second = await startHub({ tailscale: none.tailscale, trustLoopback: false });
      const attempt = await pair(second.hub);
      expect(attempt.response.status).toBe(403);
      // The code was not used up by the refusal.
      expect(second.hub.status().pairing?.code).toBe(attempt.code);
      expect(second.published.find((event) => event.type === 'place.refused')?.payload).toMatchObject({ code: 'peer' });
    });

    it('refuses a connection from another node, another login, or when the CLI fails', async () => {
      const { state, tailscale } = remote(desk);
      const { hub } = await startHub({ tailscale, trustLoopback: false });
      const { json } = await pair(hub);
      const cases: Array<[string, TailscaleIdentity | null, TailscaleIdentity | null]> = [
        ['another node', { node: 'laptop', login: 'kevin@example.com' }, { node: 'bija', login: 'kevin@example.com' }],
        ['another login', { node: 'kevins-desk', login: 'eve@example.com' }, { node: 'bija', login: 'kevin@example.com' }],
        ['no whois', null, { node: 'bija', login: 'kevin@example.com' }],
        ['no self', desk, null],
      ];
      for (const [, peer, self] of cases) {
        state.peer = peer;
        state.self = self;
        const client = await connect(hub, json);
        expect((await client.next((message) => message.op === 'error')).op).toMatchObject({ code: 'peer' });
        expect((await client.waitClosed()).code).toBe(1008);
      }
    });

    it('lists the Tailscale name first in the pairing urls', async () => {
      const { tailscale } = remote(desk);
      const { hub } = await startHub({ tailscale });
      const started = await hub.startPairing();
      const port = hub.port();
      // Only loopback is bound here, so only the loopback URL is listed (the name needs a Tailscale address to point at).
      expect(started.urls).toEqual([`http://127.0.0.1:${port}`]);
    });
  });

  describe('call', () => {
    it('runs the same handler main.ts registered, with a sender that pushes ipc events back', async () => {
      const seen: unknown[][] = [];
      const { hub } = await startHub({
        handlers: {
          'avatar-model:load': (event, ...args) => {
            seen.push(args);
            event.sender.send('avatar-model:progress', 'half');
            return { id: args[0], data: new Uint8Array([9, 8, 7]) };
          },
          'avatars:list': () => PROFILES,
        },
      });
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      client.send({ op: 'call', ref: 'r1', channel: 'avatar-model:load', args: ['m1'] });
      const ipc = await client.next((message) => message.op === 'ipc');
      expect(ipc.op).toMatchObject({ channel: 'avatar-model:progress', args: ['half'] });
      const result = await client.next((message) => message.op === 'result' && message.ref === 'r1');
      const value = result.op.value as { id: string; data: Uint8Array };
      expect(value.id).toBe('m1');
      expect([...value.data]).toEqual([9, 8, 7]);
      expect(seen).toEqual([['m1']]);
      client.send({ op: 'call', ref: 'r2', channel: 'avatars:list', args: [] });
      expect((await client.next((message) => message.ref === 'r2')).op.value).toEqual(PROFILES);
    });

    it('takes binary values in args', async () => {
      const { hub } = await startHub({ handlers: { 'avatar-model:load': (_event, ...args) => (args[0] as Uint8Array).byteLength } });
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      client.send({ op: 'call', ref: 'b', channel: 'avatar-model:load', args: [new Uint8Array(1000)] });
      expect((await client.next((message) => message.ref === 'b')).op.value).toBe(1000);
    });

    it('denies channels outside the allowlist, without running them', async () => {
      const secret = vi.fn();
      const { hub } = await startHub({ handlers: { 'config:get-secret': secret, 'models:set-key': secret, 'app:quit': secret } });
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      for (const channel of ['config:get-secret', 'models:set-key', 'app:quit', 'avatar-model:delete', '']) {
        client.send({ op: 'call', ref: channel || 'empty', channel, args: [] });
        expect((await client.next((message) => message.ref === (channel || 'empty'))).op).toMatchObject({ op: 'error', code: 'denied' });
      }
      expect(secret).not.toHaveBeenCalled();
      expect(isAllowedChannel('places:move')).toBe(true);
      expect(isAllowedChannel('coding:set')).toBe(false);
    });

    it('answers unknown ops and calls with no handler with an error', async () => {
      const { hub } = await startHub();
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      client.send({ op: 'call', ref: 'x', channel: 'avatars:list', args: [] });
      expect((await client.next((message) => message.ref === 'x')).op).toMatchObject({ code: 'unavailable' });
      client.send({ op: 'dance', ref: 'y' });
      expect((await client.next((message) => message.ref === 'y')).op).toMatchObject({ code: 'unknown-op' });
      client.send('{not json');
      expect((await client.next((message) => message.op === 'error')).op).toMatchObject({ code: 'bad-frame' });
    });

    it('reports a handler that throws', async () => {
      const { hub } = await startHub({
        handlers: {
          'avatars:list': () => {
            throw new Error('registry is down');
          },
        },
      });
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      client.send({ op: 'call', ref: 'e', channel: 'avatars:list', args: [] });
      expect((await client.next((message) => message.ref === 'e')).op).toMatchObject({ code: 'failed', message: 'registry is down' });
    });

    it('answers places:snapshot relative to the satellite', async () => {
      const { hub } = await startHub();
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      client.send({ op: 'call', ref: 's', channel: 'places:snapshot', args: [] });
      const snapshot = (await client.next((message) => message.ref === 's')).op.value as { localPlaceId: string };
      expect(snapshot.localPlaceId).toBe('study');
    });

    it('lets only the destination place confirm an arrival', async () => {
      const arrived = vi.fn();
      const { hub, places } = await startHub({ handlers: { 'places:arrived': (_event, ...args) => arrived(...args) } });
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      // Sage walks to the study, Echo to next door-ish: a satellite cannot confirm an avatar that is not on its way to it.
      places.startMove('sage', 'study', 'chose to');
      client.send({ op: 'call', ref: 'a1', channel: 'places:arrived', args: ['echo'] });
      await client.next((message) => message.ref === 'a1');
      expect(arrived).not.toHaveBeenCalled();
      client.send({ op: 'call', ref: 'a2', channel: 'places:arrived', args: ['sage'] });
      await client.next((message) => message.ref === 'a2');
      expect(arrived).toHaveBeenCalledWith('sage');
    });
  });

  describe('asset.get', () => {
    it('serves a room asset as a binary frame', async () => {
      const { hub } = await startHub();
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      client.send({ op: 'asset.get', ref: 'a', url: 'aiembodied-asset://polyhaven/chair/chair.glb' });
      const asset = await client.next((message) => message.op === 'asset');
      expect(asset.op).toMatchObject({ ref: 'a', mime: 'model/gltf-binary' });
      expect([...(asset.payload ?? [])]).toEqual([1, 2, 3, 4, 5]);
    });

    it('applies the same path checks as the asset protocol', async () => {
      const { hub } = await startHub();
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      for (const url of ['aiembodied-asset://polyhaven/../secret', 'aiembodied-asset://polyhaven/chair/missing.glb', 'file:///etc/passwd', 'aiembodied-asset://polyhaven']) {
        client.send({ op: 'asset.get', ref: url, url });
        expect((await client.next((message) => message.ref === url)).op).toMatchObject({ op: 'error', code: 'not-found' });
      }
    });
  });

  describe('places.changed', () => {
    it('pushes a per-satellite snapshot to every connected client', async () => {
      const { hub, places } = await startHub();
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      places.rename('next-door', 'the shed');
      const pushed = await client.next((message) => message.op === 'ipc' && message.channel === 'places:changed');
      const snapshot = (pushed.op.args as Array<{ localPlaceId: string; places: Array<{ id: string; name: string }> }>)[0];
      expect(snapshot.localPlaceId).toBe('study');
      expect(snapshot.places.find((place) => place.id === 'next-door')?.name).toBe('the shed');
    });
  });

  describe('going offline', () => {
    it('marks the place offline when the socket closes, then sends avatars home after the grace time', async () => {
      const { hub, places, published } = await startHub({ graceMs: 150 });
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      places.startMove('sage', 'study', 'chose to');
      places.arrived('sage');
      expect(places.locationOf('sage')).toBe('study');
      client.ws.close();
      await vi.waitFor(() => expect(places.isOnline('study')).toBe(false));
      expect(published.find((event) => event.type === 'place.offline')).toMatchObject({ scene: 'study' });
      // Grace: still there, and nobody can walk in.
      expect(places.locationOf('sage')).toBe('study');
      expect(places.startMove('echo', 'study', 'chose to')).toEqual({ ok: false, reason: 'the study is closed' });
      await vi.waitFor(() => expect(places.inTransit('sage')).toBe(true));
      expect(places.snapshot().transit).toEqual([{ avatarId: 'sage', from: 'study', to: 'home' }]);
      expect(published.at(-1)?.payload).toMatchObject({ reason: 'room closed' });
    });

    it('drops a silent satellite after the heartbeat timeout; traffic keeps it alive', async () => {
      const { hub, places } = await startHub({ heartbeatTimeoutMs: 400 });
      const { json } = await pair(hub);
      const client = await connect(hub, json);
      await client.next((message) => message.op === 'welcome');
      for (let i = 0; i < 4; i += 1) {
        client.send({ op: 'ping', t: i });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(places.isOnline('study')).toBe(true);
      await vi.waitFor(() => expect(places.isOnline('study')).toBe(false), { timeout: 3000 });
      expect((await client.waitClosed()).code).toBeGreaterThan(0);
    });
  });

  it('can ask a satellite to turn its devices off', async () => {
    const { hub } = await startHub();
    const { json } = await pair(hub);
    const client = await connect(hub, json);
    await client.next((message) => message.op === 'welcome');
    expect(hub.deviceOff(json.deviceId as string, 'locked')).toBe(true);
    expect((await client.next((message) => message.op === 'device.off')).op).toMatchObject({ reason: 'locked' });
    expect(hub.deviceOff('room-nope', 'x')).toBe(false);
  });

  it('forwards presence, device.state and wake.heard to the owner', async () => {
    const seen: Array<{ from: unknown; op: Op }> = [];
    const folder = mkdtempSync(path.join(tmpdir(), 'room-hub-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    const data = new Map<string, string>();
    const places = new PlaceManager({ store: { getValue: (k) => data.get(k) ?? null, setValue: (k, v) => void data.set(k, v) }, registry: { list: () => PROFILES } });
    const hub = new RoomHub({
      registry: new RoomDeviceRegistry(null),
      places,
      tailscale: { whois: async () => null, self: async () => null },
      assetRoot: folder,
      avatars: () => [],
      settings: () => ({ wakeWord: null, pushToTalk: null }),
      onSatelliteMessage: (from, op) => seen.push({ from, op }),
      env: {},
      port: 0,
      listenAddresses: () => ['127.0.0.1'],
    });
    await hub.start();
    cleanups.push(() => hub.stop());
    const { json } = await pair(hub);
    const client = await connect(hub, json);
    await client.next((message) => message.op === 'welcome');
    client.send({ op: 'device.state', mic: 'live', camera: 'off', speakers: 'live', locked: false, closed: false });
    client.send({ op: 'ping', t: 1 });
    await client.next((message) => message.op === 'pong');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ from: { placeId: 'study' }, op: { op: 'device.state', mic: 'live' } });
  });

  it('exports a frame helper that a binary hello can use', () => {
    // A hello may also arrive as a binary frame with no bins; it decodes as a normal op.
    const frame = encodeBinaryFrame({ op: 'hello', protocol: 1 });
    expect(decodeMessage(frame).op).toMatchObject({ op: 'hello' });
  });
});

describe('room hub helpers', () => {
  it('knows the Tailscale range 100.64.0.0/10', () => {
    for (const address of ['100.64.0.1', '100.101.102.103', '100.127.255.254']) expect(isTailscaleAddress(address)).toBe(true);
    for (const address of ['100.63.0.1', '100.128.0.1', '192.168.1.5', '10.0.0.1', '0.0.0.0', '100.64.0', 'fe80::1']) expect(isTailscaleAddress(address)).toBe(false);
  });

  it('picks only IPv4 Tailscale addresses from the interfaces, never 0.0.0.0', () => {
    const entry = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4') => ({ address, family, internal: false, netmask: '', cidr: null, mac: '' }) as never;
    expect(
      tailscaleAddresses({
        Ethernet: [entry('192.168.1.20'), entry('fe80::1', 'IPv6')],
        Tailscale: [entry('100.100.1.2'), entry('fd7a:115c:a1e0::1', 'IPv6')],
        Lo: [entry('127.0.0.1')],
      }),
    ).toEqual(['100.100.1.2']);
  });

  it('knows loopback', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('100.64.0.2')).toBe(false);
  });

  it('makes place ids from names, unique and never empty', () => {
    expect(slugPlaceId('the study', [])).toBe('study');
    expect(slugPlaceId("Kevin's Attic!", [])).toBe('kevin-s-attic');
    expect(slugPlaceId('the study', ['study'])).toBe('study-2');
    expect(slugPlaceId('the study', ['study', 'study-2'])).toBe('study-3');
    expect(slugPlaceId('???', [])).toBe('room');
    expect(slugPlaceId('home', ['home', 'next-door'])).toBe('home-2');
  });
});
