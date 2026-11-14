/**
 * Wires the privacy gate (device-gate.ts) to the system on a satellite PC: the lock screen, the full-screen
 * check, the kill switch (tray menu and a global shortcut), the media permission handlers, the tray icon, one
 * Windows notification, the page, and the link to bija. Everything Electron-specific is passed in, so the tests
 * run it with fakes.
 */
import type { Op } from '../room-hub/frames.js';
import { DeviceGate, avatarsHere, guardMediaPermissions, type DeviceGateState, type PermissionSession } from './device-gate.js';
import type { FullscreenWatcher } from './fullscreen-watch.js';
import { stateIcon, trayRoomName, trayTooltip, type IconBitmap } from './tray-state.js';
import type { SatelliteSettings } from './settings.js';
import { cameraPresenceOn } from '../places/camera-setting.js';
import { doorbellOn } from '../places/doorbell-setting.js';

export const DEFAULT_CLOSE_SHORTCUT = 'Ctrl+Alt+Shift+R';

export interface MenuItemLike {
  label?: string;
  type?: 'separator';
  enabled?: boolean;
  click?: () => void;
}

export interface TrayLike {
  setToolTip(text: string): void;
  setImage(image: unknown): void;
  setContextMenu(menu: unknown): void;
  destroy?(): void;
}

export interface DeviceWindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, ...args: unknown[]): void; reload(): void; isDestroyed?(): boolean };
}

export interface DeviceRuntimeDeps {
  settings: { get(): SatelliteSettings; update(patch: Partial<SatelliteSettings>): SatelliteSettings };
  powerMonitor: { on(event: 'lock-screen' | 'unlock-screen', listener: () => void): unknown; removeListener(event: 'lock-screen' | 'unlock-screen', listener: () => void): unknown };
  globalShortcut: { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void };
  session: PermissionSession;
  getWindow: () => DeviceWindowLike | null;
  /** Sends an op to bija. False when the link is down. */
  sendOp: (op: Op) => boolean;
  tray: TrayLike | null;
  makeImage: (icon: IconBitmap) => unknown;
  makeMenu: (template: MenuItemLike[]) => unknown;
  /** Makes the full-screen watcher; `onChange(true)` means no other app is full screen. */
  makeWatcher: (onChange: (noFullscreenApp: boolean) => void) => Pick<FullscreenWatcher, 'start' | 'stop'>;
  notify: (title: string, body: string) => void;
  placeName: () => string | null;
  avatarName: (avatarId: string) => string;
  showWindow: () => void;
  quit: () => void;
  /** Told after every change of the gate (the wake word worker follows it). Called last, after the page, bija and the tray know. */
  onGate?: (state: DeviceGateState) => void;
  captureTimeoutMs?: number;
  logger?: Pick<Console, 'warn' | 'info' | 'debug'>;
}

/** This room's camera setting from a places snapshot. A snapshot that cannot be read gives off (fail closed). */
function cameraSettingHere(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const { places, localPlaceId } = snapshot as { places?: unknown; localPlaceId?: unknown };
  if (!Array.isArray(places) || typeof localPlaceId !== 'string') return false;
  const here = places.find((place) => (place as { id?: unknown } | null)?.id === localPlaceId) as { node?: unknown; camera?: unknown } | undefined;
  if (!here || typeof here.node !== 'string') return false;
  return cameraPresenceOn({ node: here.node, camera: typeof here.camera === 'boolean' ? here.camera : undefined });
}

/**
 * This room's doorbell setting from a places snapshot. A snapshot that cannot be read gives off (fail closed).
 * The setting lives on bija (Settings > Places); satellite.json no longer decides it.
 */
function doorbellSettingHere(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const { places, localPlaceId } = snapshot as { places?: unknown; localPlaceId?: unknown };
  if (!Array.isArray(places) || typeof localPlaceId !== 'string') return false;
  const here = places.find((place) => (place as { id?: unknown } | null)?.id === localPlaceId) as { node?: unknown; doorbell?: unknown } | undefined;
  if (!here || typeof here.node !== 'string') return false;
  return doorbellOn({ node: here.node, doorbell: typeof here.doorbell === 'boolean' ? here.doorbell : undefined });
}

export class DeviceRuntime {
  readonly gate: DeviceGate;
  private readonly watcher: Pick<FullscreenWatcher, 'start' | 'stop'>;
  private readonly onLock = () => void this.gate.update({ unlocked: false });
  private readonly onUnlock = () => void this.gate.update({ unlocked: true });
  private shortcut: string | null = null;
  private announced = false;
  private present: string[] = [];
  private started = false;

  constructor(private readonly deps: DeviceRuntimeDeps) {
    const settings = deps.settings.get();
    this.gate = new DeviceGate({
      facts: { open: !settings.closed },
      // Off until bija's snapshot says otherwise: the doorbell is a setting of the place, kept on bija.
      doorbellEnabled: false,
      captureTimeoutMs: deps.captureTimeoutMs,
      reloadRenderer: () => this.reloadPage(),
      onChange: (state, changed) => this.onChange(state, changed),
      logger: deps.logger,
    });
    this.watcher = deps.makeWatcher((noFullscreenApp) => void this.gate.update({ noFullscreenApp }));
  }

  state(): DeviceGateState {
    return this.gate.state();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    guardMediaPermissions(this.deps.session, this.gate);
    this.deps.powerMonitor.on('lock-screen', this.onLock);
    this.deps.powerMonitor.on('unlock-screen', this.onUnlock);
    this.registerShortcut();
    this.watcher.start();
    this.refreshTray(this.gate.state());
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.powerMonitor.removeListener('lock-screen', this.onLock);
    this.deps.powerMonitor.removeListener('unlock-screen', this.onUnlock);
    if (this.shortcut) this.deps.globalShortcut.unregister(this.shortcut);
    this.shortcut = null;
    this.watcher.stop();
    this.gate.dispose();
    this.deps.tray?.destroy?.();
  }

  // -- Facts that come from the link ---------------------------------------------------------------

  /** A new link state. A fresh connection also clears a hold bija put on the devices. */
  setLinkUp(up: boolean): void {
    this.gate.update({ linkUp: up, ...(up ? { notHeldOff: true } : {}) });
    // After a reconnect bija needs the state even when no fact changed.
    if (up) this.sendState(this.gate.state());
  }

  /** A places snapshot: who stands in this room, whether this room's camera presence is on and whether its doorbell is. */
  setSnapshot(snapshot: unknown): void {
    this.present = avatarsHere(snapshot);
    this.gate.update({ occupied: this.present.length > 0, cameraEnabled: cameraSettingHere(snapshot) });
    // After the occupancy: the doorbell level is only ever read against the room as it is now.
    this.gate.setDoorbellEnabled(doorbellSettingHere(snapshot));
  }

  /** bija asked the devices off. It can never turn them on. */
  hubOff(reason: string): void {
    this.deps.logger?.info('bija asked this PC\'s devices off', { reason });
    this.gate.update({ notHeldOff: false });
  }

  // -- The kill switch -----------------------------------------------------------------------------

  /** Kevin closes or opens the room from the tray, the shortcut or the Status panel. Closing sends the avatars home. */
  setOpen(open: boolean): DeviceGateState {
    this.deps.settings.update({ closed: !open });
    this.deps.sendOp({ op: open ? 'room.open' : 'room.close' });
    this.deps.logger?.info(open ? 'The room was opened' : 'The room was closed');
    // Opening it by hand also lifts a hold bija put on the devices.
    return this.gate.update({ open, ...(open ? { notHeldOff: true } : {}) });
  }

  toggleOpen(): DeviceGateState {
    return this.setOpen(!this.gate.state().open);
  }

  /** The page reports that every capture track has stopped. */
  captureStopped(): void {
    this.gate.captureStopped();
  }

  private registerShortcut(): void {
    const accelerator = this.deps.settings.get().closeShortcut || DEFAULT_CLOSE_SHORTCUT;
    try {
      if (this.deps.globalShortcut.register(accelerator, () => void this.toggleOpen())) this.shortcut = accelerator;
      else this.deps.logger?.warn('The close-room shortcut is taken by another app', { accelerator });
    } catch (error) {
      this.deps.logger?.warn('The close-room shortcut is not valid', { accelerator, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // -- Reacting to a change -------------------------------------------------------------------------

  private onChange(state: DeviceGateState, changed: string[]): void {
    this.deps.logger?.info('Devices changed', { mic: state.mic, camera: state.camera, changed, summary: state.summary });
    this.sendToPage(state);
    this.sendState(state);
    this.refreshTray(state);
    try {
      this.deps.onGate?.(state);
    } catch (error) {
      this.deps.logger?.warn('A gate listener failed', { message: error instanceof Error ? error.message : String(error) });
    }
    if (state.micAllowed && !this.announced) {
      this.announced = true;
      const who = this.present[0] ? this.deps.avatarName(this.present[0]) : 'Someone';
      const where = this.deps.placeName() ?? 'this room';
      this.deps.notify('Microphone on', `${who} is here: the mic is on in ${where}`);
    }
  }

  private sendToPage(state: DeviceGateState): void {
    const window = this.deps.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed?.()) return;
    window.webContents.send('device-gate:changed', state);
  }

  private sendState(state: DeviceGateState): void {
    this.deps.sendOp({
      op: 'device.state',
      mic: state.mic,
      camera: state.camera,
      speakers: state.speakers,
      locked: state.locked,
      closed: state.closed,
      fullscreen: state.fullscreen,
    });
  }

  private reloadPage(): void {
    const window = this.deps.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.reload();
  }

  /** Called again when the room is renamed or the pairing changes. */
  refreshTray(state: DeviceGateState = this.gate.state()): void {
    const tray = this.deps.tray;
    if (!tray) return;
    try {
      const name = this.deps.placeName();
      tray.setToolTip(trayTooltip(name, state));
      tray.setImage(this.deps.makeImage(stateIcon(state.mic)));
      tray.setContextMenu(
        this.deps.makeMenu([
          { label: `${trayRoomName(name)}: ${state.summary || 'mic live'}`, enabled: false },
          { type: 'separator' },
          { label: state.open ? 'Close this room' : 'Open this room', click: () => void this.toggleOpen() },
          { label: 'Show window', click: () => this.deps.showWindow() },
          { type: 'separator' },
          { label: 'Quit', click: () => this.deps.quit() },
        ]),
      );
    } catch (error) {
      this.deps.logger?.warn('Could not update the tray', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}
