import { describe, expect, it } from 'vitest';
import { PlacePresence } from '../src/presence/place-presence.js';

describe('PlacePresence', () => {
  it('keeps what each place said, apart from the others', () => {
    let now = 100;
    const presence = new PlacePresence(() => now);
    presence.update('study', { listening: true, voicePhase: 'waiting', userSpokeAt: 50 });
    now = 200;
    presence.update('attic', { listening: false });
    expect(presence.get('study')).toEqual({ listening: true, voicePhase: 'waiting', userSpokeAt: 50, updatedAt: 100 });
    expect(presence.get('attic')).toEqual({ listening: false, updatedAt: 200 });
    expect(presence.get('nowhere')).toBeNull();
  });

  it('merges later messages and ignores fields of the wrong type', () => {
    const presence = new PlacePresence(() => 1);
    presence.update('study', { listening: true, faceSeenAt: 5 });
    presence.update('study', { listening: 'yes', faceSeenAt: Number.NaN, activeAt: 9, bogus: 1 });
    expect(presence.get('study')).toEqual({ listening: true, faceSeenAt: 5, activeAt: 9, updatedAt: 1 });
  });

  it('takes presence, device.state and wake.heard messages from a satellite', () => {
    const presence = new PlacePresence(() => 7);
    presence.onSatelliteOp('study', { op: 'presence', listening: true });
    presence.onSatelliteOp('study', { op: 'device.state', mic: 'live', camera: 'off', speakers: 'live', locked: false, closed: true });
    presence.onSatelliteOp('study', { op: 'wake.heard', model: 'hey_echo', score: 0.9 });
    expect(presence.get('study')?.listening).toBe(true);
    expect(presence.deviceState('study')).toEqual({ mic: 'live', camera: 'off', speakers: 'live', locked: false, closed: true, fullscreen: false });
    expect(presence.lastWake('study')).toEqual({ model: 'hey_echo', score: 0.9, at: 7 });
    presence.forget('study');
    expect(presence.get('study')).toBeNull();
    expect(presence.deviceState('study')).toBeNull();
  });
});
