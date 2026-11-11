import { describe, expect, it } from 'vitest';
import { createIdlePickerState, IDLE_ACTOR_COOLDOWN_MS, idleRotation, pickIdleActor, type IdleCandidate } from '../../src/rooms/idle-picker.js';

const c = (id: string, extra: Partial<IdleCandidate> = {}): IdleCandidate => ({ id, busy: false, speaking: false, lastActedAt: 0, ...extra });

describe('pickIdleActor', () => {
  it('always picks Echo when she is alone, ignoring the cooldown', () => {
    const state = createIdlePickerState();
    for (let i = 0; i < 4; i += 1) expect(pickIdleActor([c('echo', { lastActedAt: 999_000 })], 1_000_000, state)).toBe('echo');
    expect(pickIdleActor([c('echo', { busy: true })], 1_000_000, state)).toBeNull();
    expect(pickIdleActor([c('echo', { speaking: true })], 1_000_000, state)).toBeNull();
  });

  it('builds a rotation with Echo twice as often', () => {
    expect(idleRotation(['echo', 'a', 'b'])).toEqual(['echo', 'a', 'echo', 'b']);
    expect(idleRotation(['a', 'echo'])).toEqual(['echo', 'a']);
  });

  it('goes round: echo, a, echo, b', () => {
    const state = createIdlePickerState();
    const all = [c('echo'), c('a'), c('b')];
    const picks = Array.from({ length: 8 }, () => pickIdleActor(all, 1_000_000, state));
    expect(picks).toEqual(['echo', 'a', 'echo', 'b', 'echo', 'a', 'echo', 'b']);
  });

  it('skips busy, speaking and recently acted avatars', () => {
    const now = 1_000_000;
    const state = createIdlePickerState();
    expect(pickIdleActor([c('echo', { busy: true }), c('a')], now, state)).toBe('a');
    expect(pickIdleActor([c('echo', { speaking: true }), c('a')], now, createIdlePickerState())).toBe('a');
    expect(pickIdleActor([c('echo', { lastActedAt: now - 5_000 }), c('a')], now, createIdlePickerState())).toBe('a');
    expect(pickIdleActor([c('echo', { lastActedAt: now - IDLE_ACTOR_COOLDOWN_MS }), c('a')], now, createIdlePickerState())).toBe('echo');
  });

  it('returns null when nobody is eligible', () => {
    const now = 1_000_000;
    expect(pickIdleActor([c('echo', { busy: true }), c('a', { speaking: true }), c('b', { lastActedAt: now - 1 })], now, createIdlePickerState())).toBeNull();
  });

  it('uses an injected rng with Echo weighted twice', () => {
    const all = [c('echo'), c('a')];
    expect(pickIdleActor(all, 1_000_000, createIdlePickerState(), { rng: () => 0.1 })).toBe('echo');
    expect(pickIdleActor(all, 1_000_000, createIdlePickerState(), { rng: () => 0.5 })).toBe('echo');
    expect(pickIdleActor(all, 1_000_000, createIdlePickerState(), { rng: () => 0.9 })).toBe('a');
  });
});
