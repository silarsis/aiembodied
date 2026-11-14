import { RoomLinkCore, type RoomLinkOptions, type SocketFactory } from '../../../main/src/satellite/link-core.js';
import { LOST_TOUCH, parseHubUrl, type LinkStatus, type Welcome } from '../../../main/src/satellite/link-shared.js';
import { NOT_ON_SATELLITE, channelKind, isDeliverableEvent } from '../../../main/src/satellite/channels.js';
import { EMPTY_LOCAL_ANSWERS, keywordOf, satelliteConfig } from '../../../main/src/satellite/local-config.js';
import { requestPairing } from '../../../main/src/satellite/pairing.js';
import type { DeviceGateState } from '../../../main/src/satellite/device-gate.js';
import type { SatelliteStatus } from '../../../main/src/satellite/satellite.js';
import type { AudioDevicePreferences } from '../../../main/src/config/preferences-store.js';
import type { RendererConfig } from '../../../main/src/config/config-manager.js';
import type { Op } from '../../../main/src/room-hub/frames.js';
import { createBridge, type BridgeTransport, type PreloadApi } from '../../../main/src/bridge/create-bridge.js';
import { WebGate } from './web-gate.js';
import { WebStore } from './web-store.js';
import type { ShellHook } from './shell-hook.js';

export interface WebSatelliteDeps {
  store: WebStore;
  socketFactory: SocketFactory;
  /** `fetch` for the pair call. */
  fetchFn?: typeof fetch;
  shell?: ShellHook | null;
  /** The page's own address (`location.origin`), or null when it is not served by a hub (the Vite dev server, a test). */
  pageOrigin: string | null;
  /** Whether the page is visible. */
  isVisible: () => boolean;
  /** Reloads the page (the gate's last resort). */
  reload: () => void;
  deviceName: string;
  logger?: Pick<Console, 'warn' | 'info' | 'debug'>;
  linkOptions?: Partial<RoomLinkOptions>;
  captureTimeoutMs?: number;
}

type Listener = (...args: unknown[]) => void;

/**
 * Reads a hub address for the web. One with a scheme (`https://bija.tail1234.ts.net`, `http://127.0.0.1:8791`) is
 * taken as it is, so `tailscale serve` on port 443 works; a bare name (`bija`, `bija:8791`) gets the hub's port
 * 8791, as on the desktop.
 */
export function parseWebHubUrl(input: string): { ws: string; http: string } | null {
  const trimmed = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return parseHubUrl(trimmed);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') return null;
  if (!url.hostname) return null;
  return { ws: `${secure ? 'wss' : 'ws'}://${url.host}`, http: `${secure ? 'https' : 'http'}://${url.host}` };
}

/**
 * The web satellite: a page that draws one room of bija's world, in a browser or in the Android shell's WebView.
 * The counterpart of the Electron `Satellite` (main/src/satellite/satellite.ts): the page's IPC calls go to
 * `invoke`, classified by the same channel table; the link is the same `RoomLinkCore`; the gate is the same logic.
 * `bridge` is `window.aiembodied`, built by the same `createBridge` the Electron preload uses.
 */
export class WebSatellite {
  readonly bridge: PreloadApi;
  private readonly store: WebStore;
  private readonly gate: WebGate;
  private link: RoomLinkCore | null = null;
  private linkStatus: LinkStatus = { state: 'idle' };
  private welcome: Welcome | null = null;
  private lastError: string | null = null;
  private audio: AudioDevicePreferences;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly local = new Map<string, (args: unknown[]) => unknown>();
  private pairing: { hubUrl: string; deviceId: string; token: string; deviceName: string; placeId: string | null; placeName: string | null } | null;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: WebSatelliteDeps) {
    this.store = deps.store;
    this.audio = this.store.audio();
    // A shell that holds a pairing hands it over; otherwise the page's own stored pairing, if any.
    const shell = deps.shell;
    this.pairing =
      shell?.token && shell.deviceId && (shell.hubUrl || deps.pageOrigin)
        ? {
            hubUrl: parseWebHubUrl(shell.hubUrl ?? deps.pageOrigin ?? '')?.ws ?? '',
            deviceId: shell.deviceId,
            token: shell.token,
            deviceName: shell.deviceName ?? deps.deviceName,
            placeId: null,
            placeName: null,
          }
        : this.store.pairing();
    if (this.pairing && !this.pairing.hubUrl) this.pairing = null;

    this.gate = new WebGate({
      isForeground: () => deps.isVisible() && this.shellForeground(),
      closed: this.store.closed(),
      onChange: (state) => this.onGate(state),
      reload: deps.reload,
      captureTimeoutMs: deps.captureTimeoutMs,
      logger: deps.logger,
    });

    this.registerLocal();
    this.bridge = createBridge(this.transport(), { logError: (message, meta) => deps.logger?.warn(message, meta) });
    if (typeof shell?.onForeground === 'function') {
      const off = shell.onForeground(() => this.gate.checkForeground());
      if (typeof off === 'function') this.offs.push(off);
    }
  }

  private shellForeground(): boolean {
    const foreground = this.deps.shell?.foreground;
    if (typeof foreground === 'function') {
      try {
        return foreground() !== false;
      } catch {
        return false;
      }
    }
    return foreground !== false;
  }

  // -- Start and stop ---------------------------------------------------------------------------

  /** Connects when the page is already paired. */
  start(): void {
    this.connect();
  }

  /** The page was shown or hidden (call from `visibilitychange`). */
  visibilityChanged(): void {
    this.gate.checkForeground();
  }

  stop(): void {
    this.link?.stop();
    this.link = null;
    this.gate.setLinkUp(false);
    this.gate.dispose();
    for (const off of this.offs.splice(0)) off();
  }

  private connect(): void {
    this.link?.stop();
    this.link = null;
    this.gate.setLinkUp(false);
    const pairing = this.pairing;
    if (!pairing) {
      this.linkStatus = { state: 'idle' };
      this.pushStatus();
      return;
    }
    const link = new RoomLinkCore(
      {
        url: pairing.hubUrl,
        deviceId: pairing.deviceId,
        token: pairing.token,
        appVersion: 'web',
        logger: this.deps.logger,
        onIpc: (channel, args) => this.deliver(channel, args),
        onStatus: (status) => this.onLinkStatus(status),
        onWelcome: (welcome) => this.onWelcome(welcome),
        onDeviceOff: () => this.gate.hubOff(),
        ...this.deps.linkOptions,
      },
      this.deps.socketFactory,
    );
    this.link = link;
    this.lastError = null;
    link.start();
    this.pushStatus();
  }

  // -- Events -----------------------------------------------------------------------------------

  private transport(): BridgeTransport {
    return {
      invoke: (channel, ...args) => this.invoke(channel, args),
      on: (channel, listener) => {
        const set = this.listeners.get(channel) ?? new Set<Listener>();
        set.add(listener);
        this.listeners.set(channel, set);
        return () => void set.delete(listener);
      },
    };
  }

  private emit(channel: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      try {
        listener(...args);
      } catch (error) {
        this.deps.logger?.warn('A listener failed', { channel, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** An event from bija for the page. Only the channels the page listens for get through. */
  private deliver(channel: string, args: unknown[]): void {
    if (!isDeliverableEvent(channel)) {
      this.deps.logger?.debug('Web satellite: dropped an event from bija', { channel });
      return;
    }
    if (channel === 'places:changed') this.gate.setSnapshot(args[0]);
    this.emit(channel, ...args);
  }

  private onLinkStatus(status: LinkStatus): void {
    this.linkStatus = status;
    this.gate.setLinkUp(status.state === 'online');
    if (status.state === 'online') this.lastError = null;
    if (status.state === 'refused') this.lastError = status.message ?? 'bija refused this browser.';
    this.pushStatus();
  }

  private onWelcome(welcome: Welcome): void {
    this.welcome = welcome;
    const pairing = this.pairing;
    if (pairing && (pairing.placeId !== welcome.placeId || pairing.placeName !== (welcome.place?.name ?? pairing.placeName))) {
      this.pairing = { ...pairing, placeId: welcome.placeId, placeName: welcome.place?.name ?? pairing.placeName };
      if (!this.deps.shell?.token) this.store.setPairing(this.pairing);
    }
    // The page follows the snapshot: after a reconnect it must see the world as it is now.
    this.gate.setSnapshot(welcome.snapshot);
    this.emit('places:changed', welcome.snapshot);
    this.pushStatus();
  }

  // -- The gate ---------------------------------------------------------------------------------

  private onGate(state: DeviceGateState): void {
    this.emit('device-gate:changed', state);
    this.sendState(state);
    try {
      this.deps.shell?.onGate?.(state);
    } catch (error) {
      this.deps.logger?.warn('The shell failed to follow the gate', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private sendState(state: DeviceGateState): void {
    this.link?.send({
      op: 'device.state',
      mic: state.mic,
      camera: state.camera,
      speakers: state.speakers,
      locked: state.locked,
      closed: state.closed,
      fullscreen: state.fullscreen,
    });
  }

  /** The kill switch ("Close this room"). Closing sends the avatars home; the choice survives a reload. */
  private setOpen(open: boolean): DeviceGateState {
    this.store.setClosed(!open);
    this.link?.send({ op: open ? 'room.open' : 'room.close' });
    return this.gate.setOpen(open);
  }

  // -- Status -----------------------------------------------------------------------------------

  status(): SatelliteStatus {
    const refused = this.linkStatus.state === 'refused';
    return {
      role: 'satellite',
      paired: this.pairing !== null,
      hubUrl: this.pairing?.hubUrl ?? null,
      deviceName: this.pairing?.deviceName ?? null,
      placeId: this.welcome?.placeId ?? this.pairing?.placeId ?? null,
      placeName: this.welcome?.place?.name ?? this.pairing?.placeName ?? null,
      link: this.linkStatus.state,
      linkCode: refused ? (this.linkStatus.code ?? null) : null,
      lastError: this.lastError,
      hostname: this.deps.deviceName,
      suggestedHubUrl: this.deps.shell?.hubUrl ?? this.deps.pageOrigin,
      deviceKind: 'browser',
    };
  }

  private pushStatus(): void {
    this.emit('satellite:status', this.status());
  }

  // -- IPC --------------------------------------------------------------------------------------

  private registerLocal(): void {
    const local = this.local;
    local.set('app:quit', () => undefined);
    local.set('diagnostics:preload-log', () => undefined);
    local.set('config:get', () => this.config());
    local.set('config:set-audio-devices', (args) => {
      const next = (args[0] as AudioDevicePreferences | undefined) ?? {};
      this.audio = { ...this.audio, ...next };
      if ('audioInputDeviceId' in next || 'audioOutputDeviceId' in next) this.store.setAudio(this.audio);
      return this.config();
    });
    // No global key in a browser; the page has its own talk button.
    local.set('talk:get-shortcut-status', () => ({ shortcut: '', registered: false }));
    for (const [channel, answer] of Object.entries(EMPTY_LOCAL_ANSWERS)) local.set(channel, answer);
    local.set('satellite:status', () => this.status());
    local.set('satellite:pair', (args) => this.pair((args[0] ?? {}) as { hubUrl: string; code: string; placeName?: string; deviceName?: string }));
    local.set('satellite:forget', () => this.forget());
    // Nothing to start at login in a page.
    local.set('satellite:start-at-login', () => false);
    local.set('device-gate:get', () => this.gate.state());
    local.set('device-gate:capture-stopped', () => this.gate.captureStopped());
    local.set('device-gate:set-open', (args) => this.setOpen(args[0] === true));
    local.set('satellite:turn-timing', () => undefined);
  }

  private config(): RendererConfig {
    return satelliteConfig({ keyword: keywordOf(this.welcome?.settings?.wakeWord), audioPreferences: this.audio, kind: 'browser' });
  }

  /** What the page does with one IPC channel (the same table as the Electron satellite). */
  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const kind = channelKind(channel);
    if (kind === 'local') {
      const handler = this.local.get(channel);
      if (!handler) throw new Error(NOT_ON_SATELLITE);
      return handler(args);
    }
    if (kind !== 'forward') throw new Error(NOT_ON_SATELLITE);
    if (!this.link) throw new Error(LOST_TOUCH);
    return this.link.call(channel, args);
  }

  /** Sends an op to bija (`presence`, `wake.heard`, ...). False when the link is down. */
  sendOp(op: Op): boolean {
    return this.link?.send(op) ?? false;
  }

  /** The key for `GET /v1/asset?k=` from the current welcome (null while offline). */
  assetKey(): string | null {
    return this.linkStatus.state === 'online' ? (this.welcome?.assetKey ?? null) : null;
  }

  /** Where `/v1/asset` is fetched from: the page's own origin (the hub served it, or the shell proxies it), else the hub's HTTP address. */
  assetBase(): string {
    return this.deps.pageOrigin ?? parseWebHubUrl(this.pairing?.hubUrl ?? '')?.http ?? '';
  }

  // -- Pairing ----------------------------------------------------------------------------------

  async pair(input: { hubUrl: string; code: string; placeName?: string; deviceName?: string }): Promise<SatelliteStatus> {
    const paired = await requestPairing({ ...input, parseHub: parseWebHubUrl, defaultDeviceName: this.deps.deviceName, fetchFn: this.deps.fetchFn, kind: this.deps.shell?.kind ?? 'browser' });
    this.pairing = {
      hubUrl: paired.hub.ws,
      deviceId: paired.body.deviceId,
      token: paired.body.token,
      deviceName: paired.deviceName,
      placeId: paired.body.placeId,
      placeName: paired.placeName,
    };
    this.welcome = null;
    this.store.setPairing(this.pairing);
    this.connect();
    return this.status();
  }

  /** Forgets bija in this page (bija keeps the room until Revoke is pressed there). */
  forget(): SatelliteStatus {
    this.link?.stop();
    this.link = null;
    this.store.clearPairing();
    this.pairing = null;
    this.welcome = null;
    this.linkStatus = { state: 'idle' };
    this.lastError = null;
    this.gate.setLinkUp(false);
    this.pushStatus();
    return this.status();
  }
}
