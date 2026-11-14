import type { DeviceGateState } from '../../../main/src/satellite/device-gate.js';

/**
 * What a native shell (the Android app, next PR) may set before the page loads, as `window.__AIEMBODIED_SHELL__`.
 * The page reads it once, at boot. Everything is optional: a plain browser has no shell.
 */
export interface ShellHook {
  /** The hub's WebSocket address (`ws://bija:8791`). Default: the page's own origin. */
  hubUrl?: string;
  /** The pairing the shell already holds. With `token` and `deviceId` the page never shows the connect screen. */
  deviceId?: string;
  token?: string;
  deviceName?: string;
  /** `phone` when a shell sets it; the pair request says so. Default `browser`. */
  kind?: 'phone' | 'browser';
  /** Is the app in the foreground with the screen unlocked, right now? Absent counts as yes (the page's own visibility still applies). */
  foreground?: boolean | (() => boolean);
  /** The shell's foreground changed. The page passes its listener; return a function that stops it. */
  onForeground?: (listener: () => void) => (() => void) | void;
  /** Called after every change of the privacy gate, so the shell can enforce it natively (stop its own capture). */
  onGate?: (state: DeviceGateState) => void;
}

export function readShellHook(win: Window = window): ShellHook | null {
  const hook = (win as unknown as { __AIEMBODIED_SHELL__?: unknown }).__AIEMBODIED_SHELL__;
  return hook && typeof hook === 'object' ? (hook as ShellHook) : null;
}
