import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Place, PlacesSnapshot } from '../../../main/src/places/place-manager.js';
import { deviceSummary } from './room-devices-status.js';
import type { PairingStart, RoomHubBridge, RoomHubStatus } from '../../../main/src/room-hub/bridge-types.js';

const DEFAULT_ROOM_NAME = 'the study';

function kindOf(place: Place): string {
  if (place.node === 'local') return 'This PC';
  if (place.node === 'offscreen') return 'Next door';
  return 'Desktop room';
}

function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Settings > Places: every place and who is there, the desktop rooms that are paired (with a Revoke button),
 * and "Add a desktop room", which shows a one-time code to type on the other PC.
 * `active` is true while the pop-up is open, so the status is read each time it opens.
 */
export interface RoomChoice {
  id: string;
  name: string;
  /** '3D room' or 'Background'. */
  kind: string;
}

export function PlacesPanel({
  roomHub,
  snapshot,
  nameOf,
  active,
  roomChoices = [],
}: {
  roomHub?: RoomHubBridge;
  snapshot: PlacesSnapshot | null;
  nameOf: (avatarId: string) => string;
  active: boolean;
  /** The rooms and backgrounds this PC has, for a desktop room to pick what it draws. */
  roomChoices?: RoomChoice[];
}) {
  const [status, setStatus] = useState<RoomHubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingStart | null>(null);
  /** The code the hub last reported as active. Only after that does "no active code" mean it was used up. */
  const [seenCode, setSeenCode] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!roomHub) return undefined;
    let cancelled = false;
    const off = roomHub.onChanged((next) => {
      if (cancelled) return;
      setStatus(next);
      if (next.pairing) setSeenCode(next.pairing.code);
    });
    if (active) {
      roomHub
        .status()
        .then((first) => {
          if (!cancelled) setStatus((current) => current ?? first);
        })
        .catch((reason: unknown) => setError(errorText(reason, 'Could not read the desktop rooms.')));
    }
    return () => {
      cancelled = true;
      off();
    };
  }, [roomHub, active]);

  // The code was used up on bija's side (the other PC paired): the status no longer lists it, and the code on screen goes too.
  const codeGone = pairing !== null && seenCode === pairing.code && status !== null && status.pairing === null;
  const left = pairing ? secondsLeft(pairing.expiresAt, now) : 0;
  const showCode = pairing !== null && !codeGone && left > 0;

  useEffect(() => {
    if (!showCode) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [showCode]);

  const run = useCallback(async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason, fallback));
    }
  }, []);

  const makeCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!roomHub || adding === null) return;
    const name = adding.trim() || DEFAULT_ROOM_NAME;
    await run(async () => {
      const started = await roomHub.startPairing(name);
      setNow(Date.now());
      setPairing(started);
      setAdding(null);
    }, 'Could not make a code.');
  };

  const cancel = async () => {
    setPairing(null);
    if (roomHub) await run(() => roomHub.cancelPairing(), 'Could not cancel.');
  };

  const saveName = async (place: Place) => {
    const wanted = names[place.id];
    setNames((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== place.id)));
    if (!roomHub || wanted === undefined || !wanted.trim() || wanted.trim() === place.name) return;
    await run(() => roomHub.rename(place.id, wanted), 'Could not rename.');
  };

  const places = snapshot?.places ?? [];
  const deviceOf = (place: Place) => status?.devices.find((device) => device.placeId === place.id) ?? null;

  return (
    <div className="placesPanel">
      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}

      <section aria-labelledby="places-list-title" className="toolsSettings__section">
        <h3 id="places-list-title">Places</h3>
        {places.length === 0 ? <p className="kiosk__helper">Places are not available yet.</p> : null}
        <ul className="placesPanel__list">
          {places.map((place) => {
            const device = deviceOf(place);
            const here = Object.entries(snapshot?.locations ?? {})
              .filter(([, placeId]) => placeId === place.id)
              .map(([avatarId]) => nameOf(avatarId));
            const online = place.online ?? true;
            return (
              <li key={place.id} className="placesPanel__place" aria-label={place.name}>
                <div className="placesPanel__header">
                  <span className="placesPanel__dot" data-online={online ? 'true' : 'false'} role="img" aria-label={online ? 'Online' : 'Offline'} />
                  <input
                    aria-label={`Name of ${place.name}`}
                    value={names[place.id] ?? place.name}
                    maxLength={80}
                    disabled={!roomHub}
                    onChange={(event) => setNames((current) => ({ ...current, [place.id]: event.target.value }))}
                    onBlur={() => void saveName(place)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                  <span className="kiosk__helper">{kindOf(place)}</span>
                </div>
                <p className="kiosk__helper">{here.length > 0 ? `Here: ${here.join(', ')}` : 'Nobody is here.'}</p>
                {place.node !== 'local' && place.node !== 'offscreen' ? (
                  <label className="placesPanel__room">
                    <span className="kiosk__helper">Room shown there</span>
                    <select
                      aria-label={`Room shown in ${place.name}`}
                      value={place.room ?? ''}
                      disabled={!roomHub?.setRoom}
                      onChange={(event) => void run(() => roomHub?.setRoom?.(place.id, event.target.value) ?? Promise.resolve(), 'Could not change the room.')}
                    >
                      {place.room && !roomChoices.some((choice) => choice.id === place.room) ? <option value={place.room}>{place.room}</option> : null}
                      {roomChoices.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.name} ({choice.kind})
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {place.node !== 'local' && place.node !== 'offscreen' ? (
                  <div className="placesPanel__device">
                    <span className="kiosk__helper">
                      {device
                        ? `${device.name} · ${device.online ? 'connected' : `last seen ${new Date(device.lastSeen).toLocaleString()}`}`
                        : 'This desktop room is not paired any more.'}
                    </span>
                    {device?.online ? (
                      <span className="kiosk__helper" data-testid={`devices-${place.id}`}>
                        {deviceSummary(device.deviceState)}
                      </span>
                    ) : null}
                    {device ? (
                      <button type="button" onClick={() => void run(() => roomHub?.revoke(device.id) ?? Promise.resolve(), 'Could not revoke.')} aria-label={`Revoke ${place.name}`}>
                        Revoke
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="places-add-title" className="toolsSettings__section">
        <h3 id="places-add-title">Add a desktop room</h3>
        {!roomHub ? (
          <p className="kiosk__helper">Desktop rooms need a newer app build.</p>
        ) : showCode && pairing ? (
          <div className="placesPanel__pairing" data-testid="pairing-code">
            <p className="kiosk__helper">On the other PC, start the app as a satellite (AIEMBODIED_ROLE=satellite) and enter this code and one of these addresses.</p>
            <strong className="placesPanel__code" aria-label="Pairing code">
              {pairing.code}
            </strong>
            <span className="kiosk__helper" aria-live="off">
              Valid for {clock(left)}, one use.
            </span>
            {pairing.urls.length > 0 ? (
              <ul className="placesPanel__urls">
                {pairing.urls.map((url) => (
                  <li key={url}>
                    <code>{url}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kiosk__helper">No Tailscale address was found on this PC. Start Tailscale on both PCs, then make a new code.</p>
            )}
            <button type="button" onClick={() => void cancel()}>
              Cancel
            </button>
          </div>
        ) : adding !== null ? (
          <form className="toolsSettings__add" onSubmit={(event) => void makeCode(event)}>
            <label>
              Name of the room
              <input value={adding} onChange={(event) => setAdding(event.target.value)} placeholder={DEFAULT_ROOM_NAME} maxLength={80} />
            </label>
            <div className="toolsSettings__actions">
              <button type="submit">Make a code</button>
              <button type="button" onClick={() => setAdding(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            {pairing ? <p className="kiosk__helper">{codeGone ? 'The other PC is paired.' : 'That code has expired.'}</p> : null}
            <button
              type="button"
              onClick={() => {
                setPairing(null);
                setAdding(DEFAULT_ROOM_NAME);
              }}
            >
              Add a desktop room
            </button>
          </>
        )}
      </section>
    </div>
  );
}
