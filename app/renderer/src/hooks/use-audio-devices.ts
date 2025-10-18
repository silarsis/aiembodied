import { useCallback, useEffect, useState } from 'react';

export interface AudioDeviceSelection {
  deviceId: string;
  label: string;
}

interface AudioDevicesState {
  inputs: AudioDeviceSelection[];
  outputs: AudioDeviceSelection[];
}

export function useAudioDevices() {
  const [devices, setDevices] = useState<AudioDevicesState>({ inputs: [], outputs: [] });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDevices({ inputs: [], outputs: [] });
      setError('Media devices enumeration is not supported in this environment.');
      return;
    }

    try {
      const mediaDevices = await navigator.mediaDevices.enumerateDevices();
      const inputs: AudioDeviceSelection[] = [];
      const outputs: AudioDeviceSelection[] = [];

      for (const device of mediaDevices) {
        if (device.kind === 'audioinput') {
          inputs.push({ deviceId: device.deviceId, label: device.label || 'Microphone' });
        } else if (device.kind === 'audiooutput') {
          outputs.push({ deviceId: device.deviceId, label: device.label || 'Speaker' });
        }
      }

      setDevices({ inputs, outputs });
      setError(null);
    } catch (deviceError) {
      const message =
        deviceError instanceof Error ? deviceError.message : 'Failed to enumerate audio devices.';
      setDevices({ inputs: [], outputs: [] });
      setError(message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();

    const handleDeviceChange = () => {
      void refresh();
    };

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) {
      return;
    }

    if (typeof mediaDevices.addEventListener === 'function') {
      mediaDevices.addEventListener('devicechange', handleDeviceChange);
      return () => {
        mediaDevices.removeEventListener('devicechange', handleDeviceChange);
      };
    }

    const originalHandler = mediaDevices.ondevicechange;
    mediaDevices.ondevicechange = handleDeviceChange;
    return () => {
      mediaDevices.ondevicechange = originalHandler;
    };
  }, [refresh]);

  return { ...devices, refresh, error };
}
