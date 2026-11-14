import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATIONS_KEY, PlaceManager } from '../../src/places/place-manager.js';
import { URGENT_QUIET_MS, URGENT_WAIT_MS, urgentTarget, walkToKevin } from '../../src/places/urgent-walk.js';
import { createPlaceDelivery } from '../../src/places/place-delivery.js';
import { LocalOnlyBus } from '../../src/switchboard/bus.js';
import { makeEventId } from '../../src/switchboard/client.js';
import { AvatarInbox } from '../../src/switchboard/inbox.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];
const NOW = 8_000_000;

function setup(locations: Record<string, string>, activeAt: Record<string, number>) {
  const data = new Map<string, string>([[LOCATIONS_KEY, JSON.stringify(locations)]]);
  const places = new PlaceManager({
    store: { getValue: (key) => data.get(key) ?? null, setValue: (key, value) => void data.set(key, value) },
    registry: { list: () => PROFILES },
    now: () => NOW,
    activeAt: (placeId) => activeAt[placeId] ?? null,
  });
  places.addPlace({ id: 'study', name: 'the study', node: 'room-1' });
  places.setOnline('study', true);
  return places;
}

describe('urgentTarget', () => {
  it('stays when someone used the avatar\'s own PC in the last 2 minutes', () => {
    const places = setup({ echo: 'home' }, { home: NOW - URGENT_QUIET_MS + 1000, study: NOW - 1000 });
    expect(urgentTarget(places.snapshot(), 'echo')).toBeNull();
  });

  it('goes where someone is when nobody used its own PC lately and another PC was used', () => {
    const places = setup({ echo: 'home' }, { home: NOW - URGENT_QUIET_MS - 1000, study: NOW - 30_000 });
    expect(urgentTarget(places.snapshot(), 'echo')).toBe('study');
    // Next door has no PC: an avatar there is fetched too.
    const away = setup({ echo: 'next-door' }, { home: NOW - 5000 });
    expect(urgentTarget(away.snapshot(), 'echo')).toBe('home');
  });

  it('stays when no PC was used lately, or the used one is closed', () => {
    expect(urgentTarget(setup({ echo: 'home' }, {}).snapshot(), 'echo')).toBeNull();
    const closed = setup({ echo: 'home' }, { study: NOW - 1000 });
    closed.setClosed('study', true);
    expect(urgentTarget(closed.snapshot(), 'echo')).toBeNull();
  });

  it('picks the PC used most recently', () => {
    const places = setup({ echo: 'next-door' }, { home: NOW - 90_000, study: NOW - 10_000 });
    expect(urgentTarget(places.snapshot(), 'echo')).toBe('study');
  });
});

describe('urgent news walks to Kevin, then speaks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('moves the avatar, waits for it to arrive, and only then says the news; delivery follows the avatar', async () => {
    const places = setup({ echo: 'home' }, { home: NOW - 10 * 60_000, study: NOW - 5000 });
    const sent: Array<{ placeId: string; channel: string }> = [];
    const delivery = createPlaceDelivery({
      places: () => places,
      hub: () => ({ deviceForPlace: () => 'device-1', sendToPlace: (placeId, op) => (sent.push({ placeId, channel: String(op.channel) }), true) }),
      localSink: () => null,
      broadcastLocal: (channel) => void sent.push({ placeId: 'home', channel }),
    });
    const order: string[] = [];
    const bus = new LocalOnlyBus(makeEventId);
    const inbox = new AvatarInbox({
      avatarId: 'echo',
      bus,
      notify: (text) => {
        order.push(`said:${text}@${places.locationOf('echo')}`);
        // What the voice service does when it has something to say: tell the screen that shows the avatar.
        delivery.sendForAvatar('echo', 'local-voice:system-ready', {});
      },
      beforeUrgent: () => walkToKevin(places, 'echo'),
    });
    inbox.start();
    bus.publish({ type: 'avatar.inbox', producer: { kind: 'service', id: 'app' }, to: ['avatar:echo'], priority: 'urgent', payload: { text: 'The oven is on' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    expect(places.snapshot().transit).toEqual([{ avatarId: 'echo', from: 'home', to: 'study' }]);
    places.arrived('echo');
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['said:The oven is on@study']);
    // The announcement went to the satellite that now shows Echo (bija-started turns follow the avatar).
    expect(sent).toEqual([{ placeId: 'study', channel: 'local-voice:system-ready' }]);
  });

  it('says it anyway after 10 seconds when the avatar never arrives', async () => {
    const places = setup({ echo: 'home' }, { home: NOW - 10 * 60_000, study: NOW - 5000 });
    const notify = vi.fn();
    const bus = new LocalOnlyBus(makeEventId);
    new AvatarInbox({ avatarId: 'echo', bus, notify, beforeUrgent: () => walkToKevin(places, 'echo') }).start();
    bus.publish({ type: 'home.alert', producer: { kind: 'service', id: 'app' }, to: ['avatar:echo'], payload: { text: 'Smoke' } });
    await vi.advanceTimersByTimeAsync(URGENT_WAIT_MS - 100);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('is unchanged when nobody needs to walk, and for news that is not urgent', async () => {
    const places = setup({ echo: 'home' }, { home: NOW - 1000 });
    const notify = vi.fn();
    const beforeUrgent = vi.fn(() => walkToKevin(places, 'echo'));
    const bus = new LocalOnlyBus(makeEventId);
    new AvatarInbox({ avatarId: 'echo', bus, notify, beforeUrgent, deliberate: async () => ({ action: 'speak-idle', reason: 'test' }) }).start();
    bus.publish({ type: 'home.alert', producer: { kind: 'service', id: 'app' }, to: ['avatar:echo'], payload: { text: 'Smoke' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(places.snapshot().transit).toEqual([]);
    bus.publish({ type: 'avatar.inbox', producer: { kind: 'service', id: 'app' }, to: ['avatar:echo'], priority: 'normal', payload: { text: 'later' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(beforeUrgent).toHaveBeenCalledTimes(1);
  });

  it('speaks even when the walk throws', async () => {
    const notify = vi.fn();
    const bus = new LocalOnlyBus(makeEventId);
    new AvatarInbox({ avatarId: 'echo', bus, notify, beforeUrgent: () => Promise.reject(new Error('boom')), logger: { warn: vi.fn() } }).start();
    bus.publish({ type: 'home.alert', producer: { kind: 'service', id: 'app' }, to: ['avatar:echo'], payload: { text: 'Smoke' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
