/**
 * What kind of device draws a place. A desktop room is another PC; a phone room is the Android app; a browser room
 * is any web page. Only a paired device place has a kind, and an older place with none is a desktop. In its own file
 * because the renderer imports it too (no Node, no Electron).
 */
export type PlaceKind = 'desktop' | 'phone' | 'browser';

export function cleanPlaceKind(value: unknown): PlaceKind {
  return value === 'phone' || value === 'browser' ? value : 'desktop';
}

/** A phone is for being found, not for being visited: nobody wanders in by themselves (places/wander.ts). */
export function isPhonePlace(place: { kind?: PlaceKind } | null | undefined): boolean {
  return place?.kind === 'phone';
}

/** A small screen that is not always watched: the camera starts off there, the same as on a browser. */
export function cameraOffByDefault(place: { kind?: PlaceKind } | null | undefined): boolean {
  return place?.kind === 'phone' || place?.kind === 'browser';
}
