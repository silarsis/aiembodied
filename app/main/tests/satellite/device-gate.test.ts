import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_STOP_TIMEOUT_MS, DeviceGate, INITIAL_FACTS, avatarsHere, evaluateGate, guardMediaPermissions, type DeviceFacts } from '../../src/satellite/device-gate.js';

const ALL_TRUE: DeviceFacts = { occupied: true, unlocked: true, linkUp: true, open: true, noFullscreenApp: true, notHeldOff: true };
const KEYS = Object.keys(ALL_TRUE) as Array<keyof DeviceFacts>;

describe('evaluateGate (truth table)', () => {
  it('is live only when every fact is true', () => {
    // All 64 combinations: the mic is allowed in exactly one.
    let allowed = 0;
    for (let bits = 0; bits < 1 << KEYS.length; bits += 1) {
      const facts = Object.fromEntries(KEYS.map((key, index) => [key, (bits & (1 << index)) !== 0])) as unknown as DeviceFacts;
      const state = evaluateGate(facts);
      if (state.micAllowed) allowed += 1;
      expect(state.micAllowed).toBe(Object.values(facts).every(Boolean));
      expect(state.mic).toBe(state.micAllowed ? 'live' : 'off');
      expect(state.doorbell).toBe(false);
    }
    expect(allowed).toBe(1);
  });

  it('turns off for each fact on its own', () => {
    for (const key of KEYS) {
      const state = evaluateGate({ ...ALL_TRUE, [key]: false });
      expect(state.micAllowed, key).toBe(false);
      expect(state.summary, key).not.toBe('');
    }
    expect(evaluateGate(ALL_TRUE).summary).toBe('');
  });

  it('names the reason in words', () => {
    expect(evaluateGate({ ...ALL_TRUE, open: false }).summary).toBe('This room is closed');
    expect(evaluateGate({ ...ALL_TRUE, unlocked: false }).summary).toBe('The screen is locked');
    expect(evaluateGate({ ...ALL_TRUE, noFullscreenApp: false }).summary).toBe('Another app is full screen');
    expect(evaluateGate({ ...ALL_TRUE, linkUp: false }).summary).toBe('Not connected to bija');
    expect(evaluateGate({ ...ALL_TRUE, notHeldOff: false }).summary).toBe('bija turned the devices off');
    expect(evaluateGate({ ...ALL_TRUE, occupied: false }).summary).toBe('Nobody is in this room');
  });

  it('is the doorbell when nobody is here, everything else is fine and the setting is on', () => {
    const empty = { ...ALL_TRUE, occupied: false };
    expect(evaluateGate(empty, false)).toMatchObject({ micAllowed: false, doorbell: false, mic: 'off' });
    expect(evaluateGate(empty, true)).toMatchObject({ micAllowed: false, doorbell: true, mic: 'doorbell', summary: 'Doorbell only' });
    // Not when something else is wrong: a locked or closed room does not listen for the bell either.
    for (const key of KEYS.filter((name) => name !== 'occupied')) {
      expect(evaluateGate({ ...empty, [key]: false }, true).doorbell, key).toBe(false);
    }
    // With someone here it is the mic, not the doorbell.
    expect(evaluateGate(ALL_TRUE, true)).toMatchObject({ micAllowed: true, doorbell: false, mic: 'live' });
  });

  it('reports the facts the way device.state names them', () => {
    expect(evaluateGate({ ...ALL_TRUE, unlocked: false, open: false, noFullscreenApp: false })).toMatchObject({ locked: true, closed: true, fullscreen: true, camera: 'off' });
  });

  it('starts closed: nothing is known yet', () => {
    expect(evaluateGate(INITIAL_FACTS).micAllowed).toBe(false);
  });
});

describe('avatarsHere', () => {
  const snapshot = (locations: Record<string, string>, transit: Array<{ avatarId: string; from: string; to: string }> = []) => ({
    places: [],
    locations,
    transit,
    localPlaceId: 'study',
  });
  it('lists the avatars standing in this room', () => {
    expect(avatarsHere(snapshot({ echo: 'study', sage: 'home' }))).toEqual(['echo']);
  });
  it('does not count an avatar in transit, either way', () => {
    expect(avatarsHere(snapshot({ echo: 'study' }, [{ avatarId: 'echo', from: 'study', to: 'home' }]))).toEqual([]);
    expect(avatarsHere(snapshot({ echo: 'home' }, [{ avatarId: 'echo', from: 'home', to: 'study' }]))).toEqual([]);
  });
  it('gives nobody for anything unreadable', () => {
    for (const value of [null, undefined, 3, {}, { locations: null, localPlaceId: 'study' }, { locations: {}, localPlaceId: 4 }]) expect(avatarsHere(value)).toEqual([]);
  });
});

describe('DeviceGate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(facts: Partial<DeviceFacts> = ALL_TRUE) {
    const reload = vi.fn();
    const changes: Array<{ mic: string; changed: string[] }> = [];
    const gate = new DeviceGate({ facts, reloadRenderer: reload, onChange: (state, changed) => changes.push({ mic: state.mic, changed }) });
    return { gate, reload, changes };
  }

  it('notifies only on a real change, with the facts that changed', () => {
    const { gate, changes } = setup();
    gate.update({ occupied: true });
    expect(changes).toHaveLength(0);
    gate.update({ occupied: false, linkUp: false });
    expect(changes).toEqual([{ mic: 'off', changed: ['occupied', 'linkUp'] }]);
  });

  it.each([
    ['the link drops', { linkUp: false }],
    ['the screen locks', { unlocked: false }],
    ['the room is closed', { open: false }],
    ['a full-screen app starts', { noFullscreenApp: false }],
    ['the last avatar leaves', { occupied: false }],
    ['bija asks the devices off', { notHeldOff: false }],
  ] as Array<[string, Partial<DeviceFacts>]>)('closes at once when %s, and reloads the page if it does not confirm', (_name, patch) => {
    const { gate, reload } = setup();
    expect(gate.allowsMedia()).toBe(true);
    gate.update(patch);
    expect(gate.allowsMedia()).toBe(false);
    vi.advanceTimersByTime(CAPTURE_STOP_TIMEOUT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the page confirms capture stopped in time', () => {
    const { gate, reload } = setup();
    gate.update({ linkUp: false });
    vi.advanceTimersByTime(300);
    gate.captureStopped();
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when the gate was never open, or when it opens again before the wait is over', () => {
    const closed = setup(INITIAL_FACTS);
    closed.gate.update({ linkUp: true });
    vi.advanceTimersByTime(5000);
    expect(closed.reload).not.toHaveBeenCalled();
    const { gate, reload } = setup();
    gate.update({ unlocked: false });
    vi.advanceTimersByTime(400);
    gate.update({ unlocked: true });
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps going if reloading throws', () => {
    const gate = new DeviceGate({
      facts: ALL_TRUE,
      reloadRenderer: () => {
        throw new Error('gone');
      },
    });
    gate.update({ open: false });
    expect(() => vi.advanceTimersByTime(CAPTURE_STOP_TIMEOUT_MS)).not.toThrow();
  });

  it('follows the doorbell setting', () => {
    const { gate } = setup({ ...ALL_TRUE, occupied: false });
    expect(gate.state().mic).toBe('off');
    gate.setDoorbellEnabled(true);
    expect(gate.state()).toMatchObject({ mic: 'doorbell', doorbell: true });
    expect(gate.allowsMedia()).toBe(true);
  });
});

describe('guardMediaPermissions', () => {
  function install(allowed: () => boolean) {
    let request: ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null = null;
    let check: ((webContents: unknown, permission: string) => boolean) | null = null;
    guardMediaPermissions(
      {
        setPermissionRequestHandler: (handler) => void (request = handler as typeof request),
        setPermissionCheckHandler: (handler) => void (check = handler as typeof check),
      },
      { allowsMedia: allowed },
    );
    const ask = (permission: string) => {
      const callback = vi.fn();
      (request as NonNullable<typeof request>)(null, permission, callback);
      return callback.mock.calls[0][0] as boolean;
    };
    return { ask, has: (permission: string) => (check as NonNullable<typeof check>)(null, permission) };
  }

  it('refuses media while the gate is closed and grants it while open', () => {
    let open = false;
    const { ask, has } = install(() => open);
    expect(ask('media')).toBe(false);
    expect(has('media')).toBe(false);
    expect(ask('audioCapture')).toBe(false);
    open = true;
    expect(ask('media')).toBe(true);
    expect(has('media')).toBe(true);
  });

  it('answers every other permission as before (granted)', () => {
    const { ask, has } = install(() => false);
    for (const permission of ['clipboard-read', 'notifications', 'fullscreen']) {
      expect(ask(permission)).toBe(true);
      expect(has(permission)).toBe(true);
    }
  });
});
