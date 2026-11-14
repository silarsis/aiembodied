import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridge } from '../../../main/src/bridge/create-bridge.js';
import { channelKind } from '../../../main/src/satellite/channels.js';
import { ConnectScreen } from '../../src/satellite/connect-screen.js';
import { SatelliteStatusPanel } from '../../src/satellite/satellite-status-panel.js';
import { WebGate } from '../../src/web-satellite/web-gate.js';
import { WebStore } from '../../src/web-satellite/web-store.js';
import { WebSatellite, parseWebHubUrl } from '../../src/web-satellite/web-satellite.js';
import { bootWebSatellite, pageServedByHub } from '../../src/web-satellite/boot.js';
import { readShellHook } from '../../src/web-satellite/shell-hook.js';
import { browserSocketFactory } from '../../src/web-satellite/browser-socket.js';
import { hubAssetResolver, resolveAssetUrl, setAssetUrlResolver } from '../../src/rooms/asset-url.js';
import type { SatelliteStatus } from '../../../main/src/satellite/bridge-types.js';

afterEach(() => {
  setAssetUrlResolver(null);
  delete (window as unknown as { aiembodied?: unknown }).aiembodied;
  delete (window as unknown as { __AIEMBODIED_SHELL__?: unknown }).__AIEMBODIED_SHELL__;
  window.localStorage.clear();
});

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

function satelliteWith(options: { visible?: () => boolean; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const storage = options.storage ?? memoryStorage();
  const reload = vi.fn();
  const satellite = new WebSatellite({
    store: new WebStore(storage),
    socketFactory: () => ({ isOpen: false, send: () => undefined, close: () => undefined, terminate: () => undefined, detach: () => undefined }),
    pageOrigin: 'http://127.0.0.1:8791',
    isVisible: options.visible ?? (() => true),
    reload,
    deviceName: 'This browser',
    captureTimeoutMs: 30,
  });
  return { satellite, storage, reload };
}

const SNAPSHOT = {
  localPlaceId: 'study',
  locations: { echo: 'study' },
  transit: [],
  places: [{ id: 'study', name: 'the study', node: 'room-1', online: true, camera: true }],
};

describe('the web bridge', () => {
  it('has exactly the same shape as the one the Electron preload builds (one list of channels)', () => {
    const { satellite } = satelliteWith();
    const electron = createBridge({ invoke: async () => undefined, on: () => () => undefined });
    const shape = (value: unknown): unknown =>
      value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, shape(inner)])) : typeof value;
    expect(shape(satellite.bridge)).toEqual(shape(electron));
    expect(satellite.bridge.__bridgeReady).toBe(true);
  });

  it('classifies every channel the bridge can call, and answers or refuses each one without hanging', async () => {
    const { satellite } = satelliteWith();
    const seen = new Set<string>();
    const recorder = createBridge({
      invoke: async (channel) => {
        seen.add(channel);
        return undefined;
      },
      on: (channel) => {
        seen.add(channel);
        return () => undefined;
      },
    });
    // Walk the whole API: call every function with no arguments and subscribe every listener.
    const walk = async (node: unknown): Promise<void> => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (typeof value === 'function') {
          try {
            await (key.startsWith('on') ? (value as (cb: () => void) => unknown)(() => undefined) : (value as () => unknown)());
          } catch {
            // Some calls need arguments; the channel was still recorded if it got that far.
          }
        } else await walk(value);
      }
    };
    await walk(recorder);
    expect(seen.size).toBeGreaterThan(150);
    const unclassified = [...seen].filter((channel) => channelKind(channel) === undefined);
    expect(unclassified).toEqual([]);
    // Every one that is called (not an event) gets an answer from the web satellite: either its own, or a refusal, or "Lost touch" while offline.
    for (const channel of seen) {
      const kind = channelKind(channel);
      if (kind === 'event') continue;
      const outcome = await satellite.invoke(channel, []).then(
        () => 'answered',
        (error: Error) => error.message,
      );
      if (kind === 'unavailable') expect(outcome, channel).toBe('Not available on a satellite PC.');
      if (kind === 'forward') expect(outcome, channel).toBe('Lost touch with bija.');
      if (kind === 'local') expect(outcome, channel).not.toBe('Not available on a satellite PC.');
    }
  });
});

describe('web gate facts', () => {
  const live = { occupied: true };
  function gate(visible: { value: boolean }, closed = false) {
    const changes: Array<{ mic: string; summary: string }> = [];
    const reload = vi.fn();
    const g = new WebGate({
      isForeground: () => visible.value,
      closed,
      onChange: (state) => changes.push({ mic: state.mic, summary: state.summary }),
      reload,
      captureTimeoutMs: 20,
    });
    return { g, changes, reload };
  }

  it('starts closed (fail closed): nothing is known yet', () => {
    const { g } = gate({ value: true });
    expect(g.state()).toMatchObject({ mic: 'off', micAllowed: false, camera: 'off', linkUp: false, occupied: false, noFullscreenApp: true, open: true });
  });

  it('is live only when the link is up, an avatar is here, the page is visible, the room is open and bija has not held it off', () => {
    const visible = { value: true };
    const { g } = gate(visible);
    g.setLinkUp(true);
    expect(g.state().mic).toBe('off');
    g.setSnapshot(SNAPSHOT);
    expect(g.state()).toMatchObject({ mic: 'live', camera: 'live', cameraEnabled: true });
    g.setSnapshot({ ...SNAPSHOT, places: [{ ...SNAPSHOT.places[0], camera: false }] });
    expect(g.state()).toMatchObject({ mic: 'live', camera: 'off' });
    g.hubOff();
    expect(g.state().mic).toBe('off');
    g.setLinkUp(true);
    expect(g.state().mic).toBe('live');
    void live;
  });

  it('visibility hidden closes the gate, and a page that never confirms capture stopped is reloaded', async () => {
    const visible = { value: true };
    const { g, changes, reload } = gate(visible);
    g.setLinkUp(true);
    g.setSnapshot(SNAPSHOT);
    expect(g.state().mic).toBe('live');
    visible.value = false;
    g.checkForeground();
    expect(g.state()).toMatchObject({ mic: 'off', micAllowed: false, camera: 'off', locked: true });
    expect(changes.at(-1)).toMatchObject({ mic: 'off', summary: 'The screen is locked' });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('a confirmed stop cancels the reload', async () => {
    const visible = { value: true };
    const { g, reload } = gate(visible);
    g.setLinkUp(true);
    g.setSnapshot(SNAPSHOT);
    visible.value = false;
    g.checkForeground();
    g.captureStopped();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reload).not.toHaveBeenCalled();
  });

  it('starts closed when the room was closed last time, and when the page is hidden at load', () => {
    expect(gate({ value: true }, true).g.state()).toMatchObject({ open: false, closed: true });
    expect(gate({ value: false }).g.state()).toMatchObject({ unlocked: false, locked: true });
  });

  it('turns the whole thing off when the kill switch closes the room', () => {
    const { g } = gate({ value: true });
    g.setLinkUp(true);
    g.setSnapshot(SNAPSHOT);
    expect(g.setOpen(false)).toMatchObject({ mic: 'off', closed: true, speakers: 'off' });
    expect(g.setOpen(true).mic).toBe('live');
  });
});

describe('WebSatellite pieces that need no hub', () => {
  it('reads the closed switch as closed when storage cannot be read', () => {
    const broken = new WebStore({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    });
    expect(broken.closed()).toBe(true);
    expect(broken.pairing()).toBeNull();
    expect(broken.audio()).toEqual({});
    expect(() => broken.setPairing({ hubUrl: 'ws://x', deviceId: 'd', token: 't', deviceName: 'n', placeId: null, placeName: null })).not.toThrow();
  });

  it('refuses a stored pairing that is incomplete', () => {
    const storage = memoryStorage();
    storage.setItem('aiembodied.web.pairing', JSON.stringify({ hubUrl: 'ws://x', deviceId: 'd' }));
    expect(new WebStore(storage).pairing()).toBeNull();
    storage.setItem('aiembodied.web.pairing', 'not json');
    expect(new WebStore(storage).pairing()).toBeNull();
  });

  it('reads an address with a scheme as it is, and gives a bare name the hub port', () => {
    expect(parseWebHubUrl('https://bija.tail1234.ts.net')).toEqual({ ws: 'wss://bija.tail1234.ts.net', http: 'https://bija.tail1234.ts.net' });
    expect(parseWebHubUrl('http://127.0.0.1:8791/')).toEqual({ ws: 'ws://127.0.0.1:8791', http: 'http://127.0.0.1:8791' });
    expect(parseWebHubUrl('ws://bija:8791')).toEqual({ ws: 'ws://bija:8791', http: 'http://bija:8791' });
    expect(parseWebHubUrl('bija')).toEqual({ ws: 'ws://bija:8791', http: 'http://bija:8791' });
    expect(parseWebHubUrl('ftp://bija')).toBeNull();
    expect(parseWebHubUrl('http://')).toBeNull();
  });

  it('starts unpaired with the page\'s own address suggested for the connect screen, and the web kind', () => {
    const { satellite } = satelliteWith();
    expect(satellite.status()).toMatchObject({ paired: false, link: 'idle', suggestedHubUrl: 'http://127.0.0.1:8791', deviceKind: 'browser', hostname: 'This browser' });
  });

  it('takes a pairing a shell hands over, and uses the page\'s origin as the hub when the shell names none', () => {
    const satellite = new WebSatellite({
      store: new WebStore(memoryStorage()),
      socketFactory: () => ({ isOpen: false, send: () => undefined, close: () => undefined, terminate: () => undefined, detach: () => undefined }),
      shell: { token: 'tok', deviceId: 'room-1', deviceName: 'Pixel' },
      pageOrigin: 'https://appassets.androidplatform.net',
      isVisible: () => true,
      reload: () => undefined,
      deviceName: 'x',
    });
    expect(satellite.status()).toMatchObject({ paired: true, deviceName: 'Pixel', hubUrl: 'wss://appassets.androidplatform.net' });
    satellite.stop();
  });

  it('keeps going when the socket cannot even be made (a bad address) and reports it as a drop', async () => {
    const factory = browserSocketFactory(function () {
      throw new SyntaxError('bad url');
    } as never);
    const events: string[] = [];
    factory('ws://x', { onOpen: () => events.push('open'), onMessage: () => undefined, onClose: () => events.push('close'), onError: (message) => events.push(`error ${message}`) }, { handshakeTimeoutMs: 1 });
    await vi.waitFor(() => expect(events).toEqual(['error bad url', 'close']));
  });
});

describe('the asset URL resolver', () => {
  it('leaves URLs alone until the web satellite installs one', () => {
    expect(resolveAssetUrl('aiembodied-asset://polyhaven/chair/chair.glb')).toBe('aiembodied-asset://polyhaven/chair/chair.glb');
  });

  it('sends asset URLs (and only those) to the hub with the link key, and leaves them alone offline', () => {
    let key: string | null = 'KEY 1';
    setAssetUrlResolver(hubAssetResolver(() => 'http://127.0.0.1:8791', () => key));
    expect(resolveAssetUrl('aiembodied-asset://polyhaven/chair/a b.glb')).toBe('http://127.0.0.1:8791/v1/asset?url=aiembodied-asset%3A%2F%2Fpolyhaven%2Fchair%2Fa%20b.glb&k=KEY%201');
    expect(resolveAssetUrl('blob:abc')).toBe('blob:abc');
    expect(resolveAssetUrl('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==');
    expect(resolveAssetUrl('https://example.com/x')).toBe('https://example.com/x');
    key = null;
    expect(resolveAssetUrl('aiembodied-asset://polyhaven/chair/a.glb')).toBe('aiembodied-asset://polyhaven/chair/a.glb');
  });
});

describe('boot', () => {
  it('does nothing inside the Electron app (a preload bridge is there)', () => {
    const bridge = { config: {} };
    (window as unknown as { aiembodied: unknown }).aiembodied = bridge;
    expect(bootWebSatellite()).toBeNull();
    expect((window as unknown as { aiembodied: unknown }).aiembodied).toBe(bridge);
  });

  it('makes window.aiembodied the web bridge when there is none, and stops the satellite when the page goes away', () => {
    const satellite = bootWebSatellite();
    expect(satellite).not.toBeNull();
    const bridge = (window as unknown as { aiembodied?: { satellite?: unknown; ping(): string } }).aiembodied;
    expect(bridge?.ping()).toBe('pong');
    expect(bridge?.satellite).toBeDefined();
    window.dispatchEvent(new Event('pagehide'));
    satellite?.stop();
  });

  it('reads the shell hook once and knows a page the hub served', () => {
    expect(readShellHook()).toBeNull();
    (window as unknown as { __AIEMBODIED_SHELL__: unknown }).__AIEMBODIED_SHELL__ = { token: 't' };
    expect(readShellHook()).toEqual({ token: 't' });
    expect(pageServedByHub()).toBe(false);
  });
});

describe('connect screen and status panel on the web', () => {
  const status = (overrides: Partial<SatelliteStatus> = {}): SatelliteStatus => ({
    role: 'satellite',
    paired: false,
    hubUrl: null,
    deviceName: null,
    placeId: null,
    placeName: null,
    link: 'idle',
    linkCode: null,
    lastError: null,
    hostname: 'This browser',
    suggestedHubUrl: 'http://127.0.0.1:8791',
    deviceKind: 'browser',
    ...overrides,
  });
  const bridge = { status: vi.fn(), onStatus: vi.fn(), pair: vi.fn(), forget: vi.fn() };

  it('offers the page\'s own address as the hub and talks about a browser', () => {
    render(<ConnectScreen bridge={bridge as never} status={status()} />);
    expect(screen.getByDisplayValue('http://127.0.0.1:8791')).toBeInTheDocument();
    expect(screen.getByText('This browser’s name')).toBeInTheDocument();
  });

  it('keeps ws://bija:8791 as the default in the desktop app', () => {
    render(<ConnectScreen bridge={bridge as never} status={status({ suggestedHubUrl: undefined, deviceKind: undefined, hostname: 'study-pc' })} />);
    expect(screen.getByDisplayValue('ws://bija:8791')).toBeInTheDocument();
  });

  it('says the page enforces the gate itself and has no start-at-login', () => {
    const web = { ...bridge, startAtLogin: vi.fn().mockResolvedValue(false), setStartAtLogin: vi.fn() };
    render(<SatelliteStatusPanel status={status({ paired: true, link: 'online' })} bridge={web as never} />);
    expect(screen.getByText(/This is a web page, so the page itself keeps these rules/)).toBeInTheDocument();
    expect(screen.queryByText('Start when I sign in')).toBeNull();
    expect(screen.getAllByText('This browser').length).toBeGreaterThan(0);
  });
});
