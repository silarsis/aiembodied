/**
 * Pairing with bija, as a satellite does it: check what Kevin typed, `POST /v1/pair`, and read the answer. Shared by
 * the Electron satellite (satellite.ts, which keeps the token in the keychain) and the web satellite (which keeps it
 * in the page's localStorage). Only `fetch` and the hub address parser; no Electron, no Node.
 */
import type { DeviceKind } from '../room-hub/room-devices.js';
import { parseHubUrl } from './link-shared.js';

export interface PairRequest {
  hubUrl: string;
  code: string;
  placeName?: string;
  deviceName?: string;
  /** What this device is. The Electron satellite sends nothing (a desktop). */
  kind?: DeviceKind;
  /** The name offered when Kevin typed none: this PC's host name. */
  defaultDeviceName: string;
  fetchFn?: typeof fetch;
  /** How the address is read. The web satellite reads one with a scheme as it is (no hub port added). */
  parseHub?: (input: string) => { ws: string; http: string } | null;
}

export interface PairResult {
  hub: { ws: string; http: string };
  deviceName: string;
  placeName: string;
  body: { deviceId: string; token: string; placeId: string };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pairs once. Rejects with a sentence Kevin can read. */
export async function requestPairing(input: PairRequest): Promise<PairResult> {
  const hub = (input.parseHub ?? parseHubUrl)(String(input.hubUrl ?? ''));
  if (!hub) throw new Error('That is not a hub address. Try something like ws://bija:8791.');
  const code = String(input.code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) throw new Error('The code is 6 digits.');
  const deviceName = (input.deviceName ?? '').trim().slice(0, 60) || input.defaultDeviceName;
  const placeName = (input.placeName ?? '').trim().slice(0, 60) || 'the study';
  let response: Response;
  try {
    response = await (input.fetchFn ?? fetch)(`${hub.http}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName, placeName, ...(input.kind ? { kind: input.kind } : {}) }),
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
  return { hub, deviceName, placeName, body: { deviceId: body.deviceId, token: body.token, placeId: body.placeId } };
}
