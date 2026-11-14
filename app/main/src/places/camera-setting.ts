/**
 * A place's "Camera presence" setting. The camera only ever reports "a face was seen at t" (no picture leaves the
 * PC, nothing is stored). A desktop room defaults to on, because a character in it is meant to notice who walks
 * in; bija's own place defaults to off, because it films the desk Kevin works at, so he opts in. An offscreen
 * place has no camera at all.
 */
export interface CameraSettingPlace {
  node: string;
  /** Saved only when Kevin changed it. */
  camera?: boolean;
}

export function cameraPresenceOn(place: CameraSettingPlace | null | undefined): boolean {
  if (!place || place.node === 'offscreen') return false;
  if (typeof place.camera === 'boolean') return place.camera;
  return place.node !== 'local';
}
