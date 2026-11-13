#!/usr/bin/env node
/**
 * A small test client for the room link (docs/features/room-link-protocol.md). Plain Node 22, no app code.
 *
 *   node scripts/room-link-client.mjs pair <hubUrl> <code> [placeName]
 *   node scripts/room-link-client.mjs connect <hubUrl> [--call <channel> [json args]] [--asset <url>]
 *
 * `pair` prints the answer and saves { hubUrl, deviceId, token, placeId } to room-link-device.json in the
 * current folder. `connect` reads that file, says hello, prints the welcome and every message, and pings
 * every 2 seconds. `<hubUrl>` is http://host:port (or host:port).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const FILE = 'room-link-device.json';

function baseUrl(input) {
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `http://${input}`;
  const url = new URL(withScheme);
  url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
  return url.origin;
}

function describe(value) {
  return JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? `<${item.byteLength} bytes>` : item));
}

/** Binary frame: 4-byte big-endian header length, JSON header, payload. Bytes in the op come back as Uint8Array. */
function decode(data) {
  if (typeof data === 'string') return JSON.parse(data);
  const bytes = new Uint8Array(data);
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, false);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  const payload = bytes.subarray(4 + length);
  if (!Array.isArray(header.bins)) return { ...header, payload };
  let offset = 0;
  const bins = header.bins.map((size) => payload.subarray(offset, (offset += size)));
  const restore = (item) =>
    Array.isArray(item)
      ? item.map(restore)
      : item && typeof item === 'object'
        ? Object.keys(item).length === 1 && typeof item.$bin === 'number'
          ? bins[item.$bin]
          : Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, restore(inner)]))
        : item;
  const { bins: _bins, ...rest } = header;
  return restore(rest);
}

async function pair(hub, code, placeName) {
  const response = await fetch(`${baseUrl(hub)}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: os.hostname(), ...(placeName ? { placeName } : {}) }),
  });
  const body = await response.json().catch(() => ({}));
  console.log(response.status, JSON.stringify({ ...body, token: body.token ? '<saved>' : undefined }));
  if (!response.ok) process.exit(1);
  writeFileSync(FILE, JSON.stringify({ hubUrl: baseUrl(hub), deviceId: body.deviceId, token: body.token, placeId: body.placeId }, null, 2), { mode: 0o600 });
  console.log(`Saved ${FILE}`);
}

function connect(hub, extra) {
  if (!existsSync(FILE)) {
    console.error(`No ${FILE} here. Pair first.`);
    process.exit(1);
  }
  const device = JSON.parse(readFileSync(FILE, 'utf8'));
  const url = new URL('/v1/link', baseUrl(hub));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let ping;
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ op: 'hello', protocol: 1, deviceId: device.deviceId, token: device.token, appVersion: 'room-link-client' }));
    ping = setInterval(() => ws.send(JSON.stringify({ op: 'ping', t: Date.now() })), 2000);
  });
  ws.addEventListener('message', (event) => {
    const op = decode(event.data);
    if (op.op === 'pong') return;
    console.log('<-', describe(op));
    if (op.op === 'welcome') {
      if (extra.call) ws.send(JSON.stringify({ op: 'call', ref: 'c1', channel: extra.call, args: extra.args }));
      if (extra.asset) ws.send(JSON.stringify({ op: 'asset.get', ref: 'a1', url: extra.asset }));
    }
  });
  ws.addEventListener('close', (event) => {
    clearInterval(ping);
    console.log(`closed ${event.code} ${event.reason}`);
    process.exit(0);
  });
  ws.addEventListener('error', () => console.error('socket error'));
}

const [command, hub, ...rest] = process.argv.slice(2);
if (command === 'pair' && hub && rest[0]) {
  await pair(hub, rest[0], rest[1]);
} else if (command === 'connect' && hub) {
  const extra = {};
  const callAt = rest.indexOf('--call');
  if (callAt >= 0) {
    extra.call = rest[callAt + 1];
    extra.args = rest[callAt + 2] && !rest[callAt + 2].startsWith('--') ? JSON.parse(rest[callAt + 2]) : [];
  }
  const assetAt = rest.indexOf('--asset');
  if (assetAt >= 0) extra.asset = rest[assetAt + 1];
  connect(hub, extra);
} else {
  console.error('Usage:\n  room-link-client.mjs pair <hubUrl> <code> [placeName]\n  room-link-client.mjs connect <hubUrl> [--call <channel> [jsonArgs]] [--asset <url>]');
  process.exit(2);
}
