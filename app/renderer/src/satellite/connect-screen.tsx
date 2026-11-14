import { useState, type FormEvent } from 'react';
import type { SatelliteBridge, SatelliteStatus } from '../../../main/src/satellite/bridge-types.js';

export const DEFAULT_HUB_ADDRESS = 'ws://bija:8791';
export const DEFAULT_ROOM_NAME = 'the study';

/**
 * The first screen of a satellite PC: type where bija is and the 6-digit code from bija's Settings > Places >
 * "Add a desktop room", and name this room and this PC. Errors from bija are shown under the form.
 */
export function ConnectScreen({ bridge, status }: { bridge: SatelliteBridge; status: SatelliteStatus }) {
  const web = status.deviceKind === 'browser';
  // A page the hub served offers the hub's own address; the Electron app offers bija by name.
  const [hubUrl, setHubUrl] = useState(status.suggestedHubUrl || DEFAULT_HUB_ADDRESS);
  const [code, setCode] = useState('');
  const [placeName, setPlaceName] = useState(DEFAULT_ROOM_NAME);
  const [deviceName, setDeviceName] = useState(status.hostname);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(status.lastError);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.pair({ hubUrl, code: code.trim(), placeName, deviceName });
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="connectScreen" data-testid="connect-screen">
      <form className="connectScreen__card" onSubmit={submit}>
        <h1>Connect to bija</h1>
        <p className="connectScreen__help">
          {web ? 'This page will show one room of bija\u2019s world.' : 'This PC will show one room of bija\u2019s world.'} On bija, open Settings, Places, Add a desktop room, and type the code it shows.
        </p>
        <label className="connectScreen__field">
          <span>bija&apos;s address</span>
          <input value={hubUrl} onChange={(event) => setHubUrl(event.target.value)} spellCheck={false} autoComplete="off" />
        </label>
        <label className="connectScreen__field">
          <span>6-digit code</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="123456"
            aria-label="6-digit code"
          />
        </label>
        <label className="connectScreen__field">
          <span>This room&apos;s name</span>
          <input value={placeName} onChange={(event) => setPlaceName(event.target.value)} autoComplete="off" />
        </label>
        <label className="connectScreen__field">
          <span>{web ? 'This browser\u2019s name' : 'This PC\u2019s name'}</span>
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} autoComplete="off" />
        </label>
        <button type="submit" className="btn" disabled={busy || code.trim().length !== 6 || !hubUrl.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        {error ? (
          <p className="connectScreen__error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
