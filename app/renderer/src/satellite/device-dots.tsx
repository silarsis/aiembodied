import type { DeviceGateState } from '../../../main/src/satellite/bridge-types.js';

const WORDS = { live: 'live', doorbell: 'doorbell only', off: 'off' } as const;

/**
 * Two small dots in a corner of the satellite window: the microphone and the camera. Green is live, amber is
 * doorbell only, grey is off. The words are there for screen readers and as a tooltip.
 */
export function DeviceDots({ gate }: { gate: DeviceGateState | null }) {
  const mic = gate?.mic ?? 'off';
  const camera = gate?.camera ?? 'off';
  const why = gate && mic === 'off' && gate.summary ? `: ${gate.summary}` : '';
  return (
    <div className="deviceDots" role="group" aria-label="Devices" data-testid="device-dots">
      <span className="deviceDot" data-level={mic} data-testid="mic-dot" title={`Microphone ${WORDS[mic]}${why}`} role="img" aria-label={`Microphone ${WORDS[mic]}${why}`} />
      <span className="deviceDot" data-level={camera} data-testid="camera-dot" title={`Camera ${WORDS[camera]}`} role="img" aria-label={`Camera ${WORDS[camera]}`} />
    </div>
  );
}
