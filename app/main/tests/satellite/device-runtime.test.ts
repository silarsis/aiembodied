import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceRuntime, DEFAULT_CLOSE_SHORTCUT, type MenuItemLike } from '../../src/satellite/device-runtime.js';
import { CAPTURE_STOP_TIMEOUT_MS, type DeviceGateState } from '../../src/satellite/device-gate.js';
import type { SatelliteSettings } from '../../src/satellite/settings.js';
import type { Op } from '../../src/room-hub/frames.js';

const snapshot = (locations: Record<string, string>, transit: Array<{ avatarId: string; from: string; to: string }> = [], study: { doorbell?: boolean } = {}) => ({
  places: [{ id: 'study', name: 'the study', node: 'device-1', camera: false, ...study }],
  locations,
  transit,
  localPlaceId: 'study',
});

function setup(settings: Partial<SatelliteSettings> = {}, onGate?: (state: DeviceGateState) => void) {
  const store = { closed: false, closeShortcut: null, doorbell: false, ...settings } as SatelliteSettings;
  const ops: Op[] = [];
  const sent: Array<[string, unknown]> = [];
  const reload = vi.fn();
  const listeners = new Map<string, () => void>();
  const shortcuts = new Map<string, () => void>();
  const tray = { setToolTip: vi.fn(), setImage: vi.fn(), setContextMenu: vi.fn(), destroy: vi.fn() };
  const menus: MenuItemLike[][] = [];
  const notify = vi.fn();
  let permission: ((webContents: unknown, permission: string, callback: (granted: boolean) => void, details?: unknown) => void) | null = null;
  let fullscreen: (noFullscreenApp: boolean) => void = () => undefined;
  const watcher = { start: vi.fn(), stop: vi.fn() };
  const runtime = new DeviceRuntime({
    settings: {
      get: () => ({ ...store }),
      update: (patch) => Object.assign(store, patch),
    },
    powerMonitor: {
      on: (event, listener) => void listeners.set(event, listener),
      removeListener: (event) => void listeners.delete(event),
    },
    globalShortcut: {
      register: (accelerator, callback) => (shortcuts.set(accelerator, callback), true),
      unregister: (accelerator) => void shortcuts.delete(accelerator),
    },
    session: {
      setPermissionRequestHandler: (handler) => void (permission = handler as typeof permission),
      setPermissionCheckHandler: () => undefined,
    },
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel: string, value: unknown) => void sent.push([channel, value]), reload } }),
    sendOp: (op) => (ops.push(op), true),
    tray,
    makeImage: (icon) => icon,
    makeMenu: (template) => (menus.push(template), template),
    makeWatcher: (onChange) => {
      fullscreen = onChange;
      return watcher;
    },
    notify,
    onGate,
    placeName: () => 'the study',
    avatarName: (id) => (id === 'echo' ? 'Echo' : id),
    showWindow: vi.fn(),
    quit: vi.fn(),
  });
  // Electron says which devices a `media` request wants; the mic's page asks for audio only.
  const ask = (name: string, mediaTypes: string[] = ['audio']) => {
    const callback = vi.fn();
    (permission as NonNullable<typeof permission>)(null, name, callback, { mediaTypes });
    return callback.mock.calls[0][0] as boolean;
  };
  return { runtime, store, ops, sent, reload, listeners, shortcuts, tray, menus, notify, ask, fullscreen: (value: boolean) => fullscreen(value), watcher };
}

describe('DeviceRuntime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts closed and refuses the mic until every fact is true', () => {
    const t = setup();
    t.runtime.start();
    expect(t.runtime.state().micAllowed).toBe(false);
    expect(t.ask('media')).toBe(false);
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    expect(t.runtime.state().micAllowed).toBe(false);
    t.runtime.setSnapshot(snapshot({ echo: 'study' }));
    expect(t.runtime.state()).toMatchObject({ micAllowed: true, mic: 'live' });
    expect(t.ask('media')).toBe(true);
  });

  it('tells the page and bija on every change', () => {
    const t = setup();
    t.runtime.start();
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    t.runtime.setSnapshot(snapshot({ echo: 'study' }));
    const last = t.sent.at(-1) as [string, { mic: string }];
    expect(last[0]).toBe('device-gate:changed');
    expect(last[1].mic).toBe('live');
    expect(t.ops.at(-1)).toEqual({ op: 'device.state', mic: 'live', camera: 'off', speakers: 'live', locked: false, closed: false, fullscreen: false });
  });

  it('closes on lock and opens on unlock', () => {
    const t = setup();
    t.runtime.start();
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    t.runtime.setSnapshot(snapshot({ echo: 'study' }));
    t.listeners.get('lock-screen')?.();
    expect(t.runtime.state()).toMatchObject({ micAllowed: false, locked: true });
    expect(t.ops.at(-1)).toMatchObject({ op: 'device.state', mic: 'off', locked: true });
    expect(t.ask('media')).toBe(false);
    t.listeners.get('unlock-screen')?.();
    expect(t.runtime.state().micAllowed).toBe(true);
  });

  it('closes when the link drops or a full-screen app starts, and when the last avatar leaves or is in transit', () => {
    const t = setup();
    t.runtime.start();
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    t.runtime.setSnapshot(snapshot({ echo: 'study' }));
    t.runtime.setLinkUp(false);
    expect(t.runtime.state().micAllowed).toBe(false);
    t.runtime.setLinkUp(true);
    expect(t.runtime.state().micAllowed).toBe(true);
    t.fullscreen(false);
    expect(t.runtime.state()).toMatchObject({ micAllowed: false, fullscreen: true });
    t.fullscreen(true);
    t.runtime.setSnapshot(snapshot({ echo: 'study' }, [{ avatarId: 'echo', from: 'study', to: 'home' }]));
    expect(t.runtime.state().micAllowed).toBe(false);
    t.runtime.setSnapshot(snapshot({ echo: 'home' }));
    expect(t.runtime.state().occupied).toBe(false);
  });

  it('reloads the page when it does not confirm that capture stopped', () => {
    const t = setup();
    t.runtime.start();
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    t.runtime.setSnapshot(snapshot({ echo: 'study' }));
    t.runtime.setLinkUp(false);
    vi.advanceTimersByTime(CAPTURE_STOP_TIMEOUT_MS);
    expect(t.reload).toHaveBeenCalledTimes(1);
    // A confirmed close does not reload.
    t.runtime.setLinkUp(true);
    t.runtime.setLinkUp(false);
    t.runtime.captureStopped();
    vi.advanceTimersByTime(CAPTURE_STOP_TIMEOUT_MS * 3);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('bija can turn the devices off, never on', () => {
    const t = setup();
    t.runtime.start();
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    t.runtime.setSnapshot(snapshot({ echo: 'study' }));
    t.runtime.hubOff('test');
    expect(t.runtime.state().micAllowed).toBe(false);
    // Nothing from bija brings it back; Kevin opening the room does.
    t.runtime.setSnapshot(snapshot({ echo: 'study', sage: 'study' }));
    expect(t.runtime.state().micAllowed).toBe(false);
    t.runtime.setOpen(true);
    expect(t.runtime.state().micAllowed).toBe(true);
  });

  describe('the kill switch', () => {
    it('closing tells bija (room.close), is saved, and the room stays closed after a restart', () => {
      const t = setup();
      t.runtime.start();
      t.fullscreen(true);
      t.runtime.setLinkUp(true);
      t.runtime.setSnapshot(snapshot({ echo: 'study' }));
      t.runtime.setOpen(false);
      expect(t.ops).toContainEqual({ op: 'room.close' });
      expect(t.store.closed).toBe(true);
      expect(t.runtime.state()).toMatchObject({ micAllowed: false, closed: true });
      // A new runtime with the saved settings starts closed even with everything else true.
      const again = setup({ closed: true });
      again.runtime.start();
      again.fullscreen(true);
      again.runtime.setLinkUp(true);
      again.runtime.setSnapshot(snapshot({ echo: 'study' }));
      expect(again.runtime.state()).toMatchObject({ micAllowed: false, closed: true, summary: 'This room is closed' });
      again.runtime.setOpen(true);
      expect(again.ops).toContainEqual({ op: 'room.open' });
      expect(again.store.closed).toBe(false);
      expect(again.runtime.state().micAllowed).toBe(true);
    });

    it('works from the tray menu and from the global shortcut', () => {
      const t = setup();
      t.runtime.start();
      expect(t.shortcuts.has(DEFAULT_CLOSE_SHORTCUT)).toBe(true);
      t.shortcuts.get(DEFAULT_CLOSE_SHORTCUT)?.();
      expect(t.store.closed).toBe(true);
      const item = t.menus.at(-1)?.find((entry) => entry.label === 'Open this room');
      expect(item).toBeDefined();
      item?.click?.();
      expect(t.store.closed).toBe(false);
      expect(t.menus.at(-1)?.some((entry) => entry.label === 'Close this room')).toBe(true);
    });

    it('uses the shortcut from satellite.json, and gives it up on stop', () => {
      const t = setup({ closeShortcut: 'Ctrl+Alt+K' });
      t.runtime.start();
      expect(t.shortcuts.has('Ctrl+Alt+K')).toBe(true);
      t.runtime.stop();
      expect(t.shortcuts.size).toBe(0);
      expect(t.watcher.stop).toHaveBeenCalled();
      expect(t.tray.destroy).toHaveBeenCalled();
    });
  });

  describe('the tray', () => {
    it('shows mic live, doorbell only or off, with a matching icon', () => {
      const t = setup();
      t.runtime.start();
      expect(t.tray.setToolTip).toHaveBeenLastCalledWith('Study: off');
      t.fullscreen(true);
      t.runtime.setLinkUp(true);
      t.runtime.setSnapshot(snapshot({ echo: 'study' }));
      expect(t.tray.setToolTip).toHaveBeenLastCalledWith('Study: mic live');
      expect(t.tray.setImage).toHaveBeenCalled();
      expect((t.menus.at(-1) ?? [])[0].label).toBe('Study: mic live');
      t.runtime.setSnapshot(snapshot({ echo: 'home' }));
      expect(t.tray.setToolTip).toHaveBeenLastCalledWith('Study: off');
      expect((t.menus.at(-1) ?? [])[0].label).toBe('Study: Nobody is in this room');
    });

    it('says doorbell only when the place\'s doorbell is on (a setting kept on bija) and nobody is here', () => {
      const t = setup();
      t.runtime.start();
      t.fullscreen(true);
      t.runtime.setLinkUp(true);
      t.runtime.setSnapshot(snapshot({ echo: 'home' }, [], { doorbell: true }));
      expect(t.tray.setToolTip).toHaveBeenLastCalledWith('Study: doorbell only');
      // Kevin turns it off on bija: the next snapshot closes it.
      t.runtime.setSnapshot(snapshot({ echo: 'home' }, [], { doorbell: false }));
      expect(t.tray.setToolTip).toHaveBeenLastCalledWith('Study: off');
    });

    it('has no doorbell by default for a desktop room, and none from satellite.json', () => {
      const t = setup({ doorbell: true });
      t.runtime.start();
      t.fullscreen(true);
      t.runtime.setLinkUp(true);
      t.runtime.setSnapshot(snapshot({ echo: 'home' }));
      expect(t.runtime.state()).toMatchObject({ doorbell: false, mic: 'off' });
    });
  });

  it('tells the wake word worker about every change of the gate', () => {
    const seen: Array<{ micAllowed: boolean; doorbell: boolean }> = [];
    const t = setup({}, (state) => seen.push({ micAllowed: state.micAllowed, doorbell: state.doorbell }));
    t.runtime.start();
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    t.runtime.setSnapshot(snapshot({ echo: 'home' }, [], { doorbell: true }));
    t.runtime.setSnapshot(snapshot({ echo: 'study' }, [], { doorbell: true }));
    expect(seen.at(-1)).toEqual({ micAllowed: true, doorbell: false });
    expect(seen).toContainEqual({ micAllowed: false, doorbell: true });
  });

  it('notifies the first time the mic goes live, and only then', () => {
    const t = setup();
    t.runtime.start();
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    t.runtime.setSnapshot(snapshot({ echo: 'study' }));
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith('Microphone on', 'Echo is here: the mic is on in the study');
    t.runtime.setLinkUp(false);
    t.runtime.setLinkUp(true);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('sends the state again after a reconnect even when nothing else changed', () => {
    const t = setup();
    t.runtime.start();
    t.runtime.setLinkUp(true);
    const before = t.ops.length;
    t.runtime.setLinkUp(true);
    expect(t.ops.length).toBe(before + 1);
  });

  it('turns the camera on only when the room\'s own setting says so, as bija sent it in the snapshot', () => {
    const t = setup();
    t.runtime.start();
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    const study = (camera?: boolean) => ({
      places: [{ id: 'study', name: 'the study', node: 'room-1', ...(camera === undefined ? {} : { camera }) }],
      locations: { echo: 'study' },
      transit: [],
      localPlaceId: 'study',
    });
    // A desktop room defaults to on.
    t.runtime.setSnapshot(study());
    expect(t.runtime.state()).toMatchObject({ micAllowed: true, camera: 'live' });
    expect(t.ops.at(-1)).toMatchObject({ op: 'device.state', mic: 'live', camera: 'live' });
    t.runtime.setSnapshot(study(false));
    expect(t.runtime.state()).toMatchObject({ micAllowed: true, camera: 'off' });
    t.runtime.setSnapshot(study(true));
    expect(t.runtime.state().camera).toBe('live');
    // Anything unreadable, or a snapshot without this room in it, fails closed.
    t.runtime.setSnapshot({ places: [], locations: { echo: 'study' }, transit: [], localPlaceId: 'study' });
    expect(t.runtime.state()).toMatchObject({ micAllowed: true, camera: 'off' });
    // The camera goes with the mic: nobody here, no camera.
    t.runtime.setSnapshot(study(true));
    t.runtime.setSnapshot({ ...study(true), locations: { echo: 'home' } });
    expect(t.runtime.state()).toMatchObject({ micAllowed: false, camera: 'off' });
  });

  it('refuses a camera request unless the camera may be live, whatever the mic does', () => {
    const t = setup();
    t.runtime.start();
    t.fullscreen(true);
    t.runtime.setLinkUp(true);
    t.runtime.setSnapshot({ places: [{ id: 'study', name: 'the study', node: 'room-1', camera: false }], locations: { echo: 'study' }, transit: [], localPlaceId: 'study' });
    expect(t.runtime.gate.allowsMedia('audio')).toBe(true);
    expect(t.runtime.gate.allowsMedia('video')).toBe(false);
    expect(t.ask('media', ['video'])).toBe(false);
    expect(t.ask('media', ['audio'])).toBe(true);
  });
});
