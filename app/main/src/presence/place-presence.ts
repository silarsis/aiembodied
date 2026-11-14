/**
 * What each desktop room's PC says about itself: whether someone is there (presence), and the state of its
 * microphone, camera and speakers. bija's own presence (`PresenceTracker`) is about bija's room and is never
 * changed by a satellite; this is the per-place copy that later steps (PR 4: the mic and wake word) build on.
 *
 * Pure: no Electron, no timers. Times are the PC's own clock readings passed in by the caller.
 */
import type { Op } from '../room-hub/frames.js';

export interface PlacePresenceSnapshot {
  listening?: boolean;
  voicePhase?: string;
  faceSeenAt?: number;
  userSpokeAt?: number;
  assistantSpokeAt?: number;
  activeAt?: number;
  /** When this snapshot last changed (this PC's clock). */
  updatedAt: number;
}

export interface PlaceDeviceState {
  mic: string;
  camera: string;
  speakers: string;
  locked: boolean;
  closed: boolean;
  /** Another app is full screen on that PC, so its devices are off for now. */
  fullscreen: boolean;
}

export interface PlaceWake {
  model: string;
  score: number;
  at: number;
}

const FIELDS = ['listening', 'voicePhase', 'faceSeenAt', 'userSpokeAt', 'assistantSpokeAt', 'activeAt'] as const;

export class PlacePresence {
  private readonly presence = new Map<string, PlacePresenceSnapshot>();
  private readonly devices = new Map<string, PlaceDeviceState>();
  private readonly wakes = new Map<string, PlaceWake>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Merges the fields of a `presence` message (or a local update) into the place's snapshot. Unknown or mistyped fields are ignored. */
  update(placeId: string, fields: Record<string, unknown>): PlacePresenceSnapshot {
    const next: PlacePresenceSnapshot = { ...(this.presence.get(placeId) ?? {}), updatedAt: this.now() };
    for (const key of FIELDS) {
      const value = fields[key];
      if (key === 'listening') {
        if (typeof value === 'boolean') next.listening = value;
      } else if (key === 'voicePhase') {
        if (typeof value === 'string' && value.length <= 40) next.voicePhase = value;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        next[key] = value;
      }
    }
    this.presence.set(placeId, next);
    return next;
  }

  get(placeId: string): PlacePresenceSnapshot | null {
    return this.presence.get(placeId) ?? null;
  }

  deviceState(placeId: string): PlaceDeviceState | null {
    return this.devices.get(placeId) ?? null;
  }

  lastWake(placeId: string): PlaceWake | null {
    return this.wakes.get(placeId) ?? null;
  }

  /** A `presence`, `device.state` or `wake.heard` message from the satellite at `placeId`. */
  onSatelliteOp(placeId: string, op: Op): void {
    if (op.op === 'presence') {
      this.update(placeId, op);
    } else if (op.op === 'device.state') {
      const text = (value: unknown, fallback: string) => (typeof value === 'string' && value.length <= 20 ? value : fallback);
      this.devices.set(placeId, {
        mic: text(op.mic, 'off'),
        camera: text(op.camera, 'off'),
        speakers: text(op.speakers, 'off'),
        locked: op.locked === true,
        closed: op.closed === true,
        fullscreen: op.fullscreen === true,
      });
    } else if (op.op === 'wake.heard' && typeof op.model === 'string' && typeof op.score === 'number') {
      this.wakes.set(placeId, { model: op.model.slice(0, 80), score: op.score, at: this.now() });
    }
  }

  /** A place went away (revoked): forget it. */
  forget(placeId: string): void {
    this.presence.delete(placeId);
    this.devices.delete(placeId);
    this.wakes.delete(placeId);
  }
}
