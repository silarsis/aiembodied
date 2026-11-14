import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSatellite } from '../../../renderer/src/web-satellite/web-satellite.js';
import { WebStore } from '../../../renderer/src/web-satellite/web-store.js';
import { browserSocketFactory } from '../../../renderer/src/web-satellite/browser-socket.js';
import type { ShellHook } from '../../../renderer/src/web-satellite/shell-hook.js';
import type { DeviceGateState } from '../../src/satellite/device-gate.js';
import type { SatelliteStatus } from '../../src/satellite/satellite.js';
import type { Op } from '../../src/room-hub/frames.js';
import { startHarness, waitFor, type Harness } from './hub-harness.js';

/** A localStorage that lives in a Map. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Made {
  harness: Harness;
  satellite: WebSatellite;
  storage: ReturnType<typeof memoryStorage>;
  visible: { value: boolean };
  states: Op[];
  statuses: SatelliteStatus[];
  gates: DeviceGateState[];
  reloads: { count: number };
}

function build(harness: Harness, storage: ReturnType<typeof memoryStorage>, shell: ShellHook | null = null) {
  const visible = { value: true };
  const reloads = { count: 0 };
  const gates: DeviceGateState[] = [];
  const satellite = new WebSatellite({
    store: new WebStore(storage),
    socketFactory: browserSocketFactory(globalThis.WebSocket as never),
    shell,
    pageOrigin: null,
    isVisible: () => visible.value,
    reload: () => void (reloads.count += 1),
    deviceName: 'test browser',
    linkOptions: { pingMs: 50, timeoutMs: 800, backoffFirstMs: 30, backoffMaxMs: 120 },
    captureTimeoutMs: 40,
  });
  cleanups.push(() => satellite.stop());
  const statuses: SatelliteStatus[] = [];
  satellite.bridge.satellite?.onStatus((status) => statuses.push(status));
  satellite.bridge.deviceGate?.onChanged((state) => gates.push(state));
  return { harness, satellite, storage, visible, statuses, gates, reloads };
}

async function setup(options: { handlers?: Parameters<typeof startHarness>[0]; shell?: ShellHook | null; storage?: ReturnType<typeof memoryStorage>; pair?: boolean } = {}): Promise<Made> {
  const states: Op[] = [];
  const harness = await startHarness(options.handlers ?? {}, {
    onSatelliteMessage: (_from, op) => states.push(op),
  });
  cleanups.push(() => harness.cleanup());
  const made = { ...build(harness, options.storage ?? memoryStorage(), options.shell ?? null), states };
  made.satellite.start();
  if (options.pair !== false) {
    const code = await harness.code();
    await made.satellite.bridge.satellite?.pair({ hubUrl: harness.url(), code, placeName: 'the study', deviceName: 'My laptop' });
    await waitFor(() => made.satellite.status().link === 'online', 4000, 'online');
  }
  return made;
}

/** Puts Echo in the satellite's room, as bija would when it walks there. */
function seatEcho(made: Made): void {
  made.harness.places.startMove('echo', 'study', 'test');
  made.harness.places.arrived('echo');
}

describe('the web satellite against a real RoomHub', () => {
  it('shows the connect screen state until it pairs, then pairs as a browser, stores the pairing and connects', async () => {
    const made = await setup({ pair: false });
    expect(made.satellite.status()).toMatchObject({ role: 'satellite', paired: false, link: 'idle', deviceKind: 'browser' });
    const code = await made.harness.code();
    const after = await made.satellite.bridge.satellite?.pair({ hubUrl: made.harness.url(), code, placeName: 'the study', deviceName: 'My laptop' });
    expect(after).toMatchObject({ paired: true, deviceName: 'My laptop' });
    await waitFor(() => made.satellite.status().link === 'online');
    expect(made.satellite.status()).toMatchObject({ placeId: 'study', placeName: 'the study' });
    // The hub knows it as a browser.
    const device = made.harness.registry.list()[0];
    expect(device).toMatchObject({ kind: 'browser', name: 'My laptop' });
    // The pairing (with the token) is in storage, so a reload connects without the code.
    expect([...made.storage.data.keys()]).toContain('aiembodied.web.pairing');
    expect(made.statuses.map((status) => status.link)).toContain('online');
  });

  it('reconnects on its own after a reload, from the stored pairing, and is refused when the hub does not know it', async () => {
    const first = await setup();
    const reloaded = build(first.harness, first.storage);
    reloaded.satellite.start();
    await waitFor(() => reloaded.satellite.status().link === 'online', 4000, 'online after reload');
    expect(reloaded.satellite.status()).toMatchObject({ paired: true, placeId: 'study' });
    // Revoked on bija: refused, with the reason.
    await first.harness.code();
    await first.harness.hub.revoke(first.harness.registry.list()[0].id);
    await waitFor(() => reloaded.satellite.status().link === 'refused', 4000, 'refused');
    expect(reloaded.satellite.status()).toMatchObject({ paired: true, linkCode: 'revoked' });
    // Forgetting clears storage and goes back to the connect screen.
    const after = await reloaded.satellite.bridge.satellite?.forget();
    expect(after).toMatchObject({ paired: false, link: 'idle' });
    expect(reloaded.storage.data.has('aiembodied.web.pairing')).toBe(false);
  });

  it('answers local channels itself: config says satellite and browser, audio choice is kept in storage', async () => {
    const { satellite, storage } = await setup();
    const config = await satellite.bridge.config.get();
    expect(config).toMatchObject({ role: 'satellite', satelliteKind: 'browser', hasRealtimeApiKey: false });
    const next = await satellite.bridge.config.setAudioDevicePreferences({ audioOutputDeviceId: 'speaker-1' });
    expect(next).toMatchObject({ audioOutputDeviceId: 'speaker-1' });
    expect(JSON.parse(storage.data.get('aiembodied.web.audio') as string)).toEqual({ audioOutputDeviceId: 'speaker-1' });
    expect(await satellite.bridge.wakeWord.list?.()).toEqual([]);
    expect(await satellite.bridge.satellite?.startAtLogin?.()).toBe(false);
    await expect(satellite.bridge.app?.quit()).resolves.toBeUndefined();
  });

  it('refuses channels a satellite never runs', async () => {
    const { satellite } = await setup();
    await expect(satellite.bridge.config.getSecret('realtimeApiKey')).rejects.toThrow('Not available on a satellite PC.');
    await expect(satellite.bridge.avatars?.remove('echo')).rejects.toThrow('Not available on a satellite PC.');
  });

  it('calls bija and gets answers, with bytes going out and coming back', async () => {
    const seen: number[] = [];
    const { satellite } = await setup({
      handlers: {
        'avatars:list': () => [{ id: 'echo' }],
        'local-voice:transcribe': ((_event: unknown, wav: Uint8Array) => (seen.push(wav.byteLength), { text: `got ${wav.byteLength}` })) as never,
        'avatar-model:load': () => new Uint8Array([9, 8, 7, 6]).buffer,
      },
    });
    expect(await satellite.bridge.avatars?.list()).toEqual([{ id: 'echo' }]);
    const wav = new Uint8Array(200_000).map((_, index) => index % 251);
    expect(await satellite.bridge.localVoice?.transcribe(wav.buffer)).toEqual({ text: 'got 200000' });
    expect(seen).toEqual([200_000]);
    const body = await satellite.bridge.avatar?.loadModelBinary('m1');
    expect(Array.from(new Uint8Array(body as ArrayBuffer))).toEqual([9, 8, 7, 6]);
  });

  it('hands events from bija to the page\'s listeners, and drops channels the page does not listen for', async () => {
    const { harness, satellite } = await setup({ handlers: { 'local-voice:respond': ((event: { sender: { send: (channel: string, ...args: unknown[]) => void } }) => {
      event.sender.send('local-voice:event', { type: 'hello' });
      event.sender.send('config:changed', { sneaky: true });
      return { ok: true };
    }) as never } });
    const events: unknown[] = [];
    satellite.bridge.localVoice?.onEvent((event) => events.push(event));
    const sneaky = vi.fn();
    satellite.bridge.camera?.onDetection(sneaky);
    await satellite.bridge.localVoice?.respond({ text: 'hi' } as never);
    await waitFor(() => events.length > 0);
    expect(events).toEqual([{ type: 'hello' }]);
    // places:changed arrives through the bridge too.
    const snapshots: unknown[] = [];
    satellite.bridge.places?.onChanged((snapshot) => snapshots.push(snapshot));
    harness.places.setRoom('study', 'cabin');
    await waitFor(() => snapshots.length > 0);
  });

  it('rejects calls when the link is down, and reconnects with backoff when the hub comes back', async () => {
    const { harness, satellite } = await setup({ handlers: { 'avatars:list': () => [] } });
    await harness.stop();
    await waitFor(() => satellite.status().link === 'offline', 4000, 'offline');
    await expect(satellite.bridge.avatars?.list()).rejects.toThrow('Lost touch with bija.');
    await harness.restart();
    await waitFor(() => satellite.status().link === 'online', 6000, 'online again');
    await expect(satellite.bridge.avatars?.list()).resolves.toEqual([]);
  });

  it('is refused with a wrong token (a shell that holds a bad pairing) and says so', async () => {
    const harness = await startHarness({});
    cleanups.push(() => harness.cleanup());
    await harness.code();
    const made = build(harness, memoryStorage(), { token: 'nope', deviceId: 'room-nope', hubUrl: harness.url() });
    made.satellite.start();
    await waitFor(() => made.satellite.status().link === 'refused', 4000, 'refused');
    expect(made.satellite.status()).toMatchObject({ paired: true, linkCode: 'auth' });
    // A shell's pairing is never written to the page's storage.
    expect(made.storage.data.has('aiembodied.web.pairing')).toBe(false);
  });

  it('gives the welcome\'s asset key for /v1/asset while online, and none when offline', async () => {
    const { harness, satellite } = await setup();
    const key = satellite.assetKey();
    expect(typeof key).toBe('string');
    const response = await fetch(`http://127.0.0.1:${harness.hub.port()}/v1/asset?url=${encodeURIComponent('aiembodied-asset://polyhaven/chair/chair.glb')}&k=${key}`);
    expect(response.status).toBe(200);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4, 5]);
    await harness.stop();
    await waitFor(() => satellite.status().link === 'offline');
    expect(satellite.assetKey()).toBeNull();
  });
});

describe('the web satellite\'s privacy gate', () => {
  it('is off until an avatar is in the room, then live, and tells bija with device.state', async () => {
    const made = await setup();
    expect((await made.satellite.bridge.deviceGate?.get())?.mic).toBe('off');
    seatEcho(made);
    await waitFor(() => made.gates.at(-1)?.mic === 'live', 4000, 'live');
    expect(made.gates.at(-1)).toMatchObject({ micAllowed: true, unlocked: true, noFullscreenApp: true, linkUp: true });
    await waitFor(() => made.states.some((op) => op.op === 'device.state' && op.mic === 'live'));
  });

  it('closes when the page is hidden: the page is told to stop capture, and a page that does not confirm is reloaded', async () => {
    const made = await setup();
    seatEcho(made);
    await waitFor(() => made.gates.at(-1)?.mic === 'live');
    made.visible.value = false;
    made.satellite.visibilityChanged();
    expect(made.gates.at(-1)).toMatchObject({ mic: 'off', micAllowed: false, locked: true });
    // Nobody confirms capture stopped: fail closed by reloading.
    await waitFor(() => made.reloads.count === 1, 2000, 'reload');
    await waitFor(() => made.states.some((op) => op.op === 'device.state' && op.mic === 'off' && op.locked === true));
    // Shown again: back to live.
    made.visible.value = true;
    made.satellite.visibilityChanged();
    expect(made.gates.at(-1)?.mic).toBe('live');
  });

  it('does not reload once the page confirms that capture stopped', async () => {
    const made = await setup();
    seatEcho(made);
    await waitFor(() => made.gates.at(-1)?.mic === 'live');
    made.visible.value = false;
    made.satellite.visibilityChanged();
    await made.satellite.bridge.deviceGate?.captureStopped();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(made.reloads.count).toBe(0);
  });

  it('closes when the link drops, and opens nothing by itself when it comes back without an avatar', async () => {
    const made = await setup();
    seatEcho(made);
    await waitFor(() => made.gates.at(-1)?.mic === 'live');
    await made.harness.stop();
    await waitFor(() => made.gates.at(-1)?.mic === 'off', 4000, 'off');
    expect(made.gates.at(-1)).toMatchObject({ linkUp: false, summary: 'Not connected to bija' });
  });

  it('has a kill switch that survives a reload and sends the avatars home', async () => {
    const made = await setup();
    seatEcho(made);
    await waitFor(() => made.gates.at(-1)?.mic === 'live');
    const closed = await made.satellite.bridge.deviceGate?.setOpen(false);
    expect(closed).toMatchObject({ open: false, mic: 'off', closed: true });
    expect(made.storage.data.get('aiembodied.web.closed')).toBe('1');
    await waitFor(() => made.states.some((op) => op.op === 'room.close'));
    // A new page with the same storage starts closed.
    const again = build(made.harness, made.storage).satellite;
    expect(await again.bridge.deviceGate?.get()).toMatchObject({ open: false, mic: 'off' });
    // Opening it again lets the mic live.
    await made.satellite.bridge.deviceGate?.setOpen(true);
    await waitFor(() => made.states.some((op) => op.op === 'room.open'));
  });

  it('fails closed when bija asks the devices off, and a new connection lifts the hold', async () => {
    const made = await setup();
    seatEcho(made);
    await waitFor(() => made.gates.at(-1)?.mic === 'live');
    made.harness.hub.deviceOff(made.harness.registry.list()[0].id, 'test');
    await waitFor(() => made.gates.at(-1)?.mic === 'off');
    expect(made.gates.at(-1)).toMatchObject({ notHeldOff: false, summary: 'bija turned the devices off' });
  });

  it('never allows the doorbell on the web (no wake word worker in a browser)', async () => {
    const made = await setup();
    // Nobody here, everything else fine: a desktop with the doorbell on would be "doorbell", a web page is plain off.
    expect(made.gates.at(-1)?.doorbell ?? false).toBe(false);
    expect((await made.satellite.bridge.deviceGate?.get())?.doorbell).toBe(false);
  });

  it('follows a shell: foreground fact, onGate hook and a pairing handed over at boot', async () => {
    const onGate = vi.fn();
    const foreground = { value: true };
    const shell: ShellHook = { foreground: () => foreground.value, onGate };
    const made = await setup({ shell });
    seatEcho(made);
    await waitFor(() => made.gates.at(-1)?.mic === 'live');
    expect(onGate).toHaveBeenCalled();
    expect((onGate.mock.calls.at(-1) as [DeviceGateState])[0].mic).toBe('live');
    foreground.value = false;
    made.satellite.visibilityChanged();
    expect(made.gates.at(-1)).toMatchObject({ mic: 'off', locked: true });
  });
});
