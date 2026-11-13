import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getPreloadApi, type PreloadApi } from '../preload-api.js';
import { SatelliteContext } from './satellite-context.js';
import { ConnectScreen } from './connect-screen.js';
import { useSatelliteStatus } from './use-satellite-status.js';
import type { SatelliteBridge, SatelliteStatus } from '../../../main/src/satellite/bridge-types.js';

type Role = 'loading' | 'full' | 'satellite';

/** Waits a little for the preload bridge, then asks the config which role this PC has. */
function useRole(): { role: Role; api: PreloadApi | undefined } {
  const [state, setState] = useState<{ role: Role; api: PreloadApi | undefined }>({ role: 'loading', api: undefined });
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const look = () => {
      if (cancelled) return;
      const api = getPreloadApi();
      if (!api?.config) {
        // No bridge (a build without the preload script, or it is still attaching): the full app reports that itself.
        attempts += 1;
        if (attempts > 20) setState({ role: 'full', api: undefined });
        else setTimeout(look, 50);
        return;
      }
      api.config
        .get()
        .then((config) => {
          if (!cancelled) setState({ role: config?.role === 'satellite' ? 'satellite' : 'full', api });
        })
        .catch(() => {
          if (!cancelled) setState({ role: 'full', api });
        });
    };
    look();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function Waiting({ status, bridge }: { status: SatelliteStatus; bridge: SatelliteBridge }) {
  const refused = status.link === 'refused';
  return (
    <main className="connectScreen" data-testid="satellite-waiting">
      <div className="connectScreen__card" role="status">
        <h1>{refused ? 'bija does not know this PC' : status.link === 'offline' ? 'Lost touch with bija. Trying again…' : 'Connecting to bija…'}</h1>
        {status.hubUrl ? <p className="connectScreen__help">{status.hubUrl}</p> : null}
        {refused && status.lastError ? <p className="connectScreen__error">{status.lastError}</p> : null}
        <button type="button" className="btn btn--secondary" onClick={() => void bridge.forget()}>
          Forget this pairing
        </button>
      </div>
    </main>
  );
}

/**
 * Wraps the app. On the full app it does nothing. On a satellite PC it shows "Connect to bija" until this PC is paired,
 * waits for the first connection (the app asks bija for everything at start-up), then shows the app with the
 * satellite's state in a context. Forgetting the pairing takes the app away again, so a new pairing starts it fresh.
 */
export function SatelliteGate({ children }: { children: ReactNode }) {
  const { role, api } = useRole();
  const bridge = role === 'satellite' ? api?.satellite : undefined;
  const status = useSatelliteStatus(bridge);
  const everOnline = useRef(false);
  if (!status?.paired) everOnline.current = false;
  else if (status.link === 'online') everOnline.current = true;

  if (role === 'loading') return null;
  if (role === 'full') return <>{children}</>;
  if (!bridge || !status) return null;
  if (!status.paired) return <ConnectScreen bridge={bridge} status={status} />;
  if (!everOnline.current) return <Waiting status={status} bridge={bridge} />;
  return (
    <SatelliteContext.Provider value={{ status, bridge }} key={`${status.hubUrl}|${status.deviceName}`}>
      {children}
    </SatelliteContext.Provider>
  );
}
