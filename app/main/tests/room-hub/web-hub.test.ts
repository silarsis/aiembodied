import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RoomDeviceRegistry } from '../../src/room-hub/room-devices.js';
import { startHarness, waitFor, type Harness } from '../satellite/hub-harness.js';
import { encodeMessage, decodeMessage, type Op } from '../../src/room-hub/frames.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A raw GET, so the path is sent exactly as given (fetch would tidy `..` away). */
function rawGet(port: number, requestPath: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A hub with a dist folder like the renderer build, a secret file outside it and a symlink inside it that points at the secret. */
async function hubWithWeb(extraOptions: Record<string, unknown> = {}) {
  const dist = mkdtempSync(path.join(tmpdir(), 'web-dist-'));
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  mkdirSync(path.join(dist, 'mediapipe', 'wasm'), { recursive: true });
  mkdirSync(path.join(dist, 'empty-folder'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' blob:"><title>app</title>`);
  writeFileSync(path.join(dist, 'assets', 'index-1.js'), 'console.log(1)');
  writeFileSync(path.join(dist, 'mediapipe', 'wasm', 'vision.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  writeFileSync(path.join(dist, 'face.tflite'), Buffer.from([1, 2, 3]));
  writeFileSync(path.join(dist, '.env'), 'SECRET=1');
  const harness = await startHarness({}, { hubOptions: { webRoot: dist, ...extraOptions } });
  cleanups.push(() => harness.cleanup());
  writeFileSync(path.join(harness.folder, 'secret.txt'), 'outside the dist folder');
  symlinkSync(path.join(harness.folder, 'secret.txt'), path.join(dist, 'link.txt'));
  await harness.code();
  return { harness, dist, port: harness.hub.port() as number };
}

async function pair(harness: Harness, body: Record<string, unknown> = {}): Promise<{ deviceId: string; token: string; placeId: string }> {
  const code = await harness.code();
  const response = await fetch(`http://127.0.0.1:${harness.hub.port()}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'a browser', ...body }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { deviceId: string; token: string; placeId: string };
}

describe('the hub serves the app at /app/', () => {
  it('serves index.html with no-cache, and files with the right content types', async () => {
    const { port } = await hubWithWeb();
    const index = await rawGet(port, '/app/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.body.toString()).toContain('<title>app</title>');
    // The page's CSP names the hub it came from for the WebSocket, and nothing wider.
    expect(index.body.toString()).toContain(`connect-src 'self' blob: ws://127.0.0.1:${port} wss://127.0.0.1:${port}`);
    expect(index.headers['content-length']).toBe(String(index.body.length));
    expect((await rawGet(port, '/app/index.html')).headers['cache-control']).toBe('no-cache');

    const js = await rawGet(port, '/app/assets/index-1.js');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toContain('immutable');
    expect((await rawGet(port, '/app/mediapipe/wasm/vision.wasm')).headers['content-type']).toBe('application/wasm');
    const tflite = await rawGet(port, '/app/face.tflite');
    expect(tflite.headers['content-type']).toBe('application/octet-stream');
    expect(Array.from(tflite.body)).toEqual([1, 2, 3]);
  });

  it('answers a conditional request with 304', async () => {
    const { port } = await hubWithWeb();
    const first = await rawGet(port, '/app/face.tflite');
    const again = await rawGet(port, '/app/face.tflite', { 'If-None-Match': String(first.headers.etag) });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });

  it('redirects /app to /app/', async () => {
    const { port } = await hubWithWeb();
    const response = await rawGet(port, '/app');
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/app/');
  });

  it('never lists a folder, serves a dotfile, follows a symlink out of the folder, or leaves the root', async () => {
    const { port } = await hubWithWeb();
    for (const bad of ['/app/assets/', '/app/assets', '/app/empty-folder/', '/app/.env', '/app/link.txt', '/app/../secret.txt', '/app/%2e%2e/secret.txt', '/app/assets/%2e%2e/%2e%2e/secret.txt', '/app/..%2fsecret.txt', '/app/missing.js']) {
      const response = await rawGet(port, bad);
      expect(response.status, bad).toBe(404);
      expect(response.body.toString(), bad).not.toContain('outside the dist');
      expect(response.body.toString(), bad).not.toContain('SECRET');
    }
    // A request line that tries to climb out with the dots left raw is normalised away by the URL parser, and still stays inside.
    const climbed = await rawGet(port, '/app/assets/../../../../secret.txt');
    expect([301, 308, 404]).toContain(climbed.status);
    expect(climbed.body.toString()).not.toContain('outside the dist');
  });

  it('answers GET only', async () => {
    const { port } = await hubWithWeb();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`http://127.0.0.1:${port}/app/`, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
    }
  });

  it('says so when the app was not built here', async () => {
    const harness = await startHarness({}, { hubOptions: { webRoot: null } });
    cleanups.push(() => harness.cleanup());
    await harness.code();
    const response = await rawGet(harness.hub.port() as number, '/app/');
    expect(response.status).toBe(503);
  });

  it('refuses a Host that is a public name (DNS rebinding) and a peer that is not on this PC\'s Tailscale login', async () => {
    const { port } = await hubWithWeb();
    expect((await rawGet(port, '/app/', { Host: 'evil.example:8791' })).status).toBe(403);
    expect((await rawGet(port, '/app/', { Host: 'bija:8791' })).status).toBe(200);
    // The same server, but with the loopback shortcut off: the peer check runs, and with no Tailscale it fails closed.
    const strict = await hubWithWeb({ trustLoopback: false });
    expect((await rawGet(strict.port, '/app/')).status).toBe(403);
    expect((await rawGet(strict.port, '/app/assets/index-1.js')).status).toBe(403);
  });

  it('lets a peer of the same Tailscale login load the app when the check is on', async () => {
    const tailscale = { whois: async () => ({ node: 'phone', login: 'kevin@example.com' }), self: async () => ({ node: 'bija', login: 'kevin@example.com' }) };
    const { port } = await hubWithWeb({ trustLoopback: false, tailscale });
    expect((await rawGet(port, '/app/')).status).toBe(200);
    const other = await hubWithWeb({ trustLoopback: false, tailscale: { ...tailscale, whois: async () => ({ node: 'phone', login: 'someone@else.com' }) } });
    expect((await rawGet(other.port, '/app/')).status).toBe(403);
  });
});

describe('GET /v1/asset', () => {
  const ASSET = `aiembodied-asset://polyhaven/chair/chair.glb`;
  const url = (port: number, extra = '', asset = ASSET) => `/v1/asset?url=${encodeURIComponent(asset)}${extra}`;

  it('needs the device token: nothing, a wrong token and a revoked device are all refused', async () => {
    const { harness, port } = await hubWithWeb();
    const paired = await pair(harness);
    expect((await rawGet(port, url(port))).status).toBe(401);
    expect((await rawGet(port, url(port), { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await rawGet(port, url(port), { Authorization: `Bearer ${paired.deviceId}` })).status).toBe(401);
    const ok = await rawGet(port, url(port), { Authorization: `Bearer ${paired.token}` });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('model/gltf-binary');
    expect(Array.from(ok.body)).toEqual([1, 2, 3, 4, 5]);
    // A second device keeps the hub listening after the first is revoked.
    await pair(harness, { placeName: 'other' });
    await harness.hub.revoke(paired.deviceId);
    expect((await rawGet(port, url(port), { Authorization: `Bearer ${paired.token}` })).status).toBe(401);
  });

  it('uses the same path rules as the asset protocol: no traversal, nothing outside the asset folder', async () => {
    const { harness, port } = await hubWithWeb();
    const paired = await pair(harness);
    const auth = { Authorization: `Bearer ${paired.token}` };
    for (const bad of [
      'aiembodied-asset://polyhaven/chair/../../../secret.txt',
      'aiembodied-asset://polyhaven/%2e%2e/%2e%2e/secret.txt',
      'aiembodied-asset://polyhaven/chair/missing.glb',
      'file:///etc/passwd',
      'https://example.com/x/y',
      '/etc/passwd',
      'aiembodied-asset://polyhaven',
    ]) {
      expect((await rawGet(port, url(port, '', bad), auth)).status, bad).toBe(404);
    }
    expect((await rawGet(port, '/v1/asset', auth)).status).toBe(404);
  });

  it('takes the link\'s key from welcome (?k=) while that link is open, and only from the address it connected from', async () => {
    const { harness, port } = await hubWithWeb();
    const paired = await pair(harness);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/link`);
    const messages: Op[] = [];
    ws.on('message', (data: Buffer, isBinary: boolean) => messages.push(decodeMessage(isBinary ? new Uint8Array(data) : data.toString('utf8')).op));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(encodeMessage({ op: 'hello', protocol: 1, deviceId: paired.deviceId, token: paired.token, appVersion: 't' }));
    await waitFor(() => messages.some((op) => op.op === 'welcome'));
    const key = (messages.find((op) => op.op === 'welcome') as Op).assetKey as string;
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(20);
    const ok = await rawGet(port, url(port, `&k=${encodeURIComponent(key)}`));
    expect(ok.status).toBe(200);
    expect((await rawGet(port, url(port, '&k=wrong'))).status).toBe(401);
    // The link closes: the key stops working at once.
    ws.close();
    await waitFor(() => harness.hub.deviceForPlace(paired.placeId) === null, 3000, 'link closed');
    expect((await rawGet(port, url(port, `&k=${encodeURIComponent(key)}`))).status).toBe(401);
  });

  it('refuses a page of another site, and answers GET only', async () => {
    const { harness, port } = await hubWithWeb();
    const paired = await pair(harness);
    const auth = { Authorization: `Bearer ${paired.token}` };
    expect((await rawGet(port, url(port), { ...auth, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await rawGet(port, url(port), { ...auth, Origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    // No CORS headers are ever sent: another origin cannot read the answer.
    expect((await rawGet(port, url(port), auth)).headers['access-control-allow-origin']).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${port}${url(port)}`, { method: 'POST', headers: auth })).status).toBe(405);
  });

  it('checks the Tailscale node that paired when the peer is not on loopback', async () => {
    const tailscale = { whois: async () => ({ node: 'phone', login: 'kevin@example.com' }), self: async () => ({ node: 'bija', login: 'kevin@example.com' }) };
    const { harness, port } = await hubWithWeb();
    const paired = await pair(harness);
    expect((await rawGet(port, url(port), { Authorization: `Bearer ${paired.token}` })).status).toBe(200);
    // Same hub, check on: the device paired from loopback has no node, so a remote peer can never use its token.
    const strict = await hubWithWeb({ trustLoopback: false, tailscale });
    const registry = strict.harness.registry;
    const added = registry.addDevice({ id: 'room-x', name: 'x', kind: 'browser', placeId: 'x', tailscaleNode: 'phone', tailscaleLogin: 'kevin@example.com' });
    expect((await rawGet(strict.port, url(strict.port), { Authorization: `Bearer ${added.token}` })).status).toBe(200);
    const wrongNode = registry.addDevice({ id: 'room-y', name: 'y', kind: 'browser', placeId: 'y', tailscaleNode: 'laptop', tailscaleLogin: 'kevin@example.com' });
    expect((await rawGet(strict.port, url(strict.port), { Authorization: `Bearer ${wrongNode.token}` })).status).toBe(401);
    const noNode = registry.addDevice({ id: 'room-z', name: 'z', kind: 'browser', placeId: 'z', tailscaleNode: null, tailscaleLogin: null });
    expect((await rawGet(strict.port, url(strict.port), { Authorization: `Bearer ${noNode.token}` })).status).toBe(401);
  });
});

describe('the Origin check on the WebSocket upgrade', () => {
  function tryUpgrade(port: number, origin: string | undefined, host?: string): Promise<'open' | number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/link`, { headers: { ...(origin !== undefined ? { Origin: origin } : {}), ...(host ? { Host: host } : {}) } });
      ws.once('open', () => {
        ws.terminate();
        resolve('open');
      });
      ws.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.once('error', () => resolve(0));
    });
  }

  it('lets in no Origin (the Electron satellite), the hub itself and the Android shell; refuses other pages', async () => {
    const { port } = await hubWithWeb();
    expect(await tryUpgrade(port, undefined)).toBe('open');
    expect(await tryUpgrade(port, `http://127.0.0.1:${port}`)).toBe('open');
    expect(await tryUpgrade(port, 'https://appassets.androidplatform.net')).toBe('open');
    expect(await tryUpgrade(port, 'https://evil.example')).toBe(403);
    expect(await tryUpgrade(port, 'http://evil.example:8791')).toBe(403);
    expect(await tryUpgrade(port, 'null')).toBe(403);
    expect(await tryUpgrade(port, `http://127.0.0.1:${port + 1}`)).toBe(403);
    // A rebinding page: its Origin and Host agree, but the name is a public one.
    expect(await tryUpgrade(port, 'http://evil.example:8791', 'evil.example:8791')).toBe(403);
  });

  it('still needs the device token after a good Origin', async () => {
    const { port } = await hubWithWeb();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/link`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    const messages: Op[] = [];
    ws.on('message', (data: Buffer) => messages.push(decodeMessage(data.toString('utf8')).op));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(encodeMessage({ op: 'hello', protocol: 1, deviceId: 'room-nope', token: 'nope', appVersion: 't' }));
    await waitFor(() => messages.some((op) => op.op === 'error'));
    expect(messages.find((op) => op.op === 'error')).toMatchObject({ code: 'auth' });
    ws.terminate();
  });

  it('refuses a page of another site posting to /v1/pair, even with a good code', async () => {
    const { harness, port } = await hubWithWeb();
    const code = await harness.code();
    const response = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: JSON.stringify({ code }) });
    expect(response.status).toBe(403);
    // The code was not used up.
    expect(harness.hub.status().pairing?.code).toBe(code);
  });
});

describe('device kind', () => {
  it('is stored from the pair request, defaults to a desktop, and is shown in the status', async () => {
    const { harness } = await hubWithWeb();
    const browser = await pair(harness, { kind: 'browser', deviceName: 'Kevin\'s laptop browser', placeName: 'laptop' });
    const phone = await pair(harness, { kind: 'phone', placeName: 'phone' });
    const desktop = await pair(harness, { placeName: 'desk' });
    const junk = await pair(harness, { kind: 'toaster', placeName: 'junk' });
    expect(harness.registry.get(browser.deviceId)?.kind).toBe('browser');
    expect(harness.registry.get(phone.deviceId)?.kind).toBe('phone');
    expect(harness.registry.get(desktop.deviceId)?.kind).toBe('desktop');
    expect(harness.registry.get(junk.deviceId)?.kind).toBe('desktop');
    const kinds = Object.fromEntries(harness.hub.status().devices.map((device) => [device.id, device.kind]));
    expect(kinds).toMatchObject({ [browser.deviceId]: 'browser', [phone.deviceId]: 'phone', [desktop.deviceId]: 'desktop' });
    // It survives a restart of the registry (room-devices.json).
    const reloaded = new RoomDeviceRegistry(path.join(harness.folder, 'room-devices.json'));
    expect(reloaded.get(browser.deviceId)?.kind).toBe('browser');
  });

  it('gives a nameless browser or phone a fitting default name', async () => {
    const { harness } = await hubWithWeb();
    const code = await harness.code();
    const response = await fetch(`http://127.0.0.1:${harness.hub.port()}/v1/pair`, { method: 'POST', body: JSON.stringify({ code, kind: 'phone' }) });
    const body = (await response.json()) as { deviceId: string };
    expect(harness.registry.get(body.deviceId)?.name).toBe('Phone room');
  });
});
