import type { SatelliteBridge, SatelliteStatus } from '../../../main/src/satellite/bridge-types.js';

/**
 * Shown over the stage while the link to bija is down. The avatars keep playing their saved idle clips; nobody can be
 * talked to until bija is back. When bija refused this PC (it was removed there), the banner says so and offers Forget.
 */
export function SatelliteBanner({ status, bridge }: { status: SatelliteStatus; bridge: SatelliteBridge }) {
  if (status.link === 'online') return null;
  const refused = status.link === 'refused';
  return (
    <div className="satelliteBanner" role="status" data-testid="satellite-banner" data-state={status.link}>
      <span>{refused ? `bija says no: ${status.lastError ?? 'this PC was removed.'}` : 'Lost touch with bija. Trying again…'}</span>
      {refused ? (
        <button type="button" className="btn btn--secondary" onClick={() => void bridge.forget()}>
          Forget this pairing
        </button>
      ) : null}
    </div>
  );
}
