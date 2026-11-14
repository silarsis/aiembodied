import { describe, expect, it } from 'vitest';
import { PlacePresence, describePlaceLine } from '../src/presence/place-presence.js';
import { PresenceTracker } from '../src/presence/presence.js';
import { createArrivalGreeting } from '../src/presence/arrival-greeting.js';
import { cameraPresenceOn } from '../src/places/camera-setting.js';

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

describe('per-place presence lines', () => {
  it('says when a face was seen in another place and who is there', () => {
    expect(describePlaceLine({ name: 'the study', faceSeenAt: 1_000_000 - 120_000, avatars: ['Echo'] }, 1_000_000)).toBe('The study: a face was seen 2 min ago; Echo is there.');
    expect(describePlaceLine({ name: 'attic', faceSeenAt: 1_000_000 - 20_000, avatars: ['Echo', 'Sage'] }, 1_000_000)).toBe('Attic: a face was seen 20 s ago; Echo and Sage are there.');
    expect(describePlaceLine({ name: 'attic', faceSeenAt: null, avatars: [] }, 1)).toBe('Attic: no face has been seen; nobody is there.');
    expect(describePlaceLine({ name: 'x', faceSeenAt: 0, avatars: ['A', 'B', 'C'] }, 10_000)).toBe('X: a face was seen 10 s ago; A, B and C are there.');
  });

  it('adds one line per other place after the lines about bija, and leaves them alone without any', () => {
    const now = new Date(2026, 10, 10, 21, 40, 0).getTime();
    const tracker = new PresenceTracker();
    const before = tracker.describe(now);
    tracker.setPlaceLines(() => []);
    expect(tracker.describe(now)).toBe(before);
    tracker.setPlaceLines(() => ['The study: a face was seen 2 min ago; Echo is there.', 'Attic: no face has been seen; nobody is there.']);
    const text = tracker.describe(now);
    expect(text.startsWith(before)).toBe(true);
    expect(text.split('\n').slice(-2)).toEqual(['The study: a face was seen 2 min ago; Echo is there.', 'Attic: no face has been seen; nobody is there.']);
    tracker.setPlaceLines(() => {
      throw new Error('boom');
    });
    expect(tracker.describe(now)).toBe(before);
  });
});

describe('camera presence default', () => {
  it('is on for a desktop room, off for this PC, and none for an offscreen place, until Kevin changes it', () => {
    expect(cameraPresenceOn({ node: 'room-1' })).toBe(true);
    expect(cameraPresenceOn({ node: 'local' })).toBe(false);
    expect(cameraPresenceOn({ node: 'offscreen', camera: true })).toBe(false);
    expect(cameraPresenceOn({ node: 'room-1', camera: false })).toBe(false);
    expect(cameraPresenceOn({ node: 'local', camera: true })).toBe(true);
    expect(cameraPresenceOn(null)).toBe(false);
  });
});

describe('greeting on arrival', () => {
  function setup(seen: Record<string, number | null>, now = 100_000) {
    const sent: Array<[string, unknown]> = [];
    const greet = createArrivalGreeting({ faceSeenAt: (placeId) => seen[placeId] ?? null, send: (avatarId, payload) => sent.push([avatarId, payload]), now: () => now });
    return { greet, sent };
  }

  it('waves for the avatar that arrived when a face was seen there in the last 30 s', () => {
    const { greet, sent } = setup({ study: 100_000 - 29_000 });
    expect(greet('sage', 'study')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('sage');
    expect(sent[0][1]).toMatchObject({ cue: 'greet_face', payload: { avatarId: 'sage' } });
  });

  it('does nothing for an old sighting, no sighting, or another place', () => {
    const { greet, sent } = setup({ study: 100_000 - 31_000, home: null, attic: 99_000 });
    expect(greet('sage', 'study')).toBe(false);
    expect(greet('sage', 'home')).toBe(false);
    expect(greet('sage', 'nowhere')).toBe(false);
    expect(sent).toEqual([]);
  });
});
