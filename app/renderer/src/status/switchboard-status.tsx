/** Switchboard in Status and diagnostics: is it connected, and which transactions are open. */
import { useEffect, useState } from 'react';
import type { SwitchboardBridge, SwitchboardDecision, SwitchboardOpenTxn, SwitchboardStatus } from '../../../main/src/switchboard/bridge-types.js';

export const SWITCHBOARD_POLL_MS = 5000;
const MAX_SHOWN = 10;
const MAX_DECISIONS = 10;

export function describeSwitchboard(status: SwitchboardStatus | null): { dot: 'connected' | 'down' | 'off' | 'checking'; label: string } {
  if (!status) return { dot: 'checking', label: 'Checking…' };
  if (!status.enabled) return { dot: 'off', label: 'Off' };
  return status.connected ? { dot: 'connected', label: 'Connected' } : { dot: 'down', label: 'Down (working locally)' };
}

export function formatAge(updatedAt: string | null, now: number): string {
  const then = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

const MAX_REASON = 60;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeDecision(decision: SwitchboardDecision, now: number): string {
  const age = formatAge(decision.at, now);
  const reason = clip(decision.reason, MAX_REASON);
  return `${decision.avatarName}: ${decision.action} ${decision.type}${reason ? ` (${reason})` : ''}${age ? `, ${age} ago` : ''}`;
}

const DOT_COLOUR = { connected: '#34d399', down: '#f87171', off: '#64748b', checking: '#fbbf24' };

export function SwitchboardView({ status, now }: { status: SwitchboardStatus | null; now: number }) {
  const { dot, label } = describeSwitchboard(status);
  const txns: SwitchboardOpenTxn[] = status?.openTxns ?? [];
  const decisions: SwitchboardDecision[] = status?.decisions ?? [];
  return (
    <div data-testid="switchboard-status">
      <p className="kiosk__helper">
        <span data-testid="switchboard-dot" data-state={dot} aria-hidden style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: DOT_COLOUR[dot], marginRight: 6 }} />
        <b>Switchboard</b>: {label}
      </p>
      {txns.length > 0 ? (
        <ul className="kiosk__helper" data-testid="switchboard-txns">
          {txns.slice(0, MAX_SHOWN).map((txn) => (
            <li key={txn.id}>
              {txn.title || txn.id} ({txn.state}
              {formatAge(txn.updated_at, now) ? `, ${formatAge(txn.updated_at, now)}` : ''})
            </li>
          ))}
          {txns.length > MAX_SHOWN ? <li>…and {txns.length - MAX_SHOWN} more</li> : null}
        </ul>
      ) : null}
      {decisions.length > 0 ? (
        <>
          <p className="kiosk__helper">
            <b>Recent decisions</b>
          </p>
          <ul className="kiosk__helper" data-testid="switchboard-decisions">
            {decisions.slice(0, MAX_DECISIONS).map((decision) => (
              <li key={`${decision.event}:${decision.avatarId}:${decision.at}`}>{describeDecision(decision, now)}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function SwitchboardStatusLine({ api, active }: { api?: SwitchboardBridge; active: boolean }) {
  const [status, setStatus] = useState<SwitchboardStatus | null>(null);
  const [readAt, setReadAt] = useState(0);
  useEffect(() => {
    if (!api || !active) return undefined;
    let cancelled = false;
    const read = () => {
      void Promise.resolve()
        .then(() => api.status())
        .then((next) => {
          if (cancelled) return;
          setStatus(next);
          setReadAt(Date.now());
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, SWITCHBOARD_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, active]);
  if (!api) return null;
  return <SwitchboardView status={status} now={readAt} />;
}
