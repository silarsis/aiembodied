/**
 * What bija does with the state a desktop room's PC reports about its own devices (`device.state`), and with
 * the kill switch (`room.close` / `room.open`).
 *
 * - The state is kept per place (presence/place-presence.ts) and every change is journaled as `place.device`.
 * - A room Kevin closed sends its avatars home at once and takes no one until it opens again.
 * - A locked screen for 5 minutes, or a full-screen app for 2 minutes, sends the avatars home too (with a reason):
 *   a mic that is off for that long means nobody can talk to them there. On a phone place "locked" also means the
 *   app is not in the foreground, and the clock is 2 minutes.
 *
 * The satellite switches its own devices off first. Nothing here can turn a device on.
 */
import type { PlacePresence, PlaceDeviceState } from '../presence/place-presence.js';
import type { PlaceManager } from '../places/place-manager.js';
import type { SwitchboardBus } from '../switchboard/bus.js';
import type { Op } from './frames.js';

export const LOCKED_HOME_MS = 5 * 60_000;
export const FULLSCREEN_HOME_MS = 2 * 60_000;
/** A phone that is locked or not in the foreground sends its avatars home after this long (a phone leaves the foreground all the time). */
export const PHONE_AWAY_HOME_MS = 2 * 60_000;

export interface PlaceDevicesOptions {
  places: Pick<PlaceManager, 'sendAllHome' | 'setClosed' | 'isClosed' | 'get'>;
  presence: Pick<PlacePresence, 'onSatelliteOp' | 'deviceState' | 'forget'>;
  bus?: () => SwitchboardBus | null;
  lockedMs?: number;
  /** The same clock for a phone place (2 minutes). */
  phoneAwayMs?: number;
  fullscreenMs?: number;
  /** Called after any device state change, so the Status panel and the Places page can redraw. */
  onChanged?: (placeId: string) => void;
  logger?: Pick<Console, 'warn' | 'info'>;
}

const FIELDS = ['mic', 'camera', 'speakers', 'locked', 'closed', 'fullscreen'] as const;

export class PlaceDevices {
  private readonly lockTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fullscreenTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: PlaceDevicesOptions) {}

  /** A `device.state`, `room.close` or `room.open` from the satellite at `placeId`. */
  onMessage(placeId: string, op: Op): void {
    if (op.op === 'device.state') this.onDeviceState(placeId, op);
    else if (op.op === 'room.close') this.setClosed(placeId, true);
    else if (op.op === 'room.open') this.setClosed(placeId, false);
  }

  private setClosed(placeId: string, closed: boolean): void {
    this.options.places.setClosed(placeId, closed);
    this.options.logger?.info(closed ? 'A desktop room was closed from its PC' : 'A desktop room was opened from its PC', { placeId });
    this.options.onChanged?.(placeId);
  }

  private onDeviceState(placeId: string, op: Op): void {
    const before = this.options.presence.deviceState(placeId);
    this.options.presence.onSatelliteOp(placeId, op);
    const after = this.options.presence.deviceState(placeId);
    if (!after) return;
    // The PC is the authority on whether Kevin closed the room, including after a restart of either side.
    if (this.options.places.isClosed(placeId) !== after.closed) this.setClosed(placeId, after.closed);
    const phone = this.options.places.get(placeId)?.kind === 'phone';
    this.watch(this.lockTimers, placeId, after.locked, phone ? (this.options.phoneAwayMs ?? PHONE_AWAY_HOME_MS) : (this.options.lockedMs ?? LOCKED_HOME_MS), phone ? 'phone not in use' : 'screen locked');
    this.watch(this.fullscreenTimers, placeId, after.fullscreen, this.options.fullscreenMs ?? FULLSCREEN_HOME_MS, 'full screen app');
    const changed = FIELDS.filter((field) => !before || before[field] !== after[field]);
    if (changed.length > 0) {
      this.journal(placeId, before, after, changed);
      this.options.onChanged?.(placeId);
    }
  }

  /** Starts the clock when the condition begins and stops it when it ends. */
  private watch(timers: Map<string, ReturnType<typeof setTimeout>>, placeId: string, on: boolean, ms: number, reason: string): void {
    if (!on) {
      const handle = timers.get(placeId);
      if (handle) clearTimeout(handle);
      timers.delete(placeId);
      return;
    }
    if (timers.has(placeId)) return;
    const handle = setTimeout(() => {
      timers.delete(placeId);
      this.options.places.sendAllHome(placeId, reason);
    }, ms);
    handle.unref?.();
    timers.set(placeId, handle);
  }

  /** The place went away (revoked): forget its state and stop its clocks. */
  forget(placeId: string): void {
    for (const timers of [this.lockTimers, this.fullscreenTimers]) {
      const handle = timers.get(placeId);
      if (handle) clearTimeout(handle);
      timers.delete(placeId);
    }
    this.options.presence.forget(placeId);
  }

  dispose(): void {
    for (const placeId of [...this.lockTimers.keys(), ...this.fullscreenTimers.keys()]) this.forget(placeId);
  }

  /** Fire-and-forget, like the hub's journal. */
  private journal(placeId: string, before: PlaceDeviceState | null, after: PlaceDeviceState, changed: string[]): void {
    try {
      const bus = this.options.bus?.();
      if (!bus) return;
      bus.publish({
        type: 'place.device',
        producer: { kind: 'service', id: 'room-hub' },
        to: [],
        scene: placeId,
        audience: 'private',
        payload: { placeId, state: after, previous: before, changed },
      });
    } catch (error) {
      this.options.logger?.warn('Could not journal a device change', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}
