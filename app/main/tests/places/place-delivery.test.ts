import { describe, expect, it, vi } from 'vitest';
import { createPlaceDelivery } from '../../src/places/place-delivery.js';

function setup(locations: Record<string, string>, connected: string[] = ['study']) {
  const sent: Array<{ placeId: string; op: { op: string; [key: string]: unknown } }> = [];
  const local = { send: vi.fn(), isDestroyed: () => false };
  const broadcast = vi.fn();
  const delivery = createPlaceDelivery({
    places: () => ({ localPlaceId: () => 'home', locationOf: (id) => locations[id] ?? 'home' }),
    hub: () => ({
      deviceForPlace: (placeId) => (connected.includes(placeId) ? `device-${placeId}` : null),
      sendToPlace: (placeId, op) => (sent.push({ placeId, op }), connected.includes(placeId)),
    }),
    localSink: () => local,
    broadcastLocal: broadcast,
  });
  return { delivery, sent, local, broadcast };
}

describe('place delivery', () => {
  it('delivers a local place to bija\'s window', () => {
    const { delivery, local } = setup({});
    expect(delivery.sinkFor('home')).toBe(local);
  });

  it('delivers a desktop room to its satellite link, as an ipc event', () => {
    const { delivery, sent } = setup({});
    const sink = delivery.sinkFor('study');
    expect(sink).not.toBeNull();
    sink?.send('local-voice:event', { requestId: 'r1', type: 'sentence' });
    expect(sent).toEqual([{ placeId: 'study', op: { op: 'ipc', channel: 'local-voice:event', args: [{ requestId: 'r1', type: 'sentence' }] } }]);
    expect(sink?.isDestroyed()).toBe(false);
  });

  it('delivers nowhere when the satellite is not connected, or the place is offscreen', () => {
    const { delivery } = setup({}, []);
    expect(delivery.sinkFor('study')).toBeNull();
    expect(delivery.sinkFor('next-door')).toBeNull();
  });

  it('a sink notices when its satellite drops', () => {
    const connected = ['study'];
    const { delivery } = setup({}, connected);
    const sink = delivery.sinkFor('study');
    connected.length = 0;
    expect(sink?.isDestroyed()).toBe(true);
  });

  it('sends an avatar\'s event to the screen that shows it', () => {
    const { delivery, sent, broadcast } = setup({ sage: 'study', rex: 'next-door' });
    delivery.sendForAvatar('echo', 'local-voice:system-ready', { urgent: false });
    expect(broadcast).toHaveBeenCalledWith('local-voice:system-ready', { urgent: false });
    delivery.sendForAvatar('sage', 'local-voice:system-ready', { avatarId: 'sage' });
    expect(sent).toEqual([{ placeId: 'study', op: { op: 'ipc', channel: 'local-voice:system-ready', args: [{ avatarId: 'sage' }] } }]);
    delivery.sendForAvatar('rex', 'local-voice:system-ready', { avatarId: 'rex' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
  });
});
