/**
 * The phone companion protocol. A phone (android-companion/) shows the active avatar and
 * background and is a microphone and speaker for the desktop app, which stays the brain: it runs
 * speech-to-text, the language model, text-to-speech and motion, and streams the results back.
 *
 * Everything goes over plain HTTP on the companion port (Settings → Phone companion):
 * - `GET /` and `/assets/*`: the phone page (the renderer's companion.html build). No secrets.
 * - `GET /api/*` and `POST /api/*`: need `Authorization: Bearer <pairing code>` and an
 *   `X-Companion-Device` id header (plus an optional `X-Companion-Name`).
 * - Streamed responses are NDJSON: one {@link CompanionStreamEvent} per line.
 * - `GET /api/events` is a long-lived NDJSON stream of pushes to that device: scene changes and
 *   messages the desktop sends with {@link CompanionHubApi.say}.
 */

import type { LocalVoiceEvent } from '../local-voice/types.js';

export interface CompanionSceneAvatar {
  id: string;
  name: string;
  /** Changes when the model file does, so the phone can cache it. */
  fileSha: string;
}

export interface CompanionSceneBackground {
  id: string;
  /** Where the avatar's feet go, as a fraction of the image height. */
  groundY: number;
}

export interface CompanionSceneEntry {
  id: string;
  name: string;
}

/** What the phone shows: the same avatar and background as the desktop. */
export interface CompanionScene {
  avatar: CompanionSceneAvatar | null;
  background: CompanionSceneBackground | null;
  animations: CompanionSceneEntry[];
  poses: CompanionSceneEntry[];
  /** Live {move:…} motion is available. */
  motionReady: boolean;
}

/** A sentence's audio as base64 16-bit WAV, so it fits in a JSON line. */
export type CompanionSentenceEvent = Omit<Extract<LocalVoiceEvent, { type: 'sentence' }>, 'wav'> & { wav: string };

export type CompanionStreamEvent =
  | { type: 'transcript'; requestId: string; text: string }
  | CompanionSentenceEvent
  | Extract<LocalVoiceEvent, { type: 'tool' | 'error' }>
  | { type: 'done'; requestId: string; text: string; cancelled: boolean }
  /** Pushed on /api/events. */
  | { type: 'scene'; scene: CompanionScene }
  /** Pushed on /api/events: the start of a message from the desktop; its sentences follow. */
  | { type: 'say'; requestId: string; text: string }
  /** /api/motion: one .vrma chunk of a live movement. */
  | { type: 'motion'; streamId: string; index: number; start: number; name: string; duration: number | null; data: string }
  | { type: 'ping'; ts: number };

export interface CompanionDevice {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
  /** The address it last connected from. */
  address: string | null;
  /** It has the push stream open now. */
  connected: boolean;
}

export interface CompanionStatus {
  enabled: boolean;
  port: number;
  running: boolean;
  error: string | null;
  /** Typed into the phone once. Anyone with it on the network can talk to the assistant. */
  pairingCode: string;
  /** Addresses the phone can use, e.g. http://192.168.1.20:8790 (Tailscale ones included). */
  urls: string[];
  devices: CompanionDevice[];
}

export interface CompanionSayRequest {
  text: string;
  /** One device, or every connected one when unset. */
  deviceId?: string;
}

export interface CompanionSayResult {
  /** Devices it was sent to. */
  delivered: string[];
}

export interface CompanionHubApi {
  getStatus(): CompanionStatus;
  say(request: CompanionSayRequest): Promise<CompanionSayResult>;
  rotatePairingCode(): Promise<CompanionStatus>;
  forgetDevice(deviceId: string): Promise<CompanionStatus>;
}
