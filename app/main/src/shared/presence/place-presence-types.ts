// Types only: shared/ holds what the main process and the renderer both need.

export interface PlaceDeviceState {
  mic: string;
  camera: string;
  speakers: string;
  locked: boolean;
  closed: boolean;
  /** Another app is full screen on that PC, so its devices are off for now. */
  fullscreen: boolean;
}
