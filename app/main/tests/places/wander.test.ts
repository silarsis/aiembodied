import { describe, expect, it } from 'vitest';
import { ACTIVE_WINDOW_MS, CONVERSATION_MS, WANDER_COOLDOWN_MS, normalisePlaceName, wanderRefusal, type WanderView } from '../../src/places/wander.js';

const NOW = 10_000_000;

/** echo at home; the study is online with sage in it and a recently used PC. */
function view(patch: Partial<WanderView> = {}): WanderView {
  return {
    places: [
      { id: 'home', name: 'the lounge', node: 'local' },
      { id: 'next-door', name: 'next door', node: 'offscreen' },
      { id: 'study', name: 'the study', node: 'room-1', online: true },
    ],
    locations: { echo: 'home', sage: 'next-door' },
    transit: [],
    now: NOW,
    movedAt: {},
    activeAt: { study: NOW - 60_000 },
    ...patch,
  };
}

describe('wanderRefusal', () => {
  it('lets an avatar go where someone used the PC lately', () => {
    expect(wanderRefusal(view(), 'echo', 'the study')).toBeNull();
    expect(wanderRefusal(view(), 'echo', 'study')).toBeNull();
    expect(wanderRefusal(view(), 'echo', 'The Study')).toBeNull();
  });

  it('(a) refuses an avatar that changed place in the last 10 minutes, and allows it after', () => {
    expect(wanderRefusal(view({ movedAt: { echo: NOW - WANDER_COOLDOWN_MS + 1 } }), 'echo', 'study')).toBe('moved recently');
    expect(wanderRefusal(view({ movedAt: { echo: NOW - WANDER_COOLDOWN_MS } }), 'echo', 'study')).toBeNull();
    // Someone else's move does not matter.
    expect(wanderRefusal(view({ movedAt: { sage: NOW - 1000 } }), 'echo', 'study')).toBeNull();
  });

  it('(b) refuses a place that is offline or closed', () => {
    const places = (patch: object) => view().places.map((place) => (place.id === 'study' ? { ...place, ...patch } : place));
    expect(wanderRefusal(view({ places: places({ online: false }) }), 'echo', 'study')).toBe('the study is closed');
    expect(wanderRefusal(view({ places: places({ closed: true }) }), 'echo', 'study')).toBe('the study is closed');
  });

  it('(c) needs someone to have used the PC in the last 10 minutes, or another avatar there', () => {
    expect(wanderRefusal(view({ activeAt: { study: NOW - ACTIVE_WINDOW_MS - 1 } }), 'echo', 'study')).toBe('nobody is there');
    expect(wanderRefusal(view({ activeAt: {} }), 'echo', 'study')).toBe('nobody is there');
    expect(wanderRefusal(view({ activeAt: {}, locations: { echo: 'home', sage: 'study' } }), 'echo', 'study')).toBeNull();
    // An avatar still walking there is not "there".
    expect(wanderRefusal(view({ activeAt: {}, locations: { echo: 'home', sage: 'study' }, transit: [{ avatarId: 'sage', from: 'next-door', to: 'study' }] }), 'echo', 'study')).toBe('nobody is there');
  });

  it('(d) refuses an avatar that is speaking or that Kevin spoke with in the last 2 minutes', () => {
    expect(wanderRefusal(view(), 'echo', 'study', { speaking: true })).toBe('speaking');
    expect(wanderRefusal(view(), 'echo', 'study', { talkedAgoMs: CONVERSATION_MS - 1 })).toBe('in conversation');
    expect(wanderRefusal(view(), 'echo', 'study', { talkedAgoMs: CONVERSATION_MS })).toBeNull();
    expect(wanderRefusal(view(), 'echo', 'study', { talkedAgoMs: null })).toBeNull();
  });

  it('refuses an unknown place, the place it is at, and an avatar that is already moving', () => {
    expect(wanderRefusal(view(), 'echo', 'the moon')).toBe('unknown place');
    expect(wanderRefusal(view(), 'echo', 'lounge')).toBe('already there');
    expect(wanderRefusal(view({ transit: [{ avatarId: 'echo', from: 'home', to: 'next-door' }] }), 'echo', 'study')).toBe('already moving');
  });

  it('matches names the way the place manager does', () => {
    expect(normalisePlaceName('The Next-Door')).toBe('next door');
  });
});
