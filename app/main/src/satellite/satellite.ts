/**
 * Satellite mode: the same app on a second desktop, drawing one room of bija's world.
 *
 * `Satellite` is the main-process half. It answers the renderer's IPC calls (see channels.ts for who answers
 * what), keeps the RoomLink to bija, serves room files through the asset protocol with an on-disk cache, and
 * pairs with bija once. Everything that needs Electron is passed in, so the tests run it against a real RoomHub.
 */
import type { LinkState, LinkStatus, RoomLink, RoomLinkOptions, Welcome } from './room-link.js';
import { LOST_TOUCH, RoomLink as RoomLinkClass, parseHubUrl } from './room-link.js';
import { AssetCache } from './asset-cache.js';
import { NOT_ON_SATELLITE, channelKind, channelsOfKind, isDeliverableEvent } from './channels.js';
import type { SatelliteSettings, SatelliteSettingsStore } from './settings.js';
import type { TokenStore } from './token-store.js';
import { ASSET_SCHEME, mimeFor, type ProtocolLike } from '../rooms/asset-protocol.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../config/provider-settings.js';
import type { RendererConfig } from '../config/config-manager.js';
import type { AudioDevicePreferences } from '../config/preferences-store.js';
import type { Op } from '../room-hub/frames.js';
import { INITIAL_FACTS, evaluateGate, type DeviceGateState } from './device-gate.js';
import type { PushToTalkStatus } from '../talk/types.js';

export interface SatelliteStatus {
  role: 'satellite';
  /** This PC has a token for a hub (the "Connect to bija" screen shows when false). */
  paired: boolean;
  hubUrl: string | null;
  deviceName: string | null;
  placeId: string | null;
  placeName: string | null;
  link: LinkState;
  /** Why bija refused this PC (auth, peer, protocol, revoked, replaced). */
  linkCode: string | null;
  /** The last thing that went wrong, in words for Kevin (a failed pairing, a refusal, a keychain problem). */
  lastError: string | null;
  /** This PC's name, offered as the device name on the connect screen. */
  hostname: string;
}

export interface PairInput {
  hubUrl: string;
  code: string;
  placeName?: string;
  deviceName?: string;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface WindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, ...args: unknown[]): void; isDestroyed?(): boolean };
}

/** What the satellite needs from its device runtime (device-runtime.ts); attached after both exist. */
export interface DevicesLike {
  state(): DeviceGateState;
  setLinkUp(up: boolean): void;
  setSnapshot(snapshot: unknown): void;
  hubOff(reason: string): void;
  setOpen(open: boolean): DeviceGateState;
  captureStopped(): void;
}

/** How long one spoken turn took on this PC, measured from the end of speech (milliseconds). */
export interface TurnTiming {
  /** Until the transcript came back from bija. Null for a typed line. */
  transcriptMs: number | null;
  /** Until the first sentence of audio arrived. */
  firstAudioMs: number | null;
  /** Until the first sentence started playing. */
  playbackMs: number | null;
}

export interface SatelliteDeps {
  settings: SatelliteSettingsStore;
  tokens: TokenStore;
  /** `<userData>/cache/assets`. */
  cacheDir: string;
  appVersion: string;
  hostname: string;
  getWindow: () => WindowLike | null;
  quit: () => void;
  logger?: Pick<Console, 'warn' | 'info' | 'debug'>;
  fetchFn?: typeof fetch;
  cacheBytes?: number;
  /** Replaced in tests to speed up the link's timers. */
  linkOptions?: Partial<RoomLinkOptions>;
  makeLink?: (options: RoomLinkOptions) => RoomLink;
  /** Push-to-talk lives in main; the satellite registers the key and reports its state. */
  pushToTalk?: { apply(shortcut: string): PushToTalkStatus; getStatus(): PushToTalkStatus };
  /** How often the ping round trip is logged. */
  pingLogMs?: number;
}

const DEFAULT_KEYWORD = 'Hey Echo';

/** A Uint8Array that is a view into a bigger buffer is copied tight, so the renderer is sent only its own bytes. */
function tighten(value: unknown): unknown {
  if (value instanceof Uint8Array) return value.byteLength === value.buffer.byteLength ? value : value.slice();
  if (Array.isArray(value)) return value.map(tighten);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = tighten(inner);
    return out;
  }
  return value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Satellite {
  private link: RoomLink | null = null;
  private linkStatus: LinkStatus = { state: 'idle' };
  private lastError: string | null = null;
  private welcome: Welcome | null = null;
  private hasToken = false;
  private audioPreferences: AudioDevicePreferences = {};
  private readonly cache: AssetCache;
  private readonly inflight = new Map<string, Promise<{ mime: string; data: Uint8Array } | null>>();
  /** Model id -> fileSha, from the last `avatar-model:list`, so a downloaded body can be cached by what it is. */
  private readonly modelSha = new Map<string, string>();
  private readonly local = new Map<string, (args: unknown[]) => unknown>();
  private starting: Promise<void> = Promise.resolve();
  private devices: DevicesLike | null = null;
  private rttMs: number | null = null;
  private rttTimer: ReturnType<typeof setInterval> | null = null;
  private lastTurn: TurnTiming | null = null;

  constructor(private readonly deps: SatelliteDeps) {
    this.cache = new AssetCache({ dir: deps.cacheDir, maxBytes: deps.cacheBytes });
    const saved = deps.settings.get();
    this.audioPreferences = {
      ...(saved.audioInputDeviceId ? { audioInputDeviceId: saved.audioInputDeviceId } : {}),
      ...(saved.audioOutputDeviceId ? { audioOutputDeviceId: saved.audioOutputDeviceId } : {}),
    };
    this.local.set('app:quit', () => void deps.quit());
    this.local.set('config:get', () => this.config());
    this.local.set('config:set-audio-devices', (args) => {
      const next = (args[0] as AudioDevicePreferences | undefined) ?? {};
      this.audioPreferences = { ...this.audioPreferences, ...next };
      // This PC's own microphone and speakers are kept here, in satellite.json, not on bija.
      if ('audioInputDeviceId' in next || 'audioOutputDeviceId' in next) {
        this.deps.settings.update({
          audioInputDeviceId: this.audioPreferences.audioInputDeviceId || null,
          audioOutputDeviceId: this.audioPreferences.audioOutputDeviceId || null,
        });
      }
      return this.config();
    });
    this.local.set('talk:get-shortcut-status', () => this.deps.pushToTalk?.getStatus() ?? { shortcut: '', registered: false });
    this.local.set('device-gate:get', () => this.deviceState());
    this.local.set('device-gate:capture-stopped', () => this.devices?.captureStopped());
    this.local.set('device-gate:set-open', (args) => (this.devices ? this.devices.setOpen(args[0] === true) : this.deviceState()));
    this.local.set('satellite:turn-timing', (args) => this.noteTurn(args[0]));
    this.local.set('wake-word:list', () => []);
    this.local.set('wake-word:set-listening', () => undefined);
    this.local.set('metrics:observe-latency', () => undefined);
    this.local.set('approvals:list', () => []);
    this.local.set('rooms:making', () => null);
    this.local.set('satellite:status', () => this.status());
    this.local.set('satellite:pair', (args) => this.pair((args[0] ?? {}) as PairInput));
    this.local.set('satellite:forget', () => this.forget());
  }

  // -- Start and stop ---------------------------------------------------------------------------

  /** Registers the IPC channels and the asset protocol, and connects when this PC is already paired. */
  async start(ipcMain: IpcMainLike, protocol: ProtocolLike): Promise<void> {
    for (const channel of [...channelsOfKind('forward'), ...channelsOfKind('local'), ...channelsOfKind('unavailable')]) {
      // `diagnostics:preload-log` is a one-way message main.ts already listens for.
      if (channel === 'diagnostics:preload-log') continue;
      ipcMain.handle(channel, (_event, ...args) => this.invoke(channel, args));
    }
    protocol.handle(ASSET_SCHEME, (request) => this.serveAsset(request.url));
    const talkKey = this.deps.settings.get().pushToTalk;
    if (talkKey) this.deps.pushToTalk?.apply(talkKey);
    await this.connect();
  }

  /** Opens the link if there is a hub and a token. */
  async connect(): Promise<void> {
    this.starting = this.starting.then(() => this.doConnect());
    await this.starting;
  }

  private async doConnect(): Promise<void> {
    this.link?.stop();
    this.link = null;
    this.linkDown();
    const { hubUrl, deviceId } = this.deps.settings.get();
    if (!hubUrl || !deviceId) {
      this.hasToken = false;
      this.linkStatus = { state: 'idle' };
      this.pushStatus();
      return;
    }
    const token = await this.deps.tokens.get(hubUrl);
    this.hasToken = Boolean(token);
    if (!token) {
      this.linkStatus = { state: 'idle' };
      this.lastError = 'This PC has no key for bija any more. Connect again with a new code.';
      this.pushStatus();
      return;
    }
    const options: RoomLinkOptions = {
      url: hubUrl,
      deviceId,
      token,
      appVersion: this.deps.appVersion,
      logger: this.deps.logger,
      onIpc: (channel, args) => this.deliver(channel, args),
      onStatus: (status) => this.onLinkStatus(status),
      onWelcome: (welcome) => this.onWelcome(welcome),
      onDeviceOff: (reason) => this.devices?.hubOff(reason),
      onPong: (rttMs) => {
        this.rttMs = rttMs;
      },
      ...this.deps.linkOptions,
    };
    const link = this.deps.makeLink ? this.deps.makeLink(options) : new RoomLinkClass(options);
    this.link = link;
    this.lastError = null;
    link.start();
    this.pushStatus();
  }

  stop(): void {
    this.link?.stop();
    this.link = null;
    this.linkDown();
  }

  // -- Devices ----------------------------------------------------------------------------------

  /** The device runtime (the privacy gate) listens to the link and the places snapshot, and answers `device-gate:*`. */
  attachDevices(devices: DevicesLike): void {
    this.devices = devices;
  }

  /** The gate as it is now. Before the runtime is attached nothing is allowed. */
  deviceState(): DeviceGateState {
    return this.devices?.state() ?? evaluateGate(INITIAL_FACTS);
  }

  /** Sends an op to bija (`device.state`, `room.close`, ...). False when the link is down. */
  sendOp(op: Op): boolean {
    return this.link?.send(op) ?? false;
  }

  /** The last spoken turn's timings, as the renderer measured them. Logged here, so they are in the main log. */
  private noteTurn(value: unknown): void {
    const timing = (value ?? {}) as Partial<TurnTiming>;
    const number = (input: unknown): number | null => (typeof input === 'number' && Number.isFinite(input) ? Math.round(input) : null);
    this.lastTurn = { transcriptMs: number(timing.transcriptMs), firstAudioMs: number(timing.firstAudioMs), playbackMs: number(timing.playbackMs) };
    this.deps.logger?.info('Satellite turn timing (ms from end of speech)', { ...this.lastTurn });
  }

  /** An avatar's name as bija's welcome gave it, else its id. */
  avatarName(avatarId: string): string {
    const found = (this.welcome?.avatars ?? []).find((avatar) => (avatar as { id?: unknown } | null)?.id === avatarId) as { name?: unknown } | undefined;
    return typeof found?.name === 'string' && found.name ? found.name : avatarId;
  }

  lastTurnTiming(): TurnTiming | null {
    return this.lastTurn ? { ...this.lastTurn } : null;
  }

  /** The link is gone: devices off, and the ping log stops. */
  private linkDown(): void {
    if (this.rttTimer) clearInterval(this.rttTimer);
    this.rttTimer = null;
    this.rttMs = null;
    this.devices?.setLinkUp(false);
  }

  private linkUp(): void {
    this.devices?.setLinkUp(true);
    if (this.rttTimer) return;
    this.rttTimer = setInterval(() => {
      this.deps.logger?.info('Room link ping round trip', { rttMs: this.rttMs });
    }, this.deps.pingLogMs ?? 30_000);
    this.rttTimer.unref?.();
  }

  // -- Status -----------------------------------------------------------------------------------

  status(): SatelliteStatus {
    const settings = this.deps.settings.get();
    const refused = this.linkStatus.state === 'refused';
    return {
      role: 'satellite',
      paired: Boolean(settings.hubUrl && settings.deviceId && this.hasToken),
      hubUrl: settings.hubUrl,
      deviceName: settings.deviceName,
      placeId: this.welcome?.placeId ?? settings.placeId,
      placeName: this.welcome?.place?.name ?? settings.placeName,
      link: this.linkStatus.state,
      linkCode: refused ? (this.linkStatus.code ?? null) : null,
      lastError: this.lastError ?? this.deps.tokens.lastError,
      hostname: this.deps.hostname,
    };
  }

  private pushStatus(): void {
    this.sendToWindow('satellite:status', this.status());
  }

  private onLinkStatus(status: LinkStatus): void {
    this.linkStatus = status;
    if (status.state === 'online') this.linkUp();
    else this.linkDown();
    if (status.state === 'online') this.lastError = null;
    if (status.state === 'refused') this.lastError = status.message ?? 'bija refused this PC.';
    this.pushStatus();
  }

  private onWelcome(welcome: Welcome): void {
    this.welcome = welcome;
    const settings = this.deps.settings.get();
    if (settings.placeId !== welcome.placeId || settings.placeName !== welcome.place?.name) {
      this.deps.settings.update({ placeId: welcome.placeId, placeName: welcome.place?.name ?? settings.placeName });
    }
    // The renderer follows the snapshot: after a reconnect it must see the world as it is now.
    this.devices?.setSnapshot(welcome.snapshot);
    // Without a key of its own, this PC uses the push-to-talk key bija has.
    const bijaKey = (welcome.settings?.pushToTalk as { shortcut?: unknown } | null | undefined)?.shortcut;
    if (!settings.pushToTalk && typeof bijaKey === 'string' && bijaKey && this.deps.pushToTalk?.getStatus().shortcut !== bijaKey) this.deps.pushToTalk?.apply(bijaKey);
    this.sendToWindow('places:changed', welcome.snapshot);
    this.pushStatus();
  }

  private sendToWindow(channel: string, ...args: unknown[]): void {
    const window = this.deps.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed?.()) return;
    window.webContents.send(channel, ...args);
  }

  /** An event from bija for the renderer. Only the channels the renderer listens for get through. */
  private deliver(channel: string, args: unknown[]): void {
    if (!isDeliverableEvent(channel)) {
      this.deps.logger?.debug('Satellite: dropped an event from bija', { channel });
      return;
    }
    // Who is in this room decides whether the mic may be on.
    if (channel === 'places:changed') this.devices?.setSnapshot(args[0]);
    this.sendToWindow(channel, ...args);
  }

  /** The config the renderer asks for: no keys, no services, just enough for it to know what it is. */
  private config(): RendererConfig {
    const keyword = (this.welcome?.settings?.wakeWord as { keywordLabel?: unknown } | null | undefined)?.keywordLabel;
    const config = {
      role: 'satellite',
      conversationBackend: 'local',
      providers: structuredClone(DEFAULT_PROVIDER_SETTINGS),
      hasRealtimeApiKey: false,
      featureFlags: {},
      wakeWord: { model: 'hey_echo', keywordLabel: typeof keyword === 'string' && keyword ? keyword : DEFAULT_KEYWORD, threshold: 0.5, cooldownMs: 1500 },
      metrics: { enabled: false, host: '127.0.0.1', port: 9464, path: '/metrics' },
      ...this.audioPreferences,
    };
    // The pieces the renderer reads are all here; the rest of RendererConfig is optional for it.
    return config as unknown as RendererConfig;
  }

  // -- IPC --------------------------------------------------------------------------------------

  /** What a satellite does with one IPC channel (channels.ts). */
  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const kind = channelKind(channel);
    if (kind === 'local') {
      const handler = this.local.get(channel);
      if (!handler) throw new Error(NOT_ON_SATELLITE);
      return handler(args);
    }
    if (kind !== 'forward') throw new Error(NOT_ON_SATELLITE);
    if (channel === 'avatar-model:load') return this.loadModel(args);
    const value = await this.callBija(channel, args);
    if (channel === 'avatar-model:list') this.rememberModels(value);
    return tighten(value);
  }

  /** A read-only call to bija made by this PC's main process itself (not for the page), for example `wake-word:model`. */
  callHub(channel: string, args: unknown[] = []): Promise<unknown> {
    return this.callBija(channel, args);
  }

  private callBija(channel: string, args: unknown[]): Promise<unknown> {
    if (!this.link) return Promise.reject(new Error(LOST_TOUCH));
    return this.link.call(channel, args);
  }

  // -- Avatar bodies ----------------------------------------------------------------------------

  private rememberModels(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const { id, fileSha } = (item ?? {}) as { id?: unknown; fileSha?: unknown };
      if (typeof id === 'string' && typeof fileSha === 'string' && fileSha) {
        if (this.modelSha.get(id) !== fileSha) void this.cache.put(`model-sha:${id}`, 'text/plain', new TextEncoder().encode(fileSha));
        this.modelSha.set(id, fileSha);
      }
    }
  }

  /** A VRM body: from the cache when this PC already has that exact file, else fetched from bija and kept. */
  private async loadModel(args: unknown[]): Promise<unknown> {
    const modelId = typeof args[0] === 'string' ? args[0] : '';
    let sha = this.modelSha.get(modelId);
    if (!sha && modelId) {
      // With the link up, ask bija what the file is now; offline, use what was learned last time.
      if (this.linkStatus.state === 'online') {
        try {
          this.rememberModels(await this.callBija('avatar-model:list', []));
        } catch {
          // Fall back to the saved note below.
        }
      }
      sha = this.modelSha.get(modelId);
      if (!sha) {
        const noted = await this.cache.get(`model-sha:${modelId}`);
        if (noted) sha = new TextDecoder().decode(noted.data);
      }
    }
    const key = sha ? `model:${modelId}:${sha}` : null;
    if (key) {
      const hit = await this.cache.get(key);
      if (hit) return tighten(hit.data);
    }
    const value = await this.callBija('avatar-model:load', args);
    if (key && value instanceof Uint8Array) void this.cache.put(key, 'model/vrm', value);
    return tighten(value);
  }

  // -- Room files -------------------------------------------------------------------------------

  /** The renderer asked for `aiembodied-asset://...`: from the disk cache, else from bija (and kept). */
  async serveAsset(url: string): Promise<Response> {
    if (!url.startsWith(`${ASSET_SCHEME}:`)) return new Response('Not found', { status: 404 });
    const found = await this.fetchAsset(url);
    if (!found) return new Response('Not found', { status: 404 });
    return new Response(found.data as BodyInit, {
      status: 200,
      headers: { 'Content-Type': found.mime || mimeFor(url), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' },
    });
  }

  private fetchAsset(url: string): Promise<{ mime: string; data: Uint8Array } | null> {
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const work = (async () => {
      const cached = await this.cache.get(url);
      if (cached) return cached;
      if (!this.link || this.linkStatus.state !== 'online') return null;
      try {
        const fetched = await this.link.getAsset(url);
        void this.cache.put(url, fetched.mime, fetched.data);
        return fetched;
      } catch (error) {
        this.deps.logger?.warn('Satellite: could not fetch a room file', { url, message: describeError(error) });
        return null;
      }
    })().finally(() => this.inflight.delete(url));
    this.inflight.set(url, work);
    return work;
  }

  /** Waits for cache writes started so far (tests). */
  async cacheIdle(): Promise<void> {
    await this.cache.idle();
  }

  // -- Pairing ----------------------------------------------------------------------------------

  /** Pairs with bija using the 6-digit code, keeps the token in the keychain and the rest in satellite.json, then connects. */
  async pair(input: PairInput): Promise<SatelliteStatus> {
    const hub = parseHubUrl(String(input.hubUrl ?? ''));
    if (!hub) throw new Error('That is not a hub address. Try something like ws://bija:8791.');
    const code = String(input.code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) throw new Error('The code is 6 digits.');
    const deviceName = (input.deviceName ?? '').trim().slice(0, 60) || this.deps.hostname;
    const placeName = (input.placeName ?? '').trim().slice(0, 60) || 'the study';
    let response: Response;
    try {
      response = await (this.deps.fetchFn ?? fetch)(`${hub.http}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName, placeName }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new Error(`Could not reach bija at ${hub.http.replace(/^https?:\/\//, '')}: ${describeError(error)}`);
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'That code is wrong or has expired. Make a new one on bija (Settings, Places, Add a desktop room).',
        403: 'bija does not trust this PC. It must be on the same Tailscale network and account.',
        409: 'bija already has the most desktop rooms it allows.',
        429: 'Too many wrong codes. Wait a minute and try again.',
      };
      throw new Error(messages[response.status] ?? `bija answered ${response.status}.`);
    }
    const body = (await response.json().catch(() => null)) as { deviceId?: unknown; token?: unknown; placeId?: unknown } | null;
    if (!body || typeof body.deviceId !== 'string' || typeof body.token !== 'string' || typeof body.placeId !== 'string') {
      throw new Error('bija sent an answer this app does not understand.');
    }
    const previous = this.deps.settings.get().hubUrl;
    if (previous && previous !== hub.ws) await this.deps.tokens.delete(previous);
    await this.deps.tokens.set(hub.ws, body.token);
    this.welcome = null;
    this.deps.settings.update({ hubUrl: hub.ws, deviceId: body.deviceId, deviceName, placeId: body.placeId, placeName });
    await this.connect();
    return this.status();
  }

  /** Forgets bija on this PC (bija keeps the room until Revoke is pressed there). */
  async forget(): Promise<SatelliteStatus> {
    const { hubUrl } = this.deps.settings.get();
    this.link?.stop();
    this.link = null;
    if (hubUrl) await this.deps.tokens.delete(hubUrl);
    this.deps.settings.clearPairing();
    this.welcome = null;
    this.hasToken = false;
    this.linkStatus = { state: 'idle' };
    this.lastError = null;
    this.linkDown();
    this.pushStatus();
    return this.status();
  }

  /** The settings as stored (the window helper reads its bounds from here). */
  settings(): SatelliteSettings {
    return this.deps.settings.get();
  }
}
