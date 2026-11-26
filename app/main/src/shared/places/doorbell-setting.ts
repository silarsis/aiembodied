/**
 * A place's "Doorbell" setting: while nobody is at the place, its wake word still listens, and hearing it calls an
 * avatar over. bija's own place defaults to on (the wake word has always listened there); a desktop room defaults to
 * off, because its mic is behind the privacy gate and Kevin should choose to open it for the doorbell. An offscreen
 * place has no mic at all.
 */
export interface DoorbellSettingPlace {
  node: string;
  /** Saved only when Kevin changed it. */
  doorbell?: boolean;
}

export function doorbellOn(place: DoorbellSettingPlace | null | undefined): boolean {
  if (!place || place.node === 'offscreen') return false;
  if (typeof place.doorbell === 'boolean') return place.doorbell;
  return place.node === 'local';
}
