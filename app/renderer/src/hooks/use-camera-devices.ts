import { useCallback, useEffect, useState } from 'react';

export interface CameraChoice {
  deviceId: string;
  label: string;
}

export const CAMERA_DEVICE_KEY = 'aiembodied.cameraDeviceId';

function readSaved(): string {
  try {
    return window.localStorage.getItem(CAMERA_DEVICE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * The cameras on this PC and the one Kevin picked for camera presence. The pick is kept on this PC only
 * (localStorage), because a camera id means nothing on another PC. Empty means the system default.
 */
export function useCameraDevices() {
  const [cameras, setCameras] = useState<CameraChoice[]>([]);
  const [deviceId, setDeviceIdState] = useState(readSaved);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((device) => device.kind === 'videoinput').map((device) => ({ deviceId: device.deviceId, label: device.label || 'Camera' })));
    } catch {
      setCameras([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
    void refresh();
    const media = navigator.mediaDevices;
    if (!media || typeof media.addEventListener !== 'function') return undefined;
    const onChange = () => void refresh();
    media.addEventListener('devicechange', onChange);
    return () => media.removeEventListener('devicechange', onChange);
  }, [refresh]);

  const setDeviceId = useCallback((next: string) => {
    setDeviceIdState(next);
    try {
      if (next) window.localStorage.setItem(CAMERA_DEVICE_KEY, next);
      else window.localStorage.removeItem(CAMERA_DEVICE_KEY);
    } catch {
      // Not saved; it still applies until the app closes.
    }
  }, []);

  return { cameras, deviceId, setDeviceId };
}
