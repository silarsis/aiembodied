import { useEffect, useRef, useState } from 'react';
import type { DeviceGateBridge, DeviceGateState } from '../../../main/src/satellite/bridge-types.js';

/**
 * Follows the satellite's privacy gate (which lives in the main process). Null until the first answer, and on the
 * full app. When the gate closes, `onClose` runs first so every capture track is stopped at once; only then
 * does the page tell main that capture stopped. If it does not, main reloads the page.
 */
export function useDeviceGate(bridge: DeviceGateBridge | undefined, onClose: () => Promise<void> | void): DeviceGateState | null {
  const [state, setState] = useState<DeviceGateState | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!bridge) return undefined;
    let cancelled = false;
    const apply = (next: DeviceGateState) => {
      if (cancelled) return;
      setState(next);
      const allowed = next.micAllowed || next.doorbell;
      if (!allowed) {
        // Stop first, then say so. Done on every "off" push, so a repeat is harmless.
        void Promise.resolve(onCloseRef.current())
          .catch((error: unknown) => console.warn('Could not stop capture', error))
          .finally(() => void bridge.captureStopped().catch(() => undefined));
      }
    };
    const off = bridge.onChanged(apply);
    bridge
      .get()
      .then((first) => {
        if (!cancelled) setState((current) => current ?? first);
      })
      .catch((error: unknown) => console.warn('Could not read the device gate', error));
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);
  return state;
}
