import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Satellite, type SatelliteStatus, type WindowLike } from '../../src/satellite/satellite.js';
import { SATELLITE_FILE, SatelliteSettingsStore, detectSatelliteRole, userDataOverride } from '../../src/satellite/settings.js';
import { KeychainTokenStore, MemoryTokenStore, TOKEN_SERVICE } from '../../src/satellite/token-store.js';
import { LOST_TOUCH } from '../../src/satellite/room-link.js';
import { startHarness, waitFor, type Harness } from './hub-harness.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(handlers: Parameters<typeof startHarness>[0] = {}) {
  const harness = await startHarness(handlers);
  cleanups.push(() => harness.cleanup());
  const folder = mkdtempSync(path.join(tmpdir(), 'satellite-pc-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const window: WindowLike = { isDestroyed: () => false, webContents: { send: (channel, ...args) => void sent.push({ channel, args }) } };
  const settings = new SatelliteSettingsStore(path.join(folder, SATELLITE_FILE));
  const tokens = new MemoryTokenStore();
  const quit = vi.fn();
  const satellite = new Satellite({
    settings,
    tokens,
    cacheDir: path.join(folder, 'cache', 'assets'),
    appVersion: 'test',
    hostname: 'desk-pc',
    getWindow: () => window,
    quit,
    linkOptions: { pingMs: 50, timeoutMs: 600, backoffFirstMs: 30, backoffMaxMs: 100 },
  });
  const handlersByChannel = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  let assetHandler: ((request: { url: string }) => Promise<Response> | Response) | null = null;
  await satellite.start(
    { handle: (channel, listener) => void handlersByChannel.set(channel, listener) },
    { handle: (_scheme, handler) => void (assetHandler = handler) },
  );
  cleanups.push(() => satellite.stop());
  const ipc = (channel: string, ...args: unknown[]) => {
    const handler = handlersByChannel.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return Promise.resolve(handler({}, ...args));
  };
  const pairNow = async (extra: Record<string, unknown> = {}) => {
    const code = await harness.code();
    return (await ipc('satellite:pair', { hubUrl: harness.url(), code, placeName: 'the study', deviceName: 'Desk', ...extra })) as SatelliteStatus;
  };
  const statusesSent = () => sent.filter((item) => item.channel === 'satellite:status').map((item) => item.args[0] as SatelliteStatus);
  return { harness, satellite, folder, sent, ipc, pairNow, tokens, settings, quit, asset: (url: string) => assetHandler!({ url }), statusesSent };
}

async function online(harness: Harness, status: () => SatelliteStatus) {
  await waitFor(() => status().link === 'online', 5000, 'the link to come online');
  void harness;
}

describe('Satellite', () => {
  it('starts unpaired: the connect screen\'s status, no link', async () => {
    const { ipc } = await setup();
    expect(await ipc('satellite:status')).toMatchObject({ role: 'satellite', paired: false, hubUrl: null, link: 'idle' });
  });

  it('pairs with the code, keeps the token in the store and the rest in satellite.json, and connects', async () => {
    const { ipc, pairNow, harness, tokens, folder, statusesSent } = await setup();
    const paired = await pairNow();
    expect(paired).toMatchObject({ paired: true, deviceName: 'Desk', placeId: 'study', hubUrl: harness.url() });
    expect(await tokens.get(harness.url())).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const file = JSON.parse(readFileSync(path.join(folder, SATELLITE_FILE), 'utf8')) as Record<string, unknown>;
    expect(file).toMatchObject({ hubUrl: harness.url(), placeId: 'study', deviceName: 'Desk' });
    expect(JSON.stringify(file)).not.toContain(String(await tokens.get(harness.url())));
    await waitFor(() => statusesSent().some((status) => status.link === 'online'), 5000, 'an online status push');
    expect(await ipc('satellite:status')).toMatchObject({ paired: true, link: 'online', placeName: 'the study', lastError: null });
  });

  it('says why a pairing failed, in words', async () => {
    const { ipc, harness } = await setup();
    await harness.code();
    await expect(ipc('satellite:pair', { hubUrl: harness.url(), code: '000000' })).rejects.toThrow(/wrong or has expired/);
    await expect(ipc('satellite:pair', { hubUrl: harness.url(), code: '12' })).rejects.toThrow('The code is 6 digits.');
    await expect(ipc('satellite:pair', { hubUrl: '', code: '123456' })).rejects.toThrow(/hub address/);
    await expect(ipc('satellite:pair', { hubUrl: 'ws://127.0.0.1:1', code: '123456' })).rejects.toThrow(/Could not reach bija/);
    expect(await ipc('satellite:status')).toMatchObject({ paired: false });
  });

  it('picks its own names when none are typed', async () => {
    const { ipc, harness } = await setup();
    const code = await harness.code('');
    const status = (await ipc('satellite:pair', { hubUrl: harness.url(), code })) as SatelliteStatus;
    expect(status.deviceName).toBe('desk-pc');
    expect(status.placeName).toBe('the study');
  });

  it('forwards an allowed channel to bija, and the place goes with it', async () => {
    const seen: unknown[] = [];
    const { ipc, pairNow, satellite } = await setup({
      'avatars:list': ((event: { placeId?: string }) => (seen.push(event.placeId), [{ id: 'echo' }])) as never,
    });
    await pairNow();
    await online({} as Harness, () => satellite.status());
    expect(await ipc('avatars:list')).toEqual([{ id: 'echo' }]);
    expect(seen).toEqual(['study']);
  });

  it('answers the config itself, as a satellite, with no keys', async () => {
    const { ipc } = await setup();
    const config = (await ipc('config:get')) as Record<string, unknown>;
    expect(config).toMatchObject({ role: 'satellite', conversationBackend: 'local', hasRealtimeApiKey: false });
    expect(JSON.stringify(config)).not.toMatch(/apiKey":"/);
    expect(await ipc('wake-word:list')).toEqual([]);
    expect(await ipc('approvals:list')).toEqual([]);
    const after = (await ipc('config:set-audio-devices', { audioInputDeviceId: 'mic-1' })) as Record<string, unknown>;
    expect(after.audioInputDeviceId).toBe('mic-1');
  });

  it('refuses what a satellite must not do, without asking bija', async () => {
    const secret = vi.fn();
    const { ipc, pairNow, satellite } = await setup({ 'models:set-key': secret as never, 'avatars:add': secret as never });
    await pairNow();
    await online({} as Harness, () => satellite.status());
    for (const channel of ['models:set-key', 'avatars:add', 'coding:start-task', 'config:set-secret', 'room-hub:revoke']) {
      await expect(ipc(channel, {})).rejects.toThrow('Not available on a satellite PC.');
    }
    expect(secret).not.toHaveBeenCalled();
  });

  it('quits when asked', async () => {
    const { ipc, quit } = await setup();
    await ipc('app:quit');
    expect(quit).toHaveBeenCalled();
  });

  it('rejects forwarded calls quickly while the link is down', async () => {
    const { ipc, pairNow, satellite, harness } = await setup({ 'avatars:list': () => [] });
    await pairNow();
    await online(harness, () => satellite.status());
    await harness.hub.stop();
    await waitFor(() => satellite.status().link === 'offline');
    const started = Date.now();
    await expect(ipc('avatars:list')).rejects.toThrow(LOST_TOUCH);
    expect(Date.now() - started).toBeLessThan(150);
    // Local answers still work: the window can show its banner.
    expect(await ipc('satellite:status')).toMatchObject({ link: 'offline', paired: true });
  });

  it('hands bija\'s events to the window, and drops channels the renderer does not listen for', async () => {
    const { pairNow, satellite, harness, sent } = await setup();
    await pairNow();
    await online(harness, () => satellite.status());
    harness.hub.sendToPlace('study', { op: 'ipc', channel: 'local-voice:event', args: [{ requestId: 'x' }] });
    harness.hub.sendToPlace('study', { op: 'ipc', channel: 'config:set-secret', args: ['nope'] });
    await waitFor(() => sent.some((item) => item.channel === 'local-voice:event'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent.some((item) => item.channel === 'config:set-secret')).toBe(false);
    // The welcome's snapshot reaches the renderer as places:changed.
    const snapshot = sent.find((item) => item.channel === 'places:changed')?.args[0] as { localPlaceId: string };
    expect(snapshot.localPlaceId).toBe('study');
  });

  it('forgets bija: no token, no pairing, no link', async () => {
    const { ipc, pairNow, harness, tokens, satellite } = await setup();
    await pairNow();
    await online(harness, () => satellite.status());
    const forgotten = (await ipc('satellite:forget')) as SatelliteStatus;
    expect(forgotten).toMatchObject({ paired: false, hubUrl: null, link: 'idle' });
    expect(await tokens.get(harness.url())).toBeNull();
  });

  it('a refusal (bija revoked this PC) is shown, with the reason', async () => {
    const { pairNow, harness, satellite } = await setup();
    await pairNow();
    await online(harness, () => satellite.status());
    const deviceId = harness.hub.status().devices[0].id;
    await harness.hub.revoke(deviceId);
    await waitFor(() => satellite.status().link === 'refused');
    expect(satellite.status()).toMatchObject({ linkCode: 'revoked', lastError: expect.stringContaining('removed') });
  });

  describe('avatar bodies', () => {
    it('are cached by model id and file sha, so the second load never asks bija', async () => {
      const load = vi.fn(() => new Uint8Array([1, 2, 3, 4]).buffer);
      const { ipc, pairNow, harness, satellite } = await setup({
        'avatar-model:list': () => [{ id: 'm1', name: 'Echo', fileSha: 'sha-1' }],
        'avatar-model:load': load as never,
      });
      await pairNow();
      await online(harness, () => satellite.status());
      await ipc('avatar-model:list');
      expect(Array.from((await ipc('avatar-model:load', 'm1')) as Uint8Array)).toEqual([1, 2, 3, 4]);
      await satellite.cacheIdle();
      expect(Array.from((await ipc('avatar-model:load', 'm1')) as Uint8Array)).toEqual([1, 2, 3, 4]);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('are fetched again when the file changed on bija', async () => {
      let sha = 'sha-1';
      let body = [1, 1];
      const load = vi.fn(() => new Uint8Array(body).buffer);
      const { ipc, pairNow, harness, satellite } = await setup({
        'avatar-model:list': () => [{ id: 'm1', fileSha: sha }],
        'avatar-model:load': load as never,
      });
      await pairNow();
      await online(harness, () => satellite.status());
      await ipc('avatar-model:list');
      await ipc('avatar-model:load', 'm1');
      await satellite.cacheIdle();
      sha = 'sha-2';
      body = [2, 2, 2];
      await ipc('avatar-model:list');
      expect(Array.from((await ipc('avatar-model:load', 'm1')) as Uint8Array)).toEqual([2, 2, 2]);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('load from the disk cache while bija is away', async () => {
      const { ipc, pairNow, harness, satellite } = await setup({
        'avatar-model:list': () => [{ id: 'm1', fileSha: 'sha-1' }],
        'avatar-model:load': (() => new Uint8Array([5, 6]).buffer) as never,
      });
      await pairNow();
      await online(harness, () => satellite.status());
      await ipc('avatar-model:list');
      await ipc('avatar-model:load', 'm1');
      await satellite.cacheIdle();
      await harness.hub.stop();
      await waitFor(() => satellite.status().link === 'offline');
      expect(Array.from((await ipc('avatar-model:load', 'm1')) as Uint8Array)).toEqual([5, 6]);
    });
  });

  describe('room files', () => {
    it('come through the asset protocol from bija, then from the disk cache', async () => {
      const { pairNow, harness, satellite, asset } = await setup();
      await pairNow();
      await online(harness, () => satellite.status());
      const url = 'aiembodied-asset://polyhaven/chair/chair.glb';
      const first = await asset(url);
      expect(first.status).toBe(200);
      expect(first.headers.get('Content-Type')).toBe('model/gltf-binary');
      expect(Array.from(new Uint8Array(await first.arrayBuffer()))).toEqual([1, 2, 3, 4, 5]);
      await satellite.cacheIdle();
      // Bija goes away: the file is still served.
      await harness.hub.stop();
      await waitFor(() => satellite.status().link === 'offline');
      const second = await asset(url);
      expect(second.status).toBe(200);
      expect(Array.from(new Uint8Array(await second.arrayBuffer()))).toEqual([1, 2, 3, 4, 5]);
    });

    it('are 404 when neither bija nor the cache has them', async () => {
      const { pairNow, harness, satellite, asset } = await setup();
      await pairNow();
      await online(harness, () => satellite.status());
      expect((await asset('aiembodied-asset://polyhaven/chair/missing.glb')).status).toBe(404);
      expect((await asset('https://example.com/x.glb')).status).toBe(404);
    });
  });
});

describe('satellite settings', () => {
  it('remembers the pairing and the window, and clearing the pairing keeps the window', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'satellite-settings-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    const file = path.join(folder, SATELLITE_FILE);
    const store = new SatelliteSettingsStore(file);
    expect(store.isPaired()).toBe(false);
    store.update({ hubUrl: 'ws://bija:8791', deviceId: 'room-1', placeId: 'study', bounds: { x: 10, y: 20, width: 900, height: 700, fullScreen: false } });
    const again = new SatelliteSettingsStore(file);
    expect(again.isPaired()).toBe(true);
    expect(again.get().bounds).toEqual({ x: 10, y: 20, width: 900, height: 700, fullScreen: false });
    again.clearPairing();
    expect(new SatelliteSettingsStore(file).get()).toMatchObject({ hubUrl: null, deviceId: null, bounds: { width: 900 } });
  });

  it('survives a broken file and junk bounds', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'satellite-settings-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    const store = new SatelliteSettingsStore(path.join(folder, SATELLITE_FILE));
    store.update({ bounds: { width: 5, height: 5, fullScreen: false } });
    expect(new SatelliteSettingsStore(path.join(folder, SATELLITE_FILE)).get().bounds).toBeNull();
  });

  it('decides the role: the environment, else a PC that paired before; AIEMBODIED_ROLE=full wins over the file', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'satellite-role-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    expect(detectSatelliteRole({}, folder)).toBe(false);
    expect(detectSatelliteRole({ AIEMBODIED_ROLE: 'satellite' }, folder)).toBe(true);
    expect(detectSatelliteRole({ AIEMBODIED_ROLE: ' Satellite ' }, folder)).toBe(true);
    new SatelliteSettingsStore(path.join(folder, SATELLITE_FILE)).update({ hubUrl: 'ws://bija:8791', deviceId: 'room-1' });
    expect(detectSatelliteRole({}, folder)).toBe(true);
    expect(detectSatelliteRole({ AIEMBODIED_ROLE: 'full' }, folder)).toBe(false);
  });

  it('takes the user data folder from AIEMBODIED_USER_DATA', () => {
    expect(userDataOverride({})).toBeNull();
    expect(userDataOverride({ AIEMBODIED_USER_DATA: '  ' })).toBeNull();
    expect(userDataOverride({ AIEMBODIED_USER_DATA: '/tmp/satellite-data' })).toBe(path.resolve('/tmp/satellite-data'));
  });
});

describe('Satellite devices', () => {
  it('tells the device runtime about the link, the snapshot and bija asking devices off', async () => {
    const { satellite, pairNow, harness } = await setup();
    const calls: string[] = [];
    satellite.attachDevices({
      state: () => ({}) as never,
      setLinkUp: (up) => void calls.push(`link:${up}`),
      setSnapshot: (snapshot) => void calls.push(`snapshot:${(snapshot as { localPlaceId: string }).localPlaceId}`),
      hubOff: (reason) => void calls.push(`off:${reason}`),
      setOpen: () => ({}) as never,
      captureStopped: () => undefined,
    });
    await pairNow();
    await waitFor(() => calls.includes('link:true') && calls.includes('snapshot:study'), 5000, 'link and snapshot');
    harness.hub.deviceOff(harness.hub.status().devices[0].id, 'test');
    await waitFor(() => calls.includes('off:test'), 5000, 'device.off');
    await satellite.forget();
    expect(calls.at(-1)).toBe('link:false');
  });

  it('is closed until the runtime is attached, and sends ops only while online', async () => {
    const { satellite, ipc } = await setup();
    expect(((await ipc('device-gate:get')) as { micAllowed: boolean }).micAllowed).toBe(false);
    expect(satellite.sendOp({ op: 'room.close' })).toBe(false);
  });

  it('keeps this PC\'s speakers in satellite.json and logs turn timings', async () => {
    const { ipc, settings } = await setup();
    await ipc('config:set-audio-devices', { audioOutputDeviceId: 'speaker-2' });
    expect(settings.get().audioOutputDeviceId).toBe('speaker-2');
    await ipc('satellite:turn-timing', { transcriptMs: 410.4, firstAudioMs: 900, playbackMs: 'x' });
  });
});

describe('KeychainTokenStore', () => {
  it('keeps the token under the service and the hub URL', async () => {
    const calls: string[][] = [];
    const vault = new Map<string, string>();
    const store = new KeychainTokenStore(async () => ({
      getPassword: async (service, account) => (calls.push(['get', service, account]), vault.get(`${service}|${account}`) ?? null),
      setPassword: async (service, account, password) => void (calls.push(['set', service, account]), vault.set(`${service}|${account}`, password)),
      deletePassword: async (service, account) => (calls.push(['delete', service, account]), vault.delete(`${service}|${account}`)),
    }));
    await store.set('ws://bija:8791', 'tok');
    expect(await store.get('ws://bija:8791')).toBe('tok');
    await store.delete('ws://bija:8791');
    expect(await store.get('ws://bija:8791')).toBeNull();
    expect(calls.every(([, service]) => service === TOKEN_SERVICE)).toBe(true);
    expect(TOKEN_SERVICE).toBe('aiembodied-room-link');
  });

  it('falls back to memory for this run when there is no keychain, and says so', async () => {
    const store = new KeychainTokenStore(async () => {
      throw new Error('no secret service');
    });
    await store.set('ws://bija:8791', 'tok');
    expect(await store.get('ws://bija:8791')).toBe('tok');
    expect(store.lastError).toMatch(/forgotten when the app closes/);
  });
});
