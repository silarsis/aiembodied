import { afterEach, describe, expect, it } from 'vitest';
import { LOST_TOUCH, RoomLink, parseHubUrl, type LinkStatus, type RoomLinkOptions } from '../../src/satellite/room-link.js';
import { startHarness, waitFor, type Harness } from './hub-harness.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function pairOnce(harness: Harness): Promise<{ deviceId: string; token: string; placeId: string }> {
  const code = await harness.code();
  const response = await fetch(`http://127.0.0.1:${harness.hub.port()}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'test desk', placeName: 'the study' }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { deviceId: string; token: string; placeId: string };
}

async function setup(handlers: Parameters<typeof startHarness>[0] = {}, options: Partial<RoomLinkOptions> = {}) {
  const harness = await startHarness(handlers);
  cleanups.push(() => harness.cleanup());
  const paired = await pairOnce(harness);
  const statuses: LinkStatus[] = [];
  const events: Array<{ channel: string; args: unknown[] }> = [];
  const link = new RoomLink({
    url: harness.url(),
    deviceId: paired.deviceId,
    token: paired.token,
    appVersion: 'test',
    onIpc: (channel, args) => events.push({ channel, args }),
    onStatus: (status) => statuses.push(status),
    pingMs: 50,
    timeoutMs: 600,
    backoffFirstMs: 30,
    backoffMaxMs: 120,
    ...options,
  });
  cleanups.push(() => link.stop());
  return { harness, paired, link, statuses, events };
}

describe('parseHubUrl', () => {
  it('takes a ws address, an http address or a bare host, and defaults the port', () => {
    expect(parseHubUrl('ws://bija:8791')).toEqual({ ws: 'ws://bija:8791', http: 'http://bija:8791' });
    expect(parseHubUrl('bija')).toEqual({ ws: 'ws://bija:8791', http: 'http://bija:8791' });
    expect(parseHubUrl(' http://100.64.0.1:9000/ ')).toEqual({ ws: 'ws://100.64.0.1:9000', http: 'http://100.64.0.1:9000' });
    expect(parseHubUrl('wss://hub.example')).toEqual({ ws: 'wss://hub.example:8791', http: 'https://hub.example:8791' });
  });
  it('refuses what is not an address', () => {
    expect(parseHubUrl('')).toBeNull();
    expect(parseHubUrl('ftp://bija')).toBeNull();
    expect(parseHubUrl('ws://')).toBeNull();
  });
});

describe('RoomLink against a real RoomHub', () => {
  it('connects, says hello and is welcomed with its place', async () => {
    const { link, statuses } = await setup();
    link.start();
    await waitFor(() => link.status().state === 'online', 4000, 'online');
    expect(statuses.map((status) => status.state)).toEqual(['connecting', 'online']);
    expect(link.welcome()).toMatchObject({ placeId: 'study', place: { name: 'the study' }, settings: { wakeWord: { keywordLabel: 'Hey Echo' } } });
    expect(link.welcome()?.avatars).toHaveLength(2);
  });

  it('calls a channel on bija and gets the answer, with bytes going in and coming out', async () => {
    const seen: unknown[] = [];
    const { link } = await setup({
      'avatars:list': () => [{ id: 'echo' }],
      'local-voice:transcribe': ((_event: unknown, wav: Uint8Array) => (seen.push(wav), { text: `got ${wav.byteLength} bytes` })) as never,
      'avatar-model:load': () => new Uint8Array([9, 8, 7, 6]).buffer,
    });
    link.start();
    await waitFor(() => link.status().state === 'online');
    expect(await link.call('avatars:list')).toEqual([{ id: 'echo' }]);
    const wav = new Uint8Array(100_000).map((_, index) => index % 251);
    expect(await link.call('local-voice:transcribe', [wav])).toEqual({ text: 'got 100000 bytes' });
    expect(Array.from(seen[0] as Uint8Array).slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    const body = (await link.call('avatar-model:load', ['m1'])) as Uint8Array;
    expect(Array.from(body)).toEqual([9, 8, 7, 6]);
  });

  it('rejects a call bija refuses or fails, with its words', async () => {
    const { link } = await setup({
      'avatars:list': () => {
        throw new Error('registry is down');
      },
    });
    link.start();
    await waitFor(() => link.status().state === 'online');
    await expect(link.call('avatars:list')).rejects.toThrow('registry is down');
    await expect(link.call('models:set-key', ['x'])).rejects.toMatchObject({ code: 'denied' });
    await expect(link.call('presence:get-dnd')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('delivers an ipc event bija pushes', async () => {
    const { link, harness, events } = await setup();
    link.start();
    await waitFor(() => link.status().state === 'online');
    harness.hub.sendToPlace('study', { op: 'ipc', channel: 'local-voice:event', args: [{ requestId: 'c1', type: 'sentence', wav: new Uint8Array([1, 2, 3]) }] });
    await waitFor(() => events.some((event) => event.channel === 'local-voice:event'));
    const event = events.find((item) => item.channel === 'local-voice:event');
    expect((event?.args[0] as { wav: Uint8Array }).wav).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('streams events back while a long call runs (the fake sender reaches the satellite)', async () => {
    const { link, events } = await setup({
      'avatar-motion:stream': (async (event: { sender: { send: (channel: string, ...args: unknown[]) => void } }) => {
        event.sender.send('avatar-motion:chunk', { streamId: 's1', index: 0 });
        await new Promise((resolve) => setTimeout(resolve, 150));
        event.sender.send('avatar-motion:chunk', { streamId: 's1', index: 1 });
        return { streamId: 's1', chunks: 2 };
      }) as never,
    });
    link.start();
    await waitFor(() => link.status().state === 'online');
    expect(await link.call('avatar-motion:stream', [{ streamId: 's1' }])).toEqual({ streamId: 's1', chunks: 2 });
    expect(events.filter((event) => event.channel === 'avatar-motion:chunk').map((event) => (event.args[0] as { index: number }).index)).toEqual([0, 1]);
  });

  it('times a call out after the default wait, but not the channels that run long', async () => {
    const never = () => new Promise(() => undefined);
    const { link } = await setup({ 'avatars:list': never as never, 'local-voice:respond': never as never }, { callTimeoutMs: 120 });
    link.start();
    await waitFor(() => link.status().state === 'online');
    await expect(link.call('avatars:list')).rejects.toMatchObject({ code: 'timeout' });
    const long = link.call('local-voice:respond', [{ requestId: 'r', text: 'hi' }]);
    const outcome = await Promise.race([long.then(() => 'answered', () => 'failed'), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 400))]);
    expect(outcome).toBe('still waiting');
  });

  it('fetches a room file with asset.get', async () => {
    const { link } = await setup();
    link.start();
    await waitFor(() => link.status().state === 'online');
    const asset = await link.getAsset('aiembodied-asset://polyhaven/chair/chair.glb');
    expect(asset.mime).toBe('model/gltf-binary');
    expect(Array.from(asset.data)).toEqual([1, 2, 3, 4, 5]);
    await expect(link.getAsset('aiembodied-asset://polyhaven/chair/missing.glb')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('fails calls at once while offline, drops the ones waiting, and comes back when bija does', async () => {
    const { link, harness, statuses } = await setup({ 'avatars:list': () => ['echo'] });
    link.start();
    await waitFor(() => link.status().state === 'online');
    const waiting = link.call('local-voice:respond', [{ requestId: 'r', text: 'hi' }]);
    const waitingFailed = waiting.then(
      () => 'answered',
      (error: Error) => error.message,
    );
    await harness.hub.stop();
    await waitFor(() => link.status().state === 'offline', 4000, 'offline');
    expect(await waitingFailed).toBe(LOST_TOUCH);
    const started = Date.now();
    await expect(link.call('avatars:list')).rejects.toThrow(LOST_TOUCH);
    expect(Date.now() - started).toBeLessThan(100);
    expect(link.send({ op: 'presence', listening: true })).toBe(false);

    await harness.restart();
    await waitFor(() => link.status().state === 'online', 6000, 'online again');
    expect(await link.call('avatars:list')).toEqual(['echo']);
    expect(statuses.map((status) => status.state)).toEqual(['connecting', 'online', 'offline', 'online']);
  });

  it('keeps trying with a longer wait each time while bija is away', async () => {
    const { link, harness } = await setup();
    link.start();
    await waitFor(() => link.status().state === 'online');
    await harness.hub.stop();
    await waitFor(() => link.status().state === 'offline');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(link.status().state).toBe('offline');
    await harness.restart();
    await waitFor(() => link.status().state === 'online', 6000);
  });

  it('is refused for a wrong token, and does not keep knocking', async () => {
    const { harness, paired, statuses } = await setup();
    const link = new RoomLink({
      url: harness.url(),
      deviceId: paired.deviceId,
      token: 'not-the-token',
      appVersion: 'test',
      onIpc: () => undefined,
      onStatus: (status) => statuses.push(status),
      backoffFirstMs: 20,
    });
    cleanups.push(() => link.stop());
    link.start();
    await waitFor(() => link.status().state === 'refused');
    expect(link.status()).toMatchObject({ state: 'refused', code: 'auth' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(link.status().state).toBe('refused');
    await expect(link.call('avatars:list')).rejects.toMatchObject({ code: 'auth' });
  });

  it('is refused once bija revokes it', async () => {
    const { link, harness, paired } = await setup();
    link.start();
    await waitFor(() => link.status().state === 'online');
    await harness.hub.revoke(paired.deviceId);
    await waitFor(() => link.status().state === 'refused');
    expect(link.status().code).toBe('revoked');
  });

  it('gives the first connection a few seconds, so start-up calls wait instead of failing', async () => {
    const { link } = await setup({ 'avatars:list': () => ['echo'] });
    link.start();
    // Asked before the welcome arrived.
    expect(await link.call('avatars:list')).toEqual(['echo']);
  });

  it('reports presence and device state to bija', async () => {
    const got: unknown[] = [];
    const harness = await startHarness({}, { onSatelliteMessage: (from, op) => void got.push({ from, op }) });
    cleanups.push(() => harness.cleanup());
    const paired = await pairOnce(harness);
    const link = new RoomLink({ url: harness.url(), deviceId: paired.deviceId, token: paired.token, appVersion: 't', onIpc: () => undefined, onStatus: () => undefined });
    cleanups.push(() => link.stop());
    link.start();
    await waitFor(() => link.status().state === 'online');
    expect(link.send({ op: 'presence', listening: true, userSpokeAt: 5 })).toBe(true);
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatchObject({ from: { placeId: 'study' }, op: { op: 'presence', listening: true } });
  });
});
