import { cameraOffByDefault, type PlaceKind } from './place-kind.js';

/**
 * A place's "Camera presence" setting. The camera only ever reports "a face was seen at t" (no picture leaves the
 * PC, nothing is stored). A desktop room defaults to on, because a character in it is meant to notice who walks
 * in; bija's own place defaults to off, because it films the desk Kevin works at, so he opts in. A phone or a
 * browser room also defaults to off: nobody propped a phone up to watch the room, so Kevin opts in. An offscreen
 * place has no camera at all.
 */
export interface CameraSettingPlace {
  node: string;
  /** Only on a phone or a browser room. */
  kind?: PlaceKind;
  /** Saved only when Kevin changed it. */
  camera?: boolean;
}

export function cameraPresenceOn(place: CameraSettingPlace | null | undefined): boolean {
  if (!place || place.node === 'offscreen') return false;
  if (typeof place.camera === 'boolean') return place.camera;
  return place.node !== 'local' && !cameraOffByDefault(place);
}
