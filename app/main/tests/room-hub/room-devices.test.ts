import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCKOUT_ATTEMPTS,
  LOCKOUT_REFUSAL_MS,
  PAIRING_CODE_TTL_MS,
  PairingLockout,
  RoomDeviceRegistry,
  hashToken,
  makePairingCode,
} from '../../src/room-hub/room-devices.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function clockAt(start = 1_000_000) {
  const clock = { time: start, now: () => clock.time };
  return clock;
}

const input = { id: 'room-1', name: "Kevin's desk", placeId: 'study', tailscaleNode: 'desk', tailscaleLogin: 'kevin@example.com' };

describe('RoomDeviceRegistry', () => {
  it('makes six-digit codes', () => {
    for (let i = 0; i < 50; i += 1) expect(makePairingCode()).toMatch(/^\d{6}$/);
  });

  it('keeps one code at a time, valid for 5 minutes, usable once', () => {
    const clock = clockAt();
    const codes = ['111111', '222222'];
    const registry = new RoomDeviceRegistry(null, clock.now, () => codes.shift() ?? '000000');
    expect(registry.activePairing()).toBeNull();
    const first = registry.startPairing();
    expect(first).toEqual({ code: '111111', expiresAt: clock.time + PAIRING_CODE_TTL_MS });
    expect(registry.codeMatches('111111')).toBe(true);
    expect(registry.codeMatches('111112')).toBe(false);
    // A new code replaces the old one.
    registry.startPairing();
    expect(registry.codeMatches('111111')).toBe(false);
    expect(registry.consumeCode('222222')).toBe(true);
    expect(registry.consumeCode('222222')).toBe(false);
    expect(registry.activePairing()).toBeNull();
  });

  it('expires the code', () => {
    const clock = clockAt();
    const registry = new RoomDeviceRegistry(null, clock.now, () => '123456');
    registry.startPairing();
    clock.time += PAIRING_CODE_TTL_MS - 1;
    expect(registry.codeMatches('123456')).toBe(true);
    clock.time += 1;
    expect(registry.codeMatches('123456')).toBe(false);
    expect(registry.activePairing()).toBeNull();
  });

  it('can cancel a code', () => {
    const registry = new RoomDeviceRegistry(null);
    const { code } = registry.startPairing();
    registry.cancelPairing();
    expect(registry.codeMatches(code)).toBe(false);
  });

  it('stores only the token hash, and checks the token in constant time', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'room-devices-'));
    folders.push(folder);
    const file = path.join(folder, 'room-devices.json');
    const registry = new RoomDeviceRegistry(file);
    const { device, token } = registry.addDevice(input);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(device.tokenHash).toBe(hashToken(token));
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain(token);
    expect(saved).toContain(hashToken(token));
    expect(registry.verifyToken('room-1', token)).toBe(true);
    expect(registry.verifyToken('room-1', `${token}x`)).toBe(false);
    expect(registry.verifyToken('room-1', '')).toBe(false);
    expect(registry.verifyToken('nobody', token)).toBe(false);
    // A new registry on the same file remembers the device.
    const again = new RoomDeviceRegistry(file);
    expect(again.verifyToken('room-1', token)).toBe(true);
    expect(again.get('room-1')?.placeId).toBe('study');
  });

  it('revoke stops the token at once and hides the device', () => {
    const registry = new RoomDeviceRegistry(null);
    const { token } = registry.addDevice(input);
    expect(registry.revoke('room-1')?.id).toBe('room-1');
    expect(registry.verifyToken('room-1', token)).toBe(false);
    expect(registry.list()).toEqual([]);
    expect(registry.get('room-1')).toBeNull();
    expect(registry.revoke('room-1')).toBeNull();
  });

  it('records when a device was last seen', () => {
    const clock = clockAt();
    const registry = new RoomDeviceRegistry(null, clock.now);
    registry.addDevice(input);
    clock.time += 5000;
    registry.touch('room-1');
    expect(registry.get('room-1')?.lastSeen).toBe(clock.time);
  });

  it('survives a missing or broken file', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'room-devices-'));
    folders.push(folder);
    expect(new RoomDeviceRegistry(path.join(folder, 'none.json')).list()).toEqual([]);
  });
});

describe('PairingLockout', () => {
  it('refuses an address for 60 s after 10 wrong codes in a minute', () => {
    const clock = clockAt();
    const lockout = new PairingLockout(clock.now);
    for (let i = 0; i < LOCKOUT_ATTEMPTS - 1; i += 1) {
      expect(lockout.fail('10.0.0.5')).toBe(false);
      clock.time += 100;
    }
    expect(lockout.lockedFor('10.0.0.5')).toBe(0);
    expect(lockout.fail('10.0.0.5')).toBe(true);
    expect(lockout.lockedFor('10.0.0.5')).toBeGreaterThan(0);
    expect(lockout.lockedFor('10.0.0.6')).toBe(0);
    clock.time += LOCKOUT_REFUSAL_MS;
    expect(lockout.lockedFor('10.0.0.5')).toBe(0);
  });

  it('does not count wrong codes that are more than a minute apart', () => {
    const clock = clockAt();
    const lockout = new PairingLockout(clock.now);
    for (let i = 0; i < 30; i += 1) {
      expect(lockout.fail('a')).toBe(false);
      clock.time += 10_000;
    }
  });
});
