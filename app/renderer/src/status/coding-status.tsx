/** One line in Status and diagnostics: is the coding runner up, and what the model swap is doing. */
import { useEffect, useState } from 'react';
import type { CodingBridge, CodingStatus } from '../../../main/src/coding/bridge-types.js';

export const CODING_POLL_MS = 5000;

export function describeCoding(status: CodingStatus | null): string {
  if (!status) return 'Checking…';
  return `${status.runnerUp ? 'Runner up' : 'Runner down'}. ${status.swap.message}`;
}

export function CodingStatusLine({ api, active }: { api?: CodingBridge; active: boolean }) {
  const [status, setStatus] = useState<CodingStatus | null>(null);
  useEffect(() => {
    if (!api || !active) return undefined;
    let cancelled = false;
    const read = () => {
      void Promise.resolve()
        .then(() => api.status())
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, CODING_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, active]);
  if (!api) return null;
  return (
    <p className="kiosk__helper" data-testid="coding-status">
      <b>Coding</b>: {describeCoding(status)}
    </p>
  );
}
