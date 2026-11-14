import { useEffect, useRef, useState } from 'react';
import type { DeviceGateBridge, DeviceGateState } from '../../../main/src/satellite/bridge-types.js';

/**
 * Follows the satellite's privacy gate (which lives in the main process). Null until the first answer, and on the
 * full app. When the gate closes, `onClose` runs first so every capture track is stopped at once; only then
 * does the page tell main that capture stopped. If it does not, main reloads the page. The camera has its own rule:
 * when it was live and no longer is (the room's camera setting went off, or the whole gate closed), `onClose`
 * runs for it too, without touching the mic.
 */
export interface CloseScope {
  /** The mic is no longer allowed: stop the audio graph. */
  audio: boolean;
  /** The camera is no longer allowed: stop and release it. */
  camera: boolean;
}

export function useDeviceGate(bridge: DeviceGateBridge | undefined, onClose: (scope: CloseScope) => Promise<void> | void): DeviceGateState | null {
  const [state, setState] = useState<DeviceGateState | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!bridge) return undefined;
    let cancelled = false;
    let cameraWasLive = false;
    let pushed = false;
    const apply = (next: DeviceGateState) => {
      if (cancelled) return;
      pushed = true;
      setState(next);
      // The doorbell listens in the main process; the page's own microphone is only for a room with an avatar in it.
      const audio = !next.micAllowed;
      const camera = cameraWasLive && next.camera !== 'live';
      cameraWasLive = next.camera === 'live';
      // The mic closing closes the camera too (the camera needs everything the mic needs).
      if (audio || camera) {
        // Stop first, then say so. Done on every "off" push, so a repeat is harmless.
        void Promise.resolve(onCloseRef.current({ audio, camera: camera || audio }))
          .catch((error: unknown) => console.warn('Could not stop capture', error))
          .finally(() => void bridge.captureStopped().catch(() => undefined));
      }
    };
    const off = bridge.onChanged(apply);
    bridge
      .get()
      .then((first) => {
        if (cancelled) return;
        // A push that arrived while the first read was on its way is newer.
        if (!pushed) cameraWasLive = first.camera === 'live';
        setState((current) => current ?? first);
      })
      .catch((error: unknown) => console.warn('Could not read the device gate', error));
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);
  return state;
}
