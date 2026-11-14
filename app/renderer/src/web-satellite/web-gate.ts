import { DeviceGate, avatarsHere, type DeviceFacts, type DeviceGateState } from '../../../main/src/satellite/device-gate.js';
import { cameraSettingHere } from '../../../main/src/satellite/snapshot-facts.js';

export interface WebGateOptions {
  /** Is the page visible, and the shell (if any) in the foreground? The page's stand-in for "the screen is unlocked". */
  isForeground: () => boolean;
  /** The room was closed by hand last time (kept in localStorage). */
  closed: boolean;
  /** Told after every change. */
  onChange: (state: DeviceGateState, changed: Array<keyof DeviceFacts>) => void;
  /** Reloads the page. The gate calls it when the page did not confirm that capture stopped. */
  reload: () => void;
  captureTimeoutMs?: number;
  logger?: Pick<Console, 'warn' | 'info'>;
}

/**
 * The privacy gate of a web page: the same rules and the same pure logic as the desktop satellite's
 * (main/src/satellite/device-gate.ts), with the page's own facts:
 *
 * - unlocked: the page is visible (`document.visibilityState`) and, in a shell, the shell says it is in the foreground.
 * - noFullscreenApp: true. A page cannot see other apps; a shell may enforce more natively.
 * - open: the "Close this room" switch, kept in localStorage.
 * - linkUp, occupied, cameraEnabled, notHeldOff: from the link and bija, as on the desktop.
 *
 * It fails closed: nothing is allowed until the link is up and bija's snapshot says an avatar is here. In a plain
 * browser the page enforces this itself, so it is only as strong as the page; a shell adds native enforcement.
 */
export class WebGate {
  private readonly gate: DeviceGate;
  private present: string[] = [];

  constructor(private readonly options: WebGateOptions) {
    this.gate = new DeviceGate({
      facts: { open: !options.closed, unlocked: options.isForeground(), noFullscreenApp: true },
      // No wake word worker in a browser, so no doorbell on a web satellite.
      doorbellEnabled: false,
      captureTimeoutMs: options.captureTimeoutMs,
      reloadRenderer: options.reload,
      onChange: (state, changed) => options.onChange(state, changed),
      logger: options.logger,
    });
  }

  state(): DeviceGateState {
    return this.gate.state();
  }

  /** The page was shown or hidden, or the shell moved to the foreground or background. */
  checkForeground(): void {
    this.gate.update({ unlocked: this.options.isForeground() });
  }

  setLinkUp(up: boolean): void {
    this.gate.update({ linkUp: up, ...(up ? { notHeldOff: true } : {}) });
  }

  /** A places snapshot: who stands in this room and whether its camera presence is on. */
  setSnapshot(snapshot: unknown): void {
    this.present = avatarsHere(snapshot);
    this.gate.update({ occupied: this.present.length > 0, cameraEnabled: cameraSettingHere(snapshot) });
  }

  /** bija asked the devices off. It can never turn them on. */
  hubOff(): void {
    this.gate.update({ notHeldOff: false });
  }

  setOpen(open: boolean): DeviceGateState {
    return this.gate.update({ open, ...(open ? { notHeldOff: true } : {}) });
  }

  /** The page says every capture track has stopped. */
  captureStopped(): void {
    this.gate.captureStopped();
  }

  dispose(): void {
    this.gate.dispose();
  }
}
