/**
 * Where events for a place are delivered. Every avatar is in one place, and the screen that draws that place
 * must get the events about it: bija's window for the local place, the satellite's link for a desktop room,
 * and nobody for an offscreen place (nobody sees it).
 *
 * Pure: the window and the hub come in as small interfaces so the routing can be tested.
 */

/** What a floor or a voice turn needs from a destination: send an event, and know when it is gone. */
export interface EventSink {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

export interface DeliveryPlaces {
  localPlaceId(): string;
  locationOf(avatarId: string): string;
}

export interface DeliveryHub {
  deviceForPlace(placeId: string): string | null;
  sendToPlace(placeId: string, op: { op: string; [key: string]: unknown }): boolean;
}

export interface PlaceDeliveryOptions {
  places: () => DeliveryPlaces | null;
  hub: () => DeliveryHub | null;
  /** bija's window: the latest sender of Kevin's, for events the floor starts. */
  localSink: () => EventSink | null;
  /** Sends to every window of this PC. */
  broadcastLocal: (channel: string, payload: unknown) => void;
}

export interface PlaceDelivery {
  /** The destination for events of a place's turns (answers, chatter). Null when nobody draws it right now. */
  sinkFor(placeId: string): EventSink | null;
  /** An event about an avatar goes to the screen that shows it. */
  sendForAvatar(avatarId: string, channel: string, payload: unknown): void;
}

export function createPlaceDelivery(options: PlaceDeliveryOptions): PlaceDelivery {
  const sinkFor = (placeId: string): EventSink | null => {
    const places = options.places();
    if (!places || placeId === places.localPlaceId()) return options.localSink();
    const hub = options.hub();
    if (!hub || !hub.deviceForPlace(placeId)) return null;
    return {
      send: (channel, ...args) => void hub.sendToPlace(placeId, { op: 'ipc', channel, args }),
      isDestroyed: () => !hub.deviceForPlace(placeId),
    };
  };
  const sendForAvatar = (avatarId: string, channel: string, payload: unknown): void => {
    const places = options.places();
    if (!places) {
      options.broadcastLocal(channel, payload);
      return;
    }
    const placeId = places.locationOf(avatarId);
    if (placeId === places.localPlaceId()) {
      options.broadcastLocal(channel, payload);
      return;
    }
    options.hub()?.sendToPlace(placeId, { op: 'ipc', channel, args: [payload] });
  };
  return { sinkFor, sendForAvatar };
}
