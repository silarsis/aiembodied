/**
 * The desktops that are paired to this PC as rooms, and the one-time code used to pair a new one.
 * Kept in `<userData>/room-devices.json` so pairings survive restarts. Only a SHA-256 of each token is
 * stored; the token itself goes to the satellite once and is never written here.
 *
 * Pure Node (crypto, fs). The clock is injected so the tests can move time.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const LOCKOUT_ATTEMPTS = 10;
export const LOCKOUT_WINDOW_MS = 60_000;
export const LOCKOUT_REFUSAL_MS = 60_000;
const MAX_DEVICES = 20;

/** What kind of thing a paired device is. Only shown for now; later PRs give a phone and a browser their own rules. */
export type DeviceKind = 'desktop' | 'phone' | 'browser';
export const DEVICE_KINDS: readonly DeviceKind[] = ['desktop', 'phone', 'browser'];

/** The kind a pair request asked for; anything else (or nothing) is a desktop. */
export function cleanKind(value: unknown): DeviceKind {
  return DEVICE_KINDS.includes(value as DeviceKind) ? (value as DeviceKind) : 'desktop';
}

export interface RoomDevice {
  id: string;
  name: string;
  /** Older records have none: a desktop. */
  kind: DeviceKind;
  placeId: string;
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  /** The Tailscale node name and login of the PC at pairing time; null when it paired from this PC itself. */
  tailscaleNode: string | null;
  tailscaleLogin: string | null;
  createdAt: number;
  lastSeen: number;
  revoked?: boolean;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string compare (false when the lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function makePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function makeToken(): string {
  return randomBytes(32).toString('base64url');
}

function cleanName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? [...value].filter((char) => char >= ' ' && char !== '\u007f').join('').trim().slice(0, 60) : '';
  return name || fallback;
}

function isDevice(value: unknown): value is RoomDevice {
  const device = value as Partial<RoomDevice> | null;
  return (
    typeof device === 'object' &&
    device !== null &&
    typeof device.id === 'string' &&
    !!device.id &&
    typeof device.name === 'string' &&
    typeof device.placeId === 'string' &&
    typeof device.tokenHash === 'string' &&
    typeof device.createdAt === 'number'
  );
}

/** Counts wrong codes per address: 10 within a minute and that address is refused for the next minute. */
export class PairingLockout {
  private readonly failures = new Map<string, number[]>();
  private readonly lockedUntil = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds this address is still refused for, or 0. */
  lockedFor(address: string): number {
    const until = this.lockedUntil.get(address);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left <= 0) {
      this.lockedUntil.delete(address);
      return 0;
    }
    return left;
  }

  /** Records one wrong code. True when this one locked the address out. */
  fail(address: string): boolean {
    const time = this.now();
    const recent = (this.failures.get(address) ?? []).filter((at) => time - at < LOCKOUT_WINDOW_MS);
    recent.push(time);
    this.failures.set(address, recent);
    if (recent.length >= LOCKOUT_ATTEMPTS) {
      this.lockedUntil.set(address, time + LOCKOUT_REFUSAL_MS);
      this.failures.delete(address);
      return true;
    }
    return false;
  }
}

export class RoomDeviceRegistry {
  private devices: RoomDevice[] = [];
  private pairing: PairingCode | null = null;
  readonly lockout: PairingLockout;

  constructor(
    private readonly filePath: string | null,
    private readonly now: () => number = Date.now,
    private readonly makeCode: () => string = makePairingCode,
  ) {
    this.lockout = new PairingLockout(now);
    this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as { devices?: unknown };
      this.devices = Array.isArray(raw.devices) ? raw.devices.filter(isDevice).map((device) => ({ ...device, kind: cleanKind((device as { kind?: unknown }).kind) })) : [];
    } catch {
      this.devices = [];
    }
  }

  private save(): void {
    if (!this.filePath) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify({ devices: this.devices }, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.filePath);
  }

  // -- Devices -----------------------------------------------------------------------------------

  /** Devices that are not revoked, newest connection first. */
  list(): RoomDevice[] {
    return this.devices.filter((device) => !device.revoked).sort((a, b) => b.lastSeen - a.lastSeen).map((device) => ({ ...device }));
  }

  get(id: string): RoomDevice | null {
    const device = this.devices.find((candidate) => candidate.id === id && !candidate.revoked);
    return device ? { ...device } : null;
  }

  /** Constant-time token check. False for an unknown or revoked device. */
  verifyToken(id: string, token: string): boolean {
    const device = this.devices.find((candidate) => candidate.id === id && !candidate.revoked);
    // Compare against a dummy hash for an unknown device so the time does not tell the two cases apart.
    const expected = device?.tokenHash ?? '0'.repeat(64);
    const matches = safeEqual(hashToken(token), expected);
    return Boolean(device) && matches;
  }

  /** The device a token belongs to (constant-time compare of hashes), or null. For requests that carry only the token. */
  findByToken(token: string): RoomDevice | null {
    if (!token) return null;
    const hash = hashToken(token);
    let found: RoomDevice | null = null;
    // Every device is compared, so the time does not say which one matched.
    for (const device of this.devices) if (!device.revoked && safeEqual(hash, device.tokenHash) && !found) found = device;
    return found ? { ...found } : null;
  }

  touch(id: string): void {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device) return;
    device.lastSeen = this.now();
    this.save();
  }

  /** Marks a device revoked. Its token stops working at once. Returns the device, or null when unknown. */
  revoke(id: string): RoomDevice | null {
    const device = this.devices.find((candidate) => candidate.id === id && !candidate.revoked);
    if (!device) return null;
    device.revoked = true;
    this.save();
    return { ...device };
  }

  /** Adds a device and returns it with its token (the only time the token exists in the clear). */
  addDevice(input: { id: string; name: string; kind?: DeviceKind; placeId: string; tailscaleNode: string | null; tailscaleLogin: string | null }): { device: RoomDevice; token: string } {
    const token = makeToken();
    const time = this.now();
    const device: RoomDevice = {
      id: input.id,
      name: cleanName(input.name, 'Desktop room'),
      kind: cleanKind(input.kind),
      placeId: input.placeId,
      tokenHash: hashToken(token),
      tailscaleNode: input.tailscaleNode,
      tailscaleLogin: input.tailscaleLogin,
      createdAt: time,
      lastSeen: time,
    };
    // Revoked records are dropped the next time a device is added.
    const kept = this.devices.filter((candidate) => !candidate.revoked);
    if (kept.length >= MAX_DEVICES) throw new Error(`At most ${MAX_DEVICES} desktop rooms can be paired.`);
    this.devices = [...kept, device];
    this.save();
    return { device: { ...device }, token };
  }

  // -- Pairing code ------------------------------------------------------------------------------

  /** Makes a new code. Any earlier code stops working. */
  startPairing(): PairingCode {
    this.pairing = { code: this.makeCode(), expiresAt: this.now() + PAIRING_CODE_TTL_MS };
    return { ...this.pairing };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  /** The active code, or null when there is none or it has expired. */
  activePairing(): PairingCode | null {
    if (this.pairing && this.pairing.expiresAt <= this.now()) this.pairing = null;
    return this.pairing ? { ...this.pairing } : null;
  }

  /** Constant-time check of a code a satellite sent, without using it up. */
  codeMatches(candidate: unknown): boolean {
    const active = this.activePairing();
    if (!active || typeof candidate !== 'string') return false;
    return safeEqual(candidate.replace(/\s+/g, ''), active.code);
  }

  /** Uses the code up. True when it was still the active one. */
  consumeCode(candidate: unknown): boolean {
    if (!this.codeMatches(candidate)) return false;
    this.pairing = null;
    return true;
  }
}
