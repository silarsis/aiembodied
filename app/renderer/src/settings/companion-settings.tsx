import { useEffect, useState } from 'react';
import type { ProviderSettings } from '../../../main/src/config/provider-settings.js';
import type { CompanionStatus } from '../../../main/src/companion/types.js';
import type { CompanionBridge } from '../preload-api.js';

/** Live state of the phone companion server: addresses, pairing code and connected phones. */
export function useCompanionStatus(bridge?: CompanionBridge): [CompanionStatus | null, (status: CompanionStatus) => void] {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    bridge
      .getStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onStatus((next) => setStatus(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);
  return [status, setStatus];
}

export function CompanionSettings({
  draft,
  onChange,
  bridge,
  disabled,
}: {
  draft: ProviderSettings['companion'];
  onChange(value: Partial<ProviderSettings['companion']>): void;
  bridge?: CompanionBridge;
  disabled: boolean;
}) {
  const [status, setStatus] = useCompanionStatus(bridge);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [portText, setPortText] = useState(String(draft.port));
  const [lastDraftPort, setLastDraftPort] = useState(draft.port);
  if (draft.port !== lastDraftPort) {
    setLastDraftPort(draft.port);
    setPortText(String(draft.port));
  }

  const run = async (action: () => Promise<string | null>) => {
    setNotice(null);
    try {
      setNotice(await action());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const connected = status?.devices.filter((device) => device.connected) ?? [];
  return (
    <>
      <div className="control">
        <label htmlFor="settings-companion-enabled">
          <input
            id="settings-companion-enabled"
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
            disabled={disabled}
          />{' '}
          Let a phone be the avatar (android-companion app)
        </label>
      </div>
      <div className="control">
        <label htmlFor="settings-companion-port">Port</label>
        <input
          id="settings-companion-port"
          type="number"
          min={1024}
          max={65535}
          value={portText}
          onChange={(event) => {
            setPortText(event.target.value);
            const port = Number(event.target.value);
            if (Number.isInteger(port) && port >= 1024 && port <= 65535) onChange({ port });
          }}
          disabled={disabled}
        />
      </div>
      <p className="kiosk__helper">
        The phone shows this avatar and background and talks through this computer, over the home network. Away from
        home, use Tailscale (or another VPN) rather than opening the port to the internet. Windows may ask to allow the
        app through the firewall the first time.
      </p>
      {status?.enabled ? (
        status.running ? (
          <>
            <p className="kiosk__helper">
              Phone address{status.urls.length === 1 ? '' : 'es'}:{' '}
              {status.urls.length > 0 ? status.urls.map((url) => <code key={url}>{url.replace(/^http:\/\//, '')} </code>) : 'no network found'}
            </p>
            <p className="kiosk__helper">
              Pairing code: <code data-testid="companion-code">{status.pairingCode}</code>{' '}
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    if (!bridge) return null;
                    setStatus(await bridge.rotatePairingCode());
                    return 'New code made. Phones paired with the old one have to enter it again.';
                  })
                }
              >
                New code
              </button>
            </p>
          </>
        ) : (
          <p className="kiosk__error" role="alert">
            {status.error ?? 'The phone companion is not running.'}
          </p>
        )
      ) : null}
      {status && status.devices.length > 0 ? (
        <ul className="companionDevices">
          {status.devices.map((device) => (
            <li key={device.id}>
              <span aria-label={device.connected ? 'connected' : 'not connected'}>{device.connected ? '🟢' : '⚪'}</span>{' '}
              {device.name}
              {device.address ? ` (${device.address})` : ''}
              {device.connected ? '' : `, last seen ${new Date(device.lastSeen).toLocaleString()}`}{' '}
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    if (!bridge) return null;
                    setStatus(await bridge.forgetDevice(device.id));
                    return `Forgot ${device.name}. It can pair again with the code.`;
                  })
                }
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {connected.length > 0 ? (
        <form
          className="control"
          onSubmit={(event) => {
            event.preventDefault();
            const text = message.trim();
            if (!text || !bridge) return;
            void run(async () => {
              const result = await bridge.say({ text });
              setMessage('');
              return result.delivered.length > 0 ? `Said on ${result.delivered.length} phone(s).` : 'No phone is connected.';
            });
          }}
        >
          <label htmlFor="settings-companion-say">Say something on the phone</label>
          <input id="settings-companion-say" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Dinner's ready!" />
          <button type="submit" disabled={!message.trim()}>
            Say it
          </button>
        </form>
      ) : null}
      {notice ? <p className="kiosk__info">{notice}</p> : null}
    </>
  );
}
