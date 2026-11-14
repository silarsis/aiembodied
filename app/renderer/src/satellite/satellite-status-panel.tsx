import { useState } from 'react';
import type { DeviceGateBridge, DeviceGateState, SatelliteBridge, SatelliteStatus, TurnTiming } from '../../../main/src/satellite/bridge-types.js';
import type { AudioDeviceSelection } from '../hooks/use-audio-devices.js';

const LINK_WORDS: Record<SatelliteStatus['link'], string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  online: 'Online',
  offline: 'Lost touch with bija. Trying again…',
  refused: 'Refused by bija',
};

/** The satellite's Status page: the link, which room this is, which bija, the devices, and "Forget this pairing". */
export interface SatelliteStatusPanelProps {
  status: SatelliteStatus;
  bridge: SatelliteBridge;
  gate?: DeviceGateState | null;
  gateBridge?: DeviceGateBridge;
  outputs?: AudioDeviceSelection[];
  selectedOutput?: string;
  onOutputChange?: (deviceId: string) => void;
  lastTurn?: TurnTiming | null;
}

const LEVEL_WORDS = { live: 'live', doorbell: 'doorbell only', off: 'off' } as const;
const seconds = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);

export function SatelliteStatusPanel({ status, bridge, gate = null, gateBridge, outputs = [], selectedOutput = '', onOutputChange, lastTurn = null }: SatelliteStatusPanelProps) {
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
          <dt>Microphone</dt>
          <dd data-testid="satellite-mic">
            {gate ? `${LEVEL_WORDS[gate.mic][0].toUpperCase()}${LEVEL_WORDS[gate.mic].slice(1)}${gate.mic === 'off' && gate.summary ? `: ${gate.summary}` : ''}` : 'Off'}
          </dd>
        </div>
        <div>
          <dt>Camera</dt>
          <dd>Off</dd>
        </div>
        <div>
          <dt>Speakers</dt>
          <dd>
            <label htmlFor="satellite-speakers" className="srOnly">
              Speakers
            </label>
            <select id="satellite-speakers" value={selectedOutput} onChange={(event) => onOutputChange?.(event.target.value)} disabled={!onOutputChange}>
              <option value="">System default</option>
              {outputs.map((output) => (
                <option key={output.deviceId} value={output.deviceId}>
                  {output.label}
                </option>
              ))}
            </select>
          </dd>
        </div>
        <div>
          <dt>Last turn</dt>
          <dd data-testid="satellite-last-turn">
            {lastTurn
              ? `Transcript ${seconds(lastTurn.transcriptMs)} · audio arrived ${seconds(lastTurn.firstAudioMs)} · playing ${seconds(lastTurn.playbackMs)} after you stopped speaking`
              : 'No turn yet'}
          </dd>
        </div>
      </dl>
      {status.lastError ? (
        <p className="kiosk__helper" role="alert">
          {status.lastError}
        </p>
      ) : null}
      {gateBridge ? (
        <button type="button" className="btn btn--secondary" data-testid="satellite-kill-switch" onClick={() => void gateBridge.setOpen(gate?.open === false)}>
          {gate?.open === false ? 'Open this room' : 'Close this room'}
        </button>
      ) : null}
      <p className="kiosk__helper">The microphone is live only while a character is in this room, the screen is unlocked, the link to bija is up, the room is open and no other app is full screen. Ctrl+Alt+Shift+R closes or opens the room from anywhere.</p>
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
