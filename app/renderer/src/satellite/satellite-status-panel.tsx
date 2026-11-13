import { useState } from 'react';
import type { SatelliteBridge, SatelliteStatus } from '../../../main/src/satellite/bridge-types.js';

const LINK_WORDS: Record<SatelliteStatus['link'], string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  online: 'Online',
  offline: 'Lost touch with bija. Trying again…',
  refused: 'Refused by bija',
};

/** The satellite's Status page: the link, which room this is, which bija, the devices, and "Forget this pairing". */
export function SatelliteStatusPanel({ status, bridge }: { status: SatelliteStatus; bridge: SatelliteBridge }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forget = async () => {
    setError(null);
    try {
      await bridge.forget();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not forget the pairing.');
    }
  };
  return (
    <section className="satelliteStatus" data-testid="satellite-status">
      <dl className="satelliteStatus__rows">
        <div>
          <dt>Link</dt>
          <dd data-testid="satellite-link">{LINK_WORDS[status.link]}</dd>
        </div>
        <div>
          <dt>This room</dt>
          <dd>{status.placeName ?? 'Not named yet'}</dd>
        </div>
        <div>
          <dt>bija</dt>
          <dd>{status.hubUrl ?? 'Not paired'}</dd>
        </div>
        <div>
          <dt>This PC</dt>
          <dd>{status.deviceName ?? status.hostname}</dd>
        </div>
        <div>
          <dt>Devices</dt>
          <dd>Microphone off, camera off. They come in a later update; for now, type to the characters.</dd>
        </div>
      </dl>
      {status.lastError ? (
        <p className="kiosk__helper" role="alert">
          {status.lastError}
        </p>
      ) : null}
      <p className="kiosk__helper">F11 switches between a window and full screen.</p>
      {confirming ? (
        <div className="satelliteStatus__confirm">
          <p>Forget bija on this PC? You will need a new code to connect again.</p>
          <button type="button" className="btn" onClick={() => void forget()}>
            Yes, forget it
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn--secondary" onClick={() => setConfirming(true)}>
          Forget this pairing
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
